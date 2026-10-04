/**
 * The agent-conversations router + the serverProviders query (agent chat,
 * Phase 1.4 — PLAN-AGENT-CHAT.md §1.4, D2/D3/D13): the server-side
 * persistence for SERVER-EMITTED chat only. Client-emitted chat lives in
 * TanStack DB on WASM SQLite client-side and, when sync is opted in, pushes
 * its rows through `append` here (D3).
 *
 * Every procedure is a `protectedProcedure` scoped to the session user —
 * a conversation is reachable only through `userId === ctx.session.user.id`
 * (plus a project scope resolved through the project's owner), so another
 * user's conversation is structurally invisible: NOT_FOUND, never a leak
 * of existence through content — the projects/documents convention.
 *
 * `serverProviders` answers "can this caller use server mode, and for
 * which providers": the D13 access resolution (a `user_options` row
 * `agent.server-ai = "true"` OR the `AGENT_SERVER_AI_ALLOW_ALL` env
 * posture) plus the provider ids whose env keys are configured (D2). Key
 * VALUES never travel — ids and booleans only.
 */

import { randomUUID } from "node:crypto";
import { type SlopcadDatabase } from "@slopcad/db";
import {
  agentConversations as agentConversationsTable,
  agentMessages as agentMessagesTable,
} from "@slopcad/db/schema/agent";
import { project as projectTable } from "@slopcad/db/schema/projects";
import { env } from "@slopcad/env/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";
import {
  AGENT_CONVERSATION_TITLE_MAX_LENGTH,
  AGENT_MESSAGE_MAX_PARTS,
  AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH,
} from "../limits";
import { isServerAiAllowed } from "../user-options";
import { CATALOG_PROVIDERS } from "./model-catalog";

/**
 * The UIMessage roles TanStack AI's parts model defines
 * (docs/research/tanstack-ai.md — `role: 'system' | 'user' | 'assistant'`).
 */
const AGENT_MESSAGE_ROLES = ["system", "user", "assistant"] as const;

export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

