/**
 * The shares router (id-based share links): the server-side twin of the
 * URL-fragment share. A signed-in user uploads one native document and
 * gets back a short public id — `/viewer?p=<id>` — a link that survives
 * media which truncate long URLs. Reads are public (the viewer route is
 * public and framable); creation is authenticated, because an anonymous
 * write endpoint is an open database.
 *
 * Two invariants, both inherited from the documents router's discipline:
 *
 * - **Only valid native documents enter the store.** `create` parses the
 *   payload with the native format's own parser (the full replay over
 *   the base and the state/log agreement check), so a `get` later hands
 *   back exactly what the format's machinery accepts. The payload's
 *   size is capped by the same `NATIVE_CONTENT_MAX_LENGTH` the save
 *   path applies.
 * - **An id leak is not a document leak.** `get` distinguishes nothing:
 *   a well-formed id that no row matches is NOT_FOUND, the same answer
 *   for every missing id, and the row carries no creator-facing data —
 *   the content is the share.
 * - **The store is bounded per user.** Creation is authenticated but
 *   still unbounded without a ceiling: one signed-in writer could grow
 *   `share_link` monotonically (each row up to
 *   `NATIVE_CONTENT_MAX_LENGTH`). `create` refuses past
 *   `MAX_SHARES_PER_USER` live rows per user — a deliberate bound, not
 *   an afterthought; raising it or adding an expiry/purge is a decision
 *   to make in the open if it ever bites.
 *
 * The ids are 10 base62 characters from the platform CSPRNG with
 * rejection sampling (256 mod 62 ≠ 0, so the tail of the byte range is
 * discarded and every character is uniform) — 62¹⁰ ≈ 8×10¹⁷ ids. A
 * collision is handled by insert-first: the insert races nothing, a
 * UNIQUE-constraint hit is a retry, and anything else is a real error.
 */

import { randomBytes } from "node:crypto";
import { parseNativeCadDocumentFromString } from "@slopcad/cad-core";
import { type SlopcadDatabase } from "@slopcad/db";
import { shareLink as shareLinkTable } from "@slopcad/db/schema/shares";
import { TRPCError } from "@trpc/server";
import { count, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, publicProcedure } from "../index";
import { NATIVE_CONTENT_MAX_LENGTH } from "../limits";

/** The share id alphabet (base62: URL-query safe, no escaping anywhere). */
const SHARE_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" as const;

/** The share id length: 10 characters, 62¹⁰ ≈ 8.4×10¹⁷ possibilities. */
const SHARE_ID_LENGTH = 10;

/** The largest byte value the unbiased mapping accepts (62 × 4 = 248). */
const SHARE_ID_BYTE_CEILING = 248;

/** The most live shares one user may hold (the store's growth bound). */
const MAX_SHARES_PER_USER = 200;

/** The wire shape of a share id (also the `get` input's guard). */
const shareIdSchema = z
  .string()
  .regex(
    new RegExp(`^[0-9A-Za-z]{${String(SHARE_ID_LENGTH)}}$`),
    `A share id is exactly ${String(SHARE_ID_LENGTH)} base62 characters`,
  );

/** One fresh share id: rejection-sampled base62 from the CSPRNG. */
function newShareId(): string {
  let id = "";
  while (id.length < SHARE_ID_LENGTH) {
    const bytes = randomBytes(SHARE_ID_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= SHARE_ID_BYTE_CEILING) continue;
      id += SHARE_ID_ALPHABET.charAt(byte % 62);
      if (id.length === SHARE_ID_LENGTH) break;
    }
  }
  return id;
}

/** How many collision retries one create attempt gets before refusing. */
const SHARE_ID_ATTEMPTS = 3;

/**
 * Whether `error` is the id PK's unique-constraint hit (a retry). Drizzle
 * wraps engine errors ("Failed query: …"), so the sqlite message is
 * matched through the cause chain, not just the wrapper's text.
 */
function isShareIdCollision(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (current.message.includes("UNIQUE constraint failed: share_link.id")) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** The router's injectable dependencies (the overrides are for tests). */
export interface SharesRouterDeps {
  readonly db: SlopcadDatabase;
  /** The per-user live-share ceiling (the default is the product bound). */
  readonly maxSharesPerUser?: number;
  /** The id factory (the default is the CSPRNG one; tests force collisions). */
  readonly newId?: () => string;
}

export function createSharesRouter(deps: SharesRouterDeps) {
  const {
    db,
    maxSharesPerUser = MAX_SHARES_PER_USER,
    newId = newShareId,
  } = deps;
  return {
    /**
     * Uploads one native document behind a fresh short id. The caller is
     * recorded as the creator (severed, not cascaded, if the account is
     * deleted — the link outlives its author the way a fragment link
     * would) and may hold at most `maxSharesPerUser` live shares.
     */
    create: protectedProcedure
      .input(
        z.object({
          nativeContent: z.string().min(1).max(NATIVE_CONTENT_MAX_LENGTH),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const parsed = parseNativeCadDocumentFromString(input.nativeContent);
        if (!parsed.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `The payload is not a valid native slopcad document: ${parsed.error.message}`,
            cause: parsed.error.code,
          });
        }
        const held = await db
          .select({ value: count() })
          .from(shareLinkTable)
          .where(eq(shareLinkTable.createdBy, ctx.session.user.id));
        if ((held[0]?.value ?? 0) >= maxSharesPerUser) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Share cap reached: at most ${String(maxSharesPerUser)} live shares per user.`,
          });
        }
        for (let attempt = 0; attempt < SHARE_ID_ATTEMPTS; attempt += 1) {
          const id = newId();
          try {
            await db.insert(shareLinkTable).values({
              id,
              createdBy: ctx.session.user.id,
              nativeContent: input.nativeContent,
            });
            return { id };
          } catch (error) {
            // Only the id PK collision is a retry; anything else is real.
            if (!isShareIdCollision(error)) throw error;
          }
        }
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Could not allocate an unused share id; please retry the share",
        });
      }),

    /**
     * Reads one share's native document by its public id. The answer for
     * a missing id is the same NOT_FOUND regardless of who asks.
     */
    get: publicProcedure
      .input(z.object({ id: shareIdSchema }))
      .query(async ({ input }) => {
        const found = await db
          .select()
          .from(shareLinkTable)
          .where(eq(shareLinkTable.id, input.id))
          .limit(1);
        const row = found[0];
        if (row === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Share not found",
          });
        }
        return {
          id: row.id,
          nativeContent: row.nativeContent,
          createdAt: row.createdAt.toISOString(),
        };
      }),
  };
}
