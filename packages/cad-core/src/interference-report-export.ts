/**
 * Interference snapshot export (Phase 58): the deterministic JSON/HTML
 * serialization of Phase 51's interference report plus Phase 58's
 * clearance report — the roadmap's "snapshot report (deterministic
 * JSON/HTML export)" as a pure module, so the byte-determinism contract
 * ("identical state → identical bytes") is owned where the report shapes
 * live, not in the browser's download glue.
 *
 * ## Determinism discipline
 *
 * - No clock, no randomness, no locale formatting: every number is
 *   canonicalized through `formatSnapshotNumber` (twelve fractional
 *   digits, trailing zeros trimmed, `-0` folded to `0`) before it enters
 *   either serialization, and every object literal is written in one
 *   fixed key order.
 * - The HTML document is a fixed template with escaped host labels —
 *   never `innerHTML`-hostile, never style-dependent, printable as-is.
 * - The snapshot carries the input identity (document id) and the report
 *   counts so a snapshot can be diffed without re-running the check.
 * - `interferenceSnapshotDigest` is a djb2 change-detector over the
 *   serialized bytes — a machine-facing stability stamp, explicitly NOT
 *   a cryptographic hash.
 */

import {
  type AssemblyClearance,
  type ClearanceReport,
  CLEARANCE_PRECISION,
} from "./assembly-clearance";
import { type InterferenceReport } from "./assembly-interference";

/** The snapshot envelope's stable kind marker. */
export const INTERFERENCE_SNAPSHOT_KIND =
  "slopcad-interference-snapshot" as const;

/** The snapshot schema version, bumped only on shape changes. */
export const INTERFERENCE_SNAPSHOT_VERSION = 1 as const;

/** What the export needs beyond the reports: whose document, whose labels. */
export interface InterferenceSnapshotInput {
  /** The checked document's id (the snapshot's identity anchor). */
  readonly documentId: string;
  readonly interference: InterferenceReport;
  /** The clearance batch's report, when one was measured alongside. */
  readonly clearances?: ClearanceReport;
  /**
   * Human-readable occurrence label per occurrence id — the host's
   * naming, escaped into the HTML and written into the JSON verbatim.
   */
  readonly labelOf: (occurrenceId: string) => string;
}

/** The exported snapshot: fixed key order, canonicalized numbers. */
export interface InterferenceSnapshot {
  readonly kind: typeof INTERFERENCE_SNAPSHOT_KIND;
  readonly version: typeof INTERFERENCE_SNAPSHOT_VERSION;
  readonly documentId: string;
  readonly tolerance: number;
  readonly checkedPairs: number;
  readonly interferencePairs: number;
  readonly skippedPairs: number;
  readonly pairs: readonly {
    readonly first: string;
    readonly second: string;
    readonly firstLabel: string;
    readonly secondLabel: string;
    readonly volume: number;
  }[];
  readonly skipped: readonly {
    readonly first: string;
    readonly second: string;
    readonly reason: string;
  }[];
  readonly clearances: readonly {
    readonly first: string;
    readonly second: string;
    readonly firstLabel: string;
    readonly secondLabel: string;
    readonly distance: number;
  }[];
  readonly clearancePrecision: typeof CLEARANCE_PRECISION;
}

/** The path's JSON label: `outer/inner` joined ids. */
function pathKey(path: readonly string[]): string {
  return path.join("/");
}

/** Canonical snapshot number: twelve fractional digits, zeros trimmed. */
export function formatSnapshotNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      "A snapshot number must be finite; the export refuses to write an unmeasurable quantity.",
    );
  }
  const fixed = value.toFixed(12);
  const trimmed = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

/** Builds the snapshot from the reports, in the fixed key order. */
export function buildInterferenceSnapshot(
  input: InterferenceSnapshotInput,
): InterferenceSnapshot {
  return {
    kind: INTERFERENCE_SNAPSHOT_KIND,
    version: INTERFERENCE_SNAPSHOT_VERSION,
    documentId: input.documentId,
    tolerance: input.interference.tolerance,
    checkedPairs: input.interference.checkedPairs,
    interferencePairs: input.interference.pairs.length,
    skippedPairs: input.interference.skipped.length,
    pairs: input.interference.pairs.map((pair) => ({
      first: pathKey(pair.firstPath),
      second: pathKey(pair.secondPath),
      firstLabel: input.labelOf(pair.firstPath[0] ?? ""),
      secondLabel: input.labelOf(pair.secondPath[0] ?? ""),
      volume: pair.volume,
    })),
    skipped: input.interference.skipped.map((pair) => ({
      first: pathKey(pair.firstPath),
      second: pathKey(pair.secondPath),
      reason: pair.reason,
    })),
    clearances: (input.clearances?.clearances ?? []).map((clearance) =>
      clearanceEntry(clearance, input.labelOf),
    ),
    clearancePrecision: input.clearances?.precision ?? CLEARANCE_PRECISION,
  };
}

