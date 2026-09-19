/**
 * The documents router (Phase 31): CAD documents live inside owned
 * projects and every save appends one immutable `document_version` row
 * whose `nativeContent` is the serialized NATIVE `slopcad` document —
 * the format's own canonical JSON (dual-persisted history: the state at
 * the cursor plus the transaction log), never a kernel object.
 *
 * Two invariants the router enforces on every write:
 *
 * - **Ownership first.** A document is reachable only through its
 *   project's `ownerId === ctx.session.user.id`; anything else is
 *   NOT_FOUND (existence is not leaked across users).
 * - **Only valid native documents enter the store.** `save` parses the
 *   payload with the native format's own parser (which replays the
 *   transaction log over the base and checks it against the persisted
 *   state) — a payload that fails the format's machinery is refused with
 *   BAD_REQUEST, so what a load later reads is always a document the
 *   format accepts.
 */

import { randomUUID } from "node:crypto";
import {
  parseNativeCadDocumentFromString,
  type NativeCadDocumentParseError,
} from "@slopcad/cad-core";
import { type SlopcadDatabase } from "@slopcad/db";
import {
  document as documentTable,
  documentVersion as documentVersionTable,
  project as projectTable,
} from "@slopcad/db/schema/projects";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { DOCUMENT_NAME_MAX_LENGTH } from "../limits";

/** The wire form of a document row (no content — that is a version read). */
export interface DocumentDto {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A document row plus its save-history summary. */
export interface DocumentSummaryDto extends DocumentDto {
  readonly versionCount: number;
  readonly latestVersion: number;
}

/** One persisted save: the ordinal and when it landed (content excluded). */
export interface DocumentVersionSummaryDto {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
}

/** The latest (or a picked) version's loadable payload. */
export interface DocumentContentDto {
  readonly documentId: string;
  readonly version: number;
  readonly nativeContent: string;
  readonly createdAt: string;
}

/** The outcome of one save: the version the content landed as. */
export interface SaveResultDto {
  readonly documentId: string;
  readonly version: number;
  readonly createdAt: string;
}

export function toDocumentDto(
  row: typeof documentTable.$inferSelect,
): DocumentDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const documentIdInput = z.object({ documentId: z.string().min(1) });

/**
 * Resolves the OWNED document row for the session user (document →
 * project → owner), refusing with NOT_FOUND when any hop fails. Every
 * document procedure funnels through here, so ownership scoping has
 * exactly one implementation.
 */
async function requireOwnedDocument(
  db: SlopcadDatabase,
  documentId: string,
  userId: string,
): Promise<typeof documentTable.$inferSelect> {
  const found = await db
    .select({ document: documentTable })
    .from(documentTable)
    .innerJoin(projectTable, eq(documentTable.projectId, projectTable.id))
    .where(
      and(eq(documentTable.id, documentId), eq(projectTable.ownerId, userId)),
    )
    .limit(1);
  const row = found[0]?.document;
  if (row === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Document not found",
    });
  }
  return row;
}

/**
 * Refuses a payload the native format's own machinery rejects. The full
 * parse replays the transaction log over the base document and checks the
 * state at the cursor against it — the same check a load will run.
 */
