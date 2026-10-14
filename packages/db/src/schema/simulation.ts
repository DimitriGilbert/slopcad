import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
} from "drizzle-orm/sqlite-core";

import { documentVersion } from "./projects";

/**
 * Simulation run persistence (ROADMAP-SIM Phase 61c, law S7): every run
 * persists as one `simulation_run` row keyed to the `document_version` it
 * was computed against — the provenance pair a run carries is (version,
 * scenario-snapshot hash), the honest keying the Phase 63 comparison
 * surface groups on. The row keeps the database ignorant of physics: the
 * summary and histories are canonical JSON text, and the compact binary
 * field payload is stored verbatim as the SMR1 bytes `@slopcad/sim-core`
 * encodes (never decoded here, never inside JSON). The row's status and
 * hash columns are DERIVED from the summary at insert (single source of
 * truth) so the store can group and filter without parsing JSON.
 */
export const simulationRun = sqliteTable(
  "simulation_run",
  {
    id: text("id").primaryKey(),
    documentVersionId: text("document_version_id")
      .notNull()
      .references(() => documentVersion.id, { onDelete: "cascade" }),
    /** The scenario record's content hash at run time (the 61a provenance key). */
    scenarioSnapshotHash: text("scenario_snapshot_hash").notNull(),
    /** The run's terminal status (completed/failed/cancelled), from the summary. */
    status: text("status").notNull(),
    /** The canonical summary JSON (schema version, S9 regime, quantities). */
    summary: text("summary").notNull(),
    /** The canonical histories JSON (name/unit/sample series). */
    histories: text("histories").notNull(),
    /** The compact binary field payload, verbatim SMR1 bytes. */
    payload: blob("payload", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("simulation_run_documentVersionId_idx").on(table.documentVersionId),
    index("simulation_run_scenarioSnapshotHash_idx").on(
      table.scenarioSnapshotHash,
    ),
  ],
);

export const simulationRunRelations = relations(simulationRun, ({ one }) => ({
  documentVersion: one(documentVersion, {
    fields: [simulationRun.documentVersionId],
    references: [documentVersion.id],
  }),
}));