/** One clearance row, labels resolved. */
function clearanceEntry(
  clearance: AssemblyClearance,
  labelOf: (occurrenceId: string) => string,
): InterferenceSnapshot["clearances"][number] {
  return {
    first: pathKey(clearance.firstPath),
    second: pathKey(clearance.secondPath),
    firstLabel: labelOf(clearance.firstPath[0] ?? ""),
    secondLabel: labelOf(clearance.secondPath[0] ?? ""),
    distance: clearance.distance,
  };
}

/** The deterministic JSON serialization (two-space, trailing newline). */
export function serializeInterferenceSnapshotJson(
  snapshot: InterferenceSnapshot,
): string {
  const canonical = {
    ...snapshot,
    tolerance: Number(formatSnapshotNumber(snapshot.tolerance)),
    pairs: snapshot.pairs.map((pair) => ({
      ...pair,
      volume: Number(formatSnapshotNumber(pair.volume)),
    })),
    clearances: snapshot.clearances.map((clearance) => ({
      ...clearance,
      distance: Number(formatSnapshotNumber(clearance.distance)),
    })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** Escapes a value for safe interpolation into the HTML template. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The deterministic HTML snapshot: a fixed, self-contained report
 * document — no external assets, no clock, script-free.
 */
export function serializeInterferenceSnapshotHtml(
  snapshot: InterferenceSnapshot,
): string {
  const pairRows = snapshot.pairs
    .map(
      (pair) =>
        `      <tr><td>${escapeHtml(pair.firstLabel)}</td><td>${escapeHtml(pair.secondLabel)}</td><td class="num">${formatSnapshotNumber(pair.volume)}</td></tr>`,
    )
    .join("\n");
  const skippedRows = snapshot.skipped
    .map(
      (pair) =>
        `      <tr><td>${escapeHtml(pair.first)}</td><td>${escapeHtml(pair.second)}</td><td>${escapeHtml(pair.reason)}</td></tr>`,
    )
    .join("\n");
  const clearanceRows = snapshot.clearances
    .map(
      (clearance) =>
        `      <tr><td>${escapeHtml(clearance.firstLabel)}</td><td>${escapeHtml(clearance.secondLabel)}</td><td class="num">${formatSnapshotNumber(clearance.distance)}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Interference snapshot — ${escapeHtml(snapshot.documentId)}</title>
  </head>
  <body>
    <h1>Interference snapshot</h1>
    <p>document <strong>${escapeHtml(snapshot.documentId)}</strong> — schema v${snapshot.version} (${escapeHtml(snapshot.kind)})</p>
    <dl>
      <dt>tolerance</dt><dd class="num">${formatSnapshotNumber(snapshot.tolerance)}</dd>
      <dt>checked pairs</dt><dd>${snapshot.checkedPairs}</dd>
      <dt>interfering pairs</dt><dd>${snapshot.interferencePairs}</dd>
      <dt>skipped pairs</dt><dd>${snapshot.skippedPairs}</dd>
      <dt>clearance precision</dt><dd>${escapeHtml(snapshot.clearancePrecision)}</dd>
    </dl>
    <h2>Interfering pairs</h2>
    <table>
      <thead><tr><th>first</th><th>second</th><th>volume (mm³)</th></tr></thead>
      <tbody>
${pairRows === "" ? '        <tr><td colspan="3">none</td></tr>' : pairRows}
      </tbody>
    </table>
    <h2>Skipped pairs</h2>
    <table>
      <thead><tr><th>first</th><th>second</th><th>reason</th></tr></thead>
      <tbody>
${skippedRows === "" ? '        <tr><td colspan="3">none</td></tr>' : skippedRows}
      </tbody>
    </table>
    <h2>Clearances</h2>
    <table>
      <thead><tr><th>first</th><th>second</th><th>distance (mm)</th></tr></thead>
      <tbody>
${clearanceRows === "" ? '        <tr><td colspan="3">none</td></tr>' : clearanceRows}
      </tbody>
    </table>
  </body>
</html>
`;
}

/**
 * The djb2 change-detector over serialized bytes — a machine-facing
 * stability stamp (identical snapshots → identical digests), explicitly
 * not a cryptographic hash.
 */
export function interferenceSnapshotDigest(serialized: string): string {
  let hash = 5381;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = ((hash * 33) ^ serialized.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