function requireNativeDocument(nativeContent: string): void {
  const parsed = parseNativeCadDocumentFromString(nativeContent);
  if (!parsed.ok) {
    const error: NativeCadDocumentParseError = parsed.error;
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The payload is not a valid native slopcad document: ${error.message}`,
      cause: error.code,
    });
  }
}

export function createDocumentsRouter(deps: { readonly db: SlopcadDatabase }) {
  const { db } = deps;
  return {
    create: protectedProcedure
      .input(
        z.object({
          projectId: z.string().min(1),
          name: z.string().trim().min(1).max(DOCUMENT_NAME_MAX_LENGTH),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const owned = await db
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(
            and(
              eq(projectTable.id, input.projectId),
              eq(projectTable.ownerId, ctx.session.user.id),
            ),
          )
          .limit(1);
        if (owned[0] === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Project not found",
          });
        }
        const inserted = await db
          .insert(documentTable)
          .values({
            id: randomUUID(),
            projectId: input.projectId,
            name: input.name,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The document insert returned no row.",
          });
        }
        return toDocumentDto(row);
      }),
    list: protectedProcedure
      .input(z.object({ projectId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const owned = await db
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(
            and(
              eq(projectTable.id, input.projectId),
              eq(projectTable.ownerId, ctx.session.user.id),
            ),
          )
          .limit(1);
        if (owned[0] === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Project not found",
          });
        }
        const rows = await db
          .select()
          .from(documentTable)
          .where(eq(documentTable.projectId, input.projectId))
          .orderBy(desc(documentTable.updatedAt));
        const versions = await db
          .select({
            documentId: documentVersionTable.documentId,
            saves: count(),
          })
          .from(documentVersionTable)
          .innerJoin(
            documentTable,
            eq(documentVersionTable.documentId, documentTable.id),
          )
          .where(eq(documentTable.projectId, input.projectId))
          .groupBy(documentVersionTable.documentId);
        const counts = new Map(
          versions.map((row) => [row.documentId, row.saves]),
        );
        const summaries: DocumentSummaryDto[] = rows.map((row) => {
          const versionCount = counts.get(row.id) ?? 0;
          return {
            ...toDocumentDto(row),
            versionCount,
            latestVersion: versionCount,
          };
        });
        return summaries;
      }),
    get: protectedProcedure
      .input(documentIdInput)
      .query(async ({ ctx, input }) => {
        const row = await requireOwnedDocument(
          db,
          input.documentId,
          ctx.session.user.id,
        );
        const latest = await db
          .select()
          .from(documentVersionTable)
          .where(eq(documentVersionTable.documentId, row.id))
          .orderBy(desc(documentVersionTable.version))
          .limit(1);
        const versionRow = latest[0];
        return {
          document: toDocumentDto(row),
          latest:
            versionRow === undefined
              ? null
              : {
                  documentId: row.id,
                  version: versionRow.version,
                  nativeContent: versionRow.nativeContent,
                  createdAt: versionRow.createdAt.toISOString(),
                },
        };
      }),
    save: protectedProcedure
      .input(
        z.object({
          documentId: z.string().min(1),
          nativeContent: z.string().min(1),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const row = await requireOwnedDocument(
          db,
          input.documentId,
          ctx.session.user.id,
        );
        requireNativeDocument(input.nativeContent);
        const saved = await db.transaction(async (tx) => {
          const maxRows = await tx
            .select({ version: documentVersionTable.version })
            .from(documentVersionTable)
            .where(eq(documentVersionTable.documentId, row.id))
            .orderBy(desc(documentVersionTable.version))
            .limit(1);
          const nextVersion = (maxRows[0]?.version ?? 0) + 1;
          const inserted = await tx
            .insert(documentVersionTable)
            .values({
              id: randomUUID(),
              documentId: row.id,
              version: nextVersion,
              nativeContent: input.nativeContent,
            })
            .returning();
          await tx
            .update(documentTable)
            .set({ updatedAt: new Date() })
            .where(eq(documentTable.id, row.id));
          return inserted[0];
        });
        if (saved === undefined) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The version insert returned no row.",
          });
        }
        return {
          documentId: row.id,
          version: saved.version,
          createdAt: saved.createdAt.toISOString(),
        } satisfies SaveResultDto;
      }),
    listVersions: protectedProcedure
      .input(documentIdInput)
      .query(async ({ ctx, input }) => {
        const row = await requireOwnedDocument(
          db,
          input.documentId,
          ctx.session.user.id,
        );
        const versions = await db
          .select({
            id: documentVersionTable.id,
            version: documentVersionTable.version,
            createdAt: documentVersionTable.createdAt,
          })
          .from(documentVersionTable)
          .where(eq(documentVersionTable.documentId, row.id))
          .orderBy(asc(documentVersionTable.version));
        return versions.map((versionRow) => ({
          id: versionRow.id,
          version: versionRow.version,
          createdAt: versionRow.createdAt.toISOString(),
        })) satisfies DocumentVersionSummaryDto[];
      }),
    getVersion: protectedProcedure
      .input(
        z.object({
          documentId: z.string().min(1),
          version: z.number().int().min(1),
        }),
      )
      .query(async ({ ctx, input }) => {
        await requireOwnedDocument(db, input.documentId, ctx.session.user.id);
        const found = await db
          .select()
          .from(documentVersionTable)
          .where(
            and(
              eq(documentVersionTable.documentId, input.documentId),
              eq(documentVersionTable.version, input.version),
            ),
          )
          .limit(1);
        const versionRow = found[0];
        if (versionRow === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Document version not found",
          });
        }
        return {
          documentId: input.documentId,
          version: versionRow.version,
          nativeContent: versionRow.nativeContent,
          createdAt: versionRow.createdAt.toISOString(),
        } satisfies DocumentContentDto;
      }),
  };
}
