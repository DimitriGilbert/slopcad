/**
 * The simulations router (Phase 61c, law S7): the server half of the
 * `SimResultStore` — simulation runs persist keyed to `document_version`
 * with their compact SMR1 binary payload stored verbatim as a blob, never
 * inside JSON, and never inside the document. `@slopcad/sim-core`'s store
 * backends speak this router through the injected `SimResultServerClient`
 * seam; the wire shapes here ARE the sim-core contract types, so the two
 * packages share one source of truth (DTO type aliases, not restatements).
 *
 * Two invariants the router enforces on every procedure, the
 * projects/documents convention:
 *
 * - **Ownership first.** A run is reachable only through its document
 *   version → document → project's `ownerId === ctx.session.user.id`;
 *   anything else is NOT_FOUND (existence is not leaked across users).
 * - **Only model-valid runs enter the store.** `put` parses the summary and
 *   histories with sim-core's own parsers, strictly decodes the payload's
 *   base64, and runs the full SMR1 decoder over the bytes before anything
 *   is stored — a payload that fails the format's machinery is refused
 *   with BAD_REQUEST, so what a get later reads always re-parses. The
 *   payload's size is capped at the input boundary (see `../limits`) before
 *   the decoder is ever reached.
 *
 * Derived columns stay derived: the row's `status` and
 * `scenario_snapshot_hash` are written from the parsed summary (single
 * source of truth), and every read re-verifies the agreement through the
 * shared record parser.
 */

import { randomUUID } from "node:crypto";
import { type SlopcadDatabase } from "@slopcad/db";
import {
  document as documentTable,
  documentVersion as documentVersionTable,
  project as projectTable,
} from "@slopcad/db/schema/projects";
import { simulationRun as simulationRunTable } from "@slopcad/db/schema/simulation";
import {
  decodeSimBase64Strict,
  decodeSimResultPayload,
  encodeSimBase64,
  parseSimHistorySeriesList,
  parseSimResultRunRecord,
  parseSimResultSummary,
  type SimHistorySeries,
  type SimResultPutWireInput,
  type SimResultRunRecord,
  type SimResultRunWire,
} from "@slopcad/sim-core";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { SIM_RESULT_PAYLOAD_MAX_BASE64_LENGTH } from "../limits";

/**
 * The wire form of one persisted run: identity, provenance (version +
 * scenario-snapshot hash), status, the parsed summary, and timestamps —
 * the payload is excluded (that is a `get`). This is sim-core's record
 * type by alias: the store contract and the router share one shape.
 */
export type SimulationRunDto = SimResultRunRecord;

/** The full wire form `get` returns: the run plus its payload and histories. */
export type SimulationRunFullDto = SimResultRunWire;

/** The `put` input's typed form (what a store backend sends). */
export type SimulationPutInput = SimResultPutWireInput;

/** Parses a row's JSON text column, refusing corruption loudly. */
function rowJson(text: string, what: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `A stored simulation run's ${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      cause: "sim/result-record-malformed",
    });
  }
}

export function toSimulationRunDto(
  row: typeof simulationRunTable.$inferSelect,
): SimulationRunDto {
  // The full record parser re-verifies everything at once — the summary's
  // shape AND the derived columns' agreement with it (the integrity pin
  // the insert path guarantees; a corrupt row surfaces as INTERNAL, never
  // as a half-guessed run).
  const parsed = parseSimResultRunRecord({
    id: row.id,
    documentVersionId: row.documentVersionId,
    scenarioSnapshotHash: row.scenarioSnapshotHash,
    status: row.status,
    summary: rowJson(row.summary, "summary"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `A stored simulation run did not re-parse against the result model: ${parsed.error.message}`,
      cause: parsed.error.code,
    });
  }
  return parsed.value;
}

/** Parses a row's histories JSON, refusing corruption loudly. */
function toSimulationHistories(
  row: typeof simulationRunTable.$inferSelect,
): readonly SimHistorySeries[] {
  const parsed = parseSimHistorySeriesList(rowJson(row.histories, "histories"));
  if (!parsed.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `A stored simulation run's histories did not re-parse: ${parsed.error.message}`,
      cause: parsed.error.code,
    });
  }
  return parsed.value;
}