/** The wire form of an `agent_conversations` row (timestamps as ISO). */
export interface AgentConversationDto {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The wire form of an `agent_messages` row. `parts` is deliberately
 * `unknown` — the database keeps it opaque JSON (D3) and the concrete
 * part shapes belong to the chat runtime (Phase 3).
 */
export interface AgentMessageDto {
  readonly id: string;
  readonly conversationId: string;
  readonly role: AgentMessageRole;
  readonly parts: unknown;
  readonly createdAt: string;
}

export function toAgentConversationDto(
  row: typeof agentConversationsTable.$inferSelect,
): AgentConversationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The `append` input schema, exported for direct tests of the minimal
 * shape contract (role enum + parts array, D3's opacity otherwise).
 */
export const agentAppendInput = z.object({
  conversationId: z.string().min(1),
  role: z.enum(AGENT_MESSAGE_ROLES),
  parts: z.array(z.unknown()).max(AGENT_MESSAGE_MAX_PARTS),
});

const conversationIdInput = z.object({ conversationId: z.string().min(1) });

/**
 * Resolves the OWNED conversation row for the session user, refusing with
 * NOT_FOUND when the id is unknown or belongs to someone else. Every
 * conversation procedure funnels through here, so user scoping has exactly
 * one implementation.
 */
async function requireOwnedConversation(
  db: SlopcadDatabase,
  conversationId: string,
  userId: string,
): Promise<typeof agentConversationsTable.$inferSelect> {
  const found = await db
    .select()
    .from(agentConversationsTable)
    .where(
      and(
        eq(agentConversationsTable.id, conversationId),
        eq(agentConversationsTable.userId, userId),
      ),
    )
    .limit(1);
  const row = found[0];
  if (row === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
  }
  return row;
}

/**
 * Bounds the stored row before any write happens: the parts' serialized
 * form is what lands verbatim in the `parts` column, so its length is the
 * honest cap (see `../limits`).
 */
function requireBoundedParts(parts: readonly unknown[]): void {
  if (
    JSON.stringify(parts).length > AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The message parts exceed the ${AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH}-character serialized limit.`,
    });
  }
}

export interface AgentConversationsRouterDeps {
  readonly db: SlopcadDatabase;
}

export function createAgentConversationsRouter(
  deps: AgentConversationsRouterDeps,
) {
  const { db } = deps;
  return {
    /** The caller's conversations, newest-updated first. */
    list: protectedProcedure.query(async ({ ctx }) => {
      const rows = await db
        .select()
        .from(agentConversationsTable)
        .where(eq(agentConversationsTable.userId, ctx.session.user.id))
        .orderBy(
          desc(agentConversationsTable.updatedAt),
          // Same-millisecond timestamps collide easily on fast inserts;
          // the id tiebreak keeps the order (and any future pagination)
          // deterministic.
          asc(agentConversationsTable.id),
        );
      return rows.map(toAgentConversationDto);
    }),

    /**
     * Starts a conversation, optionally scoped to a project the caller
     * owns (anything else is NOT_FOUND — no existence leak).
     */
    create: protectedProcedure
      .input(
        z.object({
          title: z
            .string()
            .trim()
            .min(1)
            .max(AGENT_CONVERSATION_TITLE_MAX_LENGTH),
          projectId: z.string().min(1).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.projectId !== undefined) {
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
        }
        const inserted = await db
          .insert(agentConversationsTable)
          .values({
            id: randomUUID(),
            userId: ctx.session.user.id,
            projectId: input.projectId ?? null,
            title: input.title,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The conversation insert returned no row.",
          });
        }
        return toAgentConversationDto(row);
      }),

    /**
     * Appends one message to an owned conversation — the opt-in sync
     * path's outbox target (D3). The parts are stored verbatim after the
     * minimal shape check (role enum + parts array) and the size bounds;
     * appending also stamps the conversation's `updatedAt`.
     */
    append: protectedProcedure
      .input(agentAppendInput)
      .mutation(async ({ ctx, input }) => {
        const conversation = await requireOwnedConversation(
          db,
          input.conversationId,
          ctx.session.user.id,
        );
        requireBoundedParts(input.parts);
        const inserted = await db.transaction(async (tx) => {
          const rows = await tx
            .insert(agentMessagesTable)
            .values({
              id: randomUUID(),
              conversationId: conversation.id,
              role: input.role,
              parts: input.parts,
            })
            .returning();
          await tx
            .update(agentConversationsTable)
            .set({ updatedAt: new Date() })
            .where(eq(agentConversationsTable.id, conversation.id));
          return rows[0];
        });
        if (inserted === undefined) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The message insert returned no row.",
          });
        }
        return {
          id: inserted.id,
          conversationId: conversation.id,
          role: input.role,
          parts: inserted.parts,
          createdAt: inserted.createdAt.toISOString(),
        } satisfies AgentMessageDto;
      }),

    /**
     * Deletes an owned conversation; its messages cascade via the foreign
     * key. Deleting someone else's (or a missing) id is NOT_FOUND.
     */
    delete: protectedProcedure
      .input(conversationIdInput)
      .mutation(async ({ ctx, input }) => {
        const conversation = await requireOwnedConversation(
          db,
          input.conversationId,
          ctx.session.user.id,
        );
        await db
          .delete(agentConversationsTable)
          .where(eq(agentConversationsTable.id, conversation.id));
      }),
  };
}

/** A provider id server mode can serve — the same ids the picker knows (D6). */
export type ServerAiProvider = (typeof CATALOG_PROVIDERS)[number];

/**
 * The env vars whose presence switches one provider's server mode on
 * (D2/D6). Structural subset of the validated server env, so the real env
 * satisfies it; only PRESENCE is ever read — never a value.
 */
export interface ServerProviderKeyEnv {
  readonly OPENROUTER_KEY?: string | undefined;
  readonly OPENAI_KEY?: string | undefined;
  readonly ANTHROPIC_KEY?: string | undefined;
  readonly GOOGLE_KEY?: string | undefined;
  readonly OPENAI_COMPATIBLE_KEY?: string | undefined;
}

/** Which provider env var belongs to which provider id (values never read). */
const SERVER_PROVIDER_ENV_KEYS = {
  openrouter: "OPENROUTER_KEY",
  openai: "OPENAI_KEY",
  anthropic: "ANTHROPIC_KEY",
  google: "GOOGLE_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_KEY",
} as const satisfies Record<ServerAiProvider, keyof ServerProviderKeyEnv>;

/**
 * Whether a provider env var counts as configured: an EMPTY string is
 * exactly as unconfigured as an unset one — the same rule the Phase 1.5
 * relay's credential resolution applies, so the picker never offers a
 * provider the relay would then refuse with 422.
 */
function isConfiguredEnvKey(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

/**
 * The provider ids with env keys configured, in the catalog's fixed order.
 * No fallback between providers (D6): absence simply omits the id.
 */
export function serverProviderIdsWithEnvKeys(
  keys: ServerProviderKeyEnv,
): ServerAiProvider[] {
  return CATALOG_PROVIDERS.filter((provider) =>
    isConfiguredEnvKey(keys[SERVER_PROVIDER_ENV_KEYS[provider]]),
  );
}

/** What drives the UI's availability of server mode (ids/booleans only). */
export interface ServerProvidersDto {
  readonly providers: ServerAiProvider[];
  readonly allowed: boolean;
}

export interface ServerProvidersDeps {
  readonly db: SlopcadDatabase;
  /** Provider env-key presence; production derives it from the server env. */
  readonly providerKeys?: ServerProviderKeyEnv;
  /** The instance allow-all posture (D13); production reads the env. */
  readonly allowAll?: boolean;
}

/**
 * The `serverProviders` query as a single-procedure factory: the D13
 * access resolution for the caller plus the env-keyed provider ids.
 */
export function createServerProvidersProcedure(deps: ServerProvidersDeps) {
  const { db } = deps;
  return protectedProcedure.query(async ({ ctx }) => {
    const providers = serverProviderIdsWithEnvKeys(deps.providerKeys ?? env);
    const allowed = await isServerAiAllowed(
      db,
      ctx.session.user.id,
      deps.allowAll ?? env.AGENT_SERVER_AI_ALLOW_ALL,
    );
    return { providers, allowed } satisfies ServerProvidersDto;
  });
}
