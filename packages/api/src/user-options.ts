/**
 * Read-only typed access to the generic per-user key/value store (D13,
 * PLAN-AGENT-CHAT.md §1.4): the `user_options` rows every per-user toggle
 * rides. The write path is deliberately deferred (how rows get created —
 * admin UI, entitlements — is undecided), so this module exposes reads
 * only; the server-AI gate is decided here and nowhere else, so the tRPC
 * surface and the server relay (Phase 1.5) cannot drift apart.
 */

import { type SlopcadDatabase } from "@slopcad/db";
import { userOptions } from "@slopcad/db/schema/user-options";
import { and, eq } from "drizzle-orm";

/** The user_options row name that gates server-emitted AI (D13). */
export const SERVER_AI_OPTION_NAME = "agent.server-ai";

/** The exact value that flips the gate on. */
export const SERVER_AI_OPTION_ENABLED_VALUE = "true";

/** Reads one user option's value; `undefined` when the user has no such row. */
export async function readUserOption(
  db: SlopcadDatabase,
  userId: string,
  name: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ value: userOptions.value })
    .from(userOptions)
    .where(and(eq(userOptions.userId, userId), eq(userOptions.name, name)))
    .limit(1);
  return rows[0]?.value;
}

/**
 * The D13 access resolution: the instance allow-all env posture
 * (`AGENT_SERVER_AI_ALLOW_ALL`) grants every authenticated user; otherwise
 * the caller's OWN `agent.server-ai` row must carry exactly `"true"`.
 * Another user's row, another option name, or any other value denies.
 */
export async function isServerAiAllowed(
  db: SlopcadDatabase,
  userId: string,
  allowAll: boolean,
): Promise<boolean> {
  if (allowAll) {
    return true;
  }
  return (
    (await readUserOption(db, userId, SERVER_AI_OPTION_NAME)) ===
    SERVER_AI_OPTION_ENABLED_VALUE
  );
}