/**
 * Resolves the OWNED document version row for the session user
 * (version → document → project → owner), refusing with NOT_FOUND when any
 * hop fails. Every simulations procedure funnels through here, so ownership
 * scoping has exactly one implementation.
 */
async function requireOwnedDocumentVersion(
  db: SlopcadDatabase,
  documentVersionId: string,
  userId: string,
): Promise<void> {
  const found = await db
    .select({ id: documentVersionTable.id })
    .from(documentVersionTable)
    .innerJoin(
      documentTable,
      eq(documentVersionTable.documentId, documentTable.id),
    )
    .innerJoin(projectTable, eq(documentTable.projectId, projectTable.id))
    .where(
      and(
        eq(documentVersionTable.id, documentVersionId),
        eq(projectTable.ownerId, userId),
      ),
    )
    .limit(1);
  if (found[0] === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Document version not found",
    });
  }
}

export function createSimulationsRouter(deps: {
  readonly db: SlopcadDatabase;
}) {
  const { db } = deps;
  return {
    list: protectedProcedure
      .input(z.object({ documentVersionId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        await requireOwnedDocumentVersion(
          db,
          input.documentVersionId,
          ctx.session.user.id,
        );
        const rows = await db
          .select()
          .from(simulationRunTable)
          .where(
            eq(simulationRunTable.documentVersionId, input.documentVersionId),
          )
          .orderBy(
            asc(simulationRunTable.createdAt),
            asc(simulationRunTable.id),
          );
        return rows.map(toSimulationRunDto) satisfies SimulationRunDto[];
      }),
    get: protectedProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const found = await db
          .select({ run: simulationRunTable })
          .from(simulationRunTable)
          .innerJoin(
            documentVersionTable,
            eq(simulationRunTable.documentVersionId, documentVersionTable.id),
          )
          .innerJoin(
            documentTable,
            eq(documentVersionTable.documentId, documentTable.id),
          )
          .innerJoin(projectTable, eq(documentTable.projectId, projectTable.id))
          .where(
            and(
              eq(simulationRunTable.id, input.runId),
              eq(projectTable.ownerId, ctx.session.user.id),
            ),
          )
          .limit(1);
        const row = found[0]?.run;
        if (row === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Simulation run not found",
          });
        }
        return {
          ...toSimulationRunDto(row),
          payloadBase64: encodeSimBase64(row.payload),
          histories: toSimulationHistories(row),
        } satisfies SimulationRunFullDto;
      }),
    put: protectedProcedure
      .input(
        z.object({
          documentVersionId: z.string().min(1),
          // Capped BEFORE the mutation runs: the strict base64 decode and
          // the full SMR1 decode below must never be an unbounded-cost
          // oracle over attacker-chosen lengths.
          payloadBase64: z
            .string()
            .min(12)
            .max(SIM_RESULT_PAYLOAD_MAX_BASE64_LENGTH),
          summary: z.unknown(),
          histories: z.unknown(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwnedDocumentVersion(
          db,
          input.documentVersionId,
          ctx.session.user.id,
        );
        const summary = parseSimResultSummary(input.summary);
        if (!summary.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `The run's summary is not a valid result summary: ${summary.error.message}`,
            cause: summary.error.code,
          });
        }
        const bytes = decodeSimBase64Strict(input.payloadBase64);
        if (bytes === null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "The run's payload must be canonical base64 text.",
            cause: "sim/result-payload-malformed",
          });
        }
        const fields = decodeSimResultPayload(bytes);
        if (!fields.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `The run's payload did not decode as an SMR1 result payload: ${fields.error.message}`,
            cause: fields.error.code,
          });
        }
        const histories = parseSimHistorySeriesList(input.histories);
        if (!histories.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `The run's histories are not valid history series: ${histories.error.message}`,
            cause: histories.error.code,
          });
        }
        const inserted = await db
          .insert(simulationRunTable)
          .values({
            id: randomUUID(),
            documentVersionId: input.documentVersionId,
            scenarioSnapshotHash: summary.value.scenarioSnapshotHash,
            status: summary.value.status,
            summary: JSON.stringify(summary.value),
            histories: JSON.stringify(histories.value),
            payload: Buffer.from(bytes),
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The simulation run insert returned no row.",
          });
        }
        return toSimulationRunDto(row);
      }),
  };
}
