/**
 * The interference panel's model (Phase 58): from Phase 51's interference
 * report plus Phase 58's clearance report to the rows, counts, and
 * isolation state the `/workbench-assembly-interference` panel renders —
 * the same derivation-extracted-from-the-page pattern as the distance and
 * mass-properties readouts.
 *
 * Pairing rule: a clearance row pairs with its interference verdict by
 * the joined path key (`outer/inner`), the snapshot export's own identity,
 * so the panel and the export can never disagree about which pair a
 * number belongs to. An interfering pair shows its intersection volume
 * (the clearance of intersecting soups is not displayed — a `0` next to a
 * penetration reads as a clearance answer and this panel refuses that
 * lie); a clear pair shows its sampled distance. A pair the kernel seam
 * declined shows the decline reason, never folded into "clear".
 *
 * Isolation is a pure filter: the isolated pair's two occurrence ids, or
 * `undefined` for "show all" — the page projects exactly those instances
 * and stamps the machine surface.
 */

import {
  buildInterferenceSnapshot,
  formatMeasureDistance,
  formatVolume,
  interferenceSnapshotDigest,
  length,
  serializeInterferenceSnapshotHtml,
  serializeInterferenceSnapshotJson,
  volume,
  type ClearanceReport,
  type InterferenceReport,
  type InterferenceSnapshot,
} from "@slopcad/cad-core";

/** What the model is computed from. */
export interface InterferencePanelInput {
  /** The interference batch's report, or `null` before a check runs. */
  readonly interference: InterferenceReport | null;
  /** The clearance batch's report, or `null` before a check runs. */
  readonly clearances: ClearanceReport | null;
  /** Human-readable occurrence name per occurrence id. */
  readonly labelOf: (occurrenceId: string) => string;
}

/** One panel row: one pair's verdict and its displayable numbers. */
export interface InterferencePanelRow {
  /** The pair's joined path key — the row's identity. */
  readonly key: string;
  readonly firstLabel: string;
  readonly secondLabel: string;
  /** The pair's verdict: interferes, clear, or kernel-declined. */
  readonly verdict: "interferes" | "clear" | "skipped";
  /** The intersection volume — `5400.000 mm³` — interfering rows only. */
  readonly volumeText: string | null;
  /** The sampled clearance — `140.000 mm` — clear rows only. */
  readonly clearanceText: string | null;
  /** The structured decline reason — skipped rows only. */
  readonly reasonText: string | null;
  /** The pair's occurrence ids, in report order (isolation's input). */
  readonly firstId: string;
  readonly secondId: string;
}

/** The panel's display model. */
export interface InterferencePanelModel {
  /** `idle` before any check ran; the panel shows honest silence. */
  readonly status: "idle" | "reported";
  readonly rows: readonly InterferencePanelRow[];
  readonly pairCount: number;
  readonly skippedCount: number;
  readonly checkedCount: number;
  readonly clearanceCount: number;
}

/** The joined path key (`outer/inner`) — pair identity across the panel. */
export function interferencePairKey(path: readonly string[]): string {
  return path.join("/");
}

/** Computes the panel model from the reports and the host's labels. */
export function interferencePanelModel(
  input: InterferencePanelInput,
): InterferencePanelModel {
  if (input.interference === null) {
    return {
      status: "idle",
      rows: [],
      pairCount: 0,
      skippedCount: 0,
      checkedCount: 0,
      clearanceCount: 0,
    };
  }
  const clearanceByKey = new Map<string, number>();
  if (input.clearances !== null) {
    for (const clearance of input.clearances.clearances) {
      clearanceByKey.set(
        `${interferencePairKey(clearance.firstPath)}|${interferencePairKey(clearance.secondPath)}`,
        clearance.distance,
      );
    }
  }
  const interferingKeys = new Set(
    input.interference.pairs.map(
      (pair) =>
        `${interferencePairKey(pair.firstPath)}|${interferencePairKey(pair.secondPath)}`,
    ),
  );
  const skippedKeys = new Set(
    input.interference.skipped.map(
      (pair) =>
        `${interferencePairKey(pair.firstPath)}|${interferencePairKey(pair.secondPath)}`,
    ),
  );

  const rows: InterferencePanelRow[] = [];
  for (const pair of input.interference.pairs) {
    const firstId = pair.firstPath[0] ?? "";
    const secondId = pair.secondPath[0] ?? "";
    rows.push({
      key: `${interferencePairKey(pair.firstPath)}|${interferencePairKey(pair.secondPath)}`,
      firstLabel: input.labelOf(firstId),
      secondLabel: input.labelOf(secondId),
      verdict: "interferes",
      volumeText: `${formatVolume(volume(pair.volume))} mm³`,
      clearanceText: null,
      reasonText: null,
      firstId,
      secondId,
    });
  }
  for (const pair of input.interference.skipped) {
    const firstId = pair.firstPath[0] ?? "";
    const secondId = pair.secondPath[0] ?? "";
    rows.push({
      key: `${interferencePairKey(pair.firstPath)}|${interferencePairKey(pair.secondPath)}`,
      firstLabel: input.labelOf(firstId),
      secondLabel: input.labelOf(secondId),
      verdict: "skipped",
      volumeText: null,
      clearanceText: null,
      reasonText: pair.reason,
      firstId,
      secondId,
    });
  }
  if (input.clearances !== null) {
    for (const clearance of input.clearances.clearances) {
      const firstId = clearance.firstPath[0] ?? "";
      const secondId = clearance.secondPath[0] ?? "";
      const key = `${interferencePairKey(clearance.firstPath)}|${interferencePairKey(clearance.secondPath)}`;
      if (interferingKeys.has(key) || skippedKeys.has(key)) continue;
      rows.push({
        key,
        firstLabel: input.labelOf(firstId),
        secondLabel: input.labelOf(secondId),
        verdict: "clear",
        volumeText: null,
        clearanceText: `${formatMeasureDistance(length(clearance.distance))} mm`,
        reasonText: null,
        firstId,
        secondId,
      });
    }
  }

  return {
    status: "reported",
    rows,
    pairCount: input.interference.pairs.length,
    skippedCount: input.interference.skipped.length,
    checkedCount: input.interference.checkedPairs,
    clearanceCount: clearanceByKey.size,
  };
}

/** An isolated pair: the two occurrence ids, in report order. */
export interface IsolatedPair {
  readonly firstId: string;
  readonly secondId: string;
}

/** The machine stamp for the isolation state — `none` or `a|b`. */
export function isolationStamp(isolated: IsolatedPair | undefined): string {
  return isolated === undefined
    ? "none"
    : `${isolated.firstId}|${isolated.secondId}`;
}

/** True when the instance's outermost occurrence belongs to the isolation. */
export function isInstanceIsolated(
  outermostId: string,
  isolated: IsolatedPair | undefined,
): boolean {
  if (isolated === undefined) return true;
  return isolated.firstId === outermostId || isolated.secondId === outermostId;
}

/** The prepared export the page holds as a download. */
export interface PreparedSnapshotExport {
  readonly format: "json" | "html";
  readonly name: string;
  /** The serialized document — the download's exact bytes. */
  readonly text: string;
  /** The text's UTF-8 byte length, deterministically. */
  readonly bytes: number;
  /** The djb2 change-detector digest over the serialized bytes. */
  readonly digest: string;
}

/**
 * Builds both deterministic serializations of the snapshot — the page
 * holds ONE at a time as the download; the digests are the byte-stability
 * machine stamps.
 */
export function prepareSnapshotExports(input: {
  readonly documentId: string;
  readonly interference: InterferenceReport;
  readonly clearances: ClearanceReport | undefined;
  readonly labelOf: (occurrenceId: string) => string;
  readonly nameStem: string;
}): {
  readonly json: PreparedSnapshotExport;
  readonly html: PreparedSnapshotExport;
} {
  const snapshot: InterferenceSnapshot = buildInterferenceSnapshot({
    documentId: input.documentId,
    interference: input.interference,
    clearances: input.clearances,
    labelOf: input.labelOf,
  });
  const json = serializeInterferenceSnapshotJson(snapshot);
  const html = serializeInterferenceSnapshotHtml(snapshot);
  const prepared = (
    format: "json" | "html",
    text: string,
  ): PreparedSnapshotExport => ({
    format,
    name: `${input.nameStem}.${format}`,
    text,
    bytes: new TextEncoder().encode(text).length,
    digest: interferenceSnapshotDigest(text),
  });
  return {
    json: prepared("json", json),
    html: prepared("html", html),
  };
}
