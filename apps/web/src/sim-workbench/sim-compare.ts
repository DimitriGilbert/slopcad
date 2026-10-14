/**
 * The run-comparison surface's pure core (ROADMAP-SIM Phase 63d, law
 * §7.11): given TWO persisted runs, derive exactly what the workbench
 * panel shows — the HISTORY-CURVE OVERLAY (drag/lift vs step, both
 * runs, one shared scale per quantity) and the FIELD DIFF (the
 * same-field, same-geometry per-node difference as a document-space
 * field block the Phase 62 overlay family renders, plus the L2/L∞
 * difference norms). Scope is law S17's whole boundary: two-run curve
 * overlay + field diff, nothing more — no dashboards, no N-run views
 * (those are Phase 70's Pareto generalization, by ruling).
 *
 * Everything here is pure and deterministic — the same two results
 * derive the same overlay, the same diff block, the same norms, the
 * same SVG point strings — and every refusal is a structured
 * `sim/compare-*` decline: a run missing its histories, a field absent
 * from either side, or (the honest one) two runs whose grids do not
 * share geometry or units. Comparing a 2 mm run against a 4 mm run of
 * the same scenario is declined, never silently resampled.
 *
 * The committed-application discipline (law S6) rides the same seam the
 * Phase 62 fixture established: the diff block publishes as a chunk
 * stream through the Phase 61d ledger, and the panel renders it only
 * once the ledger APPLIED the round — overlay application IS committed
 * application.
 */

import type {
  SimAppliedCounters,
  SimApplicationLedger,
} from "../cad-workbench/sim-application-ledger";
import type {
  SimHistorySeries,
  SimParseFailure,
  SimParseResult,
  SimResult,
  SimResultFieldBlock,
} from "@slopcad/sim-core";
import { simFail, simOk, splitSimFieldBlock } from "@slopcad/sim-core";

import { applySimNotification } from "../cad-workbench/sim-application-ledger";

/**
 * This module's structured failure: the `sim/compare-*` family over
 * sim-core's own `SimParseFailure` shape (a stable code, a human
 * message, the offending input) — the panel surfaces `code: message`
 * verbatim, the 63c error-line precedent. The codes are LOCAL to the
 * comparison surface: sim-core's closed code vocabulary is the landed
 * phases' own, and this surface builds on it without editing it.
 */
export interface SimCompareError extends SimParseFailure {
  readonly code: (typeof SIM_COMPARE_ERROR_CODES)[keyof typeof SIM_COMPARE_ERROR_CODES];
}

/** Raises one structured comparison decline. */
function compareError(
  code: SimCompareError["code"],
  message: string,
  input: unknown,
): SimCompareError {
  return { code, message, input };
}

/**
 * The history series the curve overlay lays over each other — the flow
 * kernel's force pair (`LBM_FORCE_SERIES_NAMES` in `@slopcad/sim-flow`).
 * The compare looks its runs' histories up BY NAME; a run whose engine
 * did not produce the pair declines loudly rather than plotting
 * whatever it did produce.
 */
export const SIM_COMPARE_HISTORY_NAMES = ["drag", "lift"] as const;

/**
 * The chunk count each comparison diff round splits into — the fixture
 * stream's own convention (`SIM_FIXTURE_CHUNKS_PER_ROUND`), so a diff
 * application commits the same-shaped round every other committed
 * overlay publishes.
 */
export const SIM_COMPARE_CHUNKS_PER_ROUND = 8;

/** The diff field id suffix (the block the overlays render carries it). */
export const SIM_COMPARE_DIFF_SUFFIX = "-diff";

/** The structured decline codes this module refuses with. */
export const SIM_COMPARE_ERROR_CODES = {
  historyMissing: "sim/compare-history-missing",
  fieldMissing: "sim/compare-field-missing",
  geometryMismatch: "sim/compare-geometry-mismatch",
  unitMismatch: "sim/compare-unit-mismatch",
  samplesEmpty: "sim/compare-samples-empty",
} as const;

// ---------------------------------------------------------------------------
// The curve overlay
// ---------------------------------------------------------------------------

/** One quantity's shared axis window (the honest shared scale). */
export interface SimCurveQuantity {
  readonly name: string;
  readonly unit: string;
  /** The minimum over BOTH runs' samples of this quantity. */
  readonly sharedMin: number;
  /** The maximum over BOTH runs' samples of this quantity. */
  readonly sharedMax: number;
}

/** One overlaid curve: a run's history normalized onto the panel. */
export interface SimCurveSeries {
  /** The stable series key — `<quantity>-<run>`, e.g. "drag-a". */
  readonly key: string;
  readonly run: "a" | "b";
  readonly quantity: string;
  readonly samples: readonly number[];
}

/** The two-run curve overlay, as data — the panel renders it verbatim. */
export interface SimCurveOverlay {
  readonly quantities: readonly SimCurveQuantity[];
  readonly series: readonly SimCurveSeries[];
  /** The step count every series carries (runs share their budget shape). */
  readonly steps: number;
}

function historyOf(
  result: SimResult,
  name: string,
  run: "a" | "b",
): SimParseResult<SimHistorySeries, SimCompareError> {
  const series = result.histories.find((candidate) => candidate.name === name);
  if (series === undefined) {
    return simFail(
      compareError(
        SIM_COMPARE_ERROR_CODES.historyMissing,
        `Run ${run} carries no "${name}" history series; the curve overlay declines rather than plotting a partial pair.`,
        { run, name, carried: result.histories.map((entry) => entry.name) },
      ),
    );
  }
  if (series.samples.length === 0) {
    return simFail(
      compareError(
        SIM_COMPARE_ERROR_CODES.samplesEmpty,
        `Run ${run}'s "${name}" history is empty; there is no curve to overlay.`,
        { run, name },
      ),
    );
  }
  return simOk(series);
}

/**
 * Derives the two-run curve overlay: both runs' drag and lift series
 * with ONE shared min/max window per quantity — the runs differ, and
 * the shared scale is what makes the difference visible. The two runs'
 * series need not share length (a longer budget overlays a shorter
 * one); the overlay plots each series against its own step count.
 */
export function simCurveOverlayOf(
  runA: SimResult,
  runB: SimResult,
): SimParseResult<SimCurveOverlay, SimCompareError> {
  const quantities: SimCurveQuantity[] = [];
  const series: SimCurveSeries[] = [];
  let steps = 0;
  for (const name of SIM_COMPARE_HISTORY_NAMES) {
    const a = historyOf(runA, name, "a");
    if (!a.ok) return a;
    const b = historyOf(runB, name, "b");
    if (!b.ok) return b;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const sample of [...a.value.samples, ...b.value.samples]) {
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    quantities.push({
      name,
      unit: a.value.unit,
      sharedMin: min,
      sharedMax: max,
    });
    series.push({
      key: `${name}-a`,
      run: "a",
      quantity: name,
      samples: a.value.samples,
    });
    series.push({
      key: `${name}-b`,
      run: "b",
      quantity: name,
      samples: b.value.samples,
    });
    steps = Math.max(steps, a.value.samples.length, b.value.samples.length);
  }
  return simOk({ quantities, series, steps });
}

/**
 * One series' deterministic SVG points string: samples mapped onto a
 * `width × height` panel against the quantity's shared window (a flat
 * window degenerates to the mid line — stated, never a division).
 */
export function simCurvePolylinePoints(
  series: readonly number[],
  sharedMin: number,
  sharedMax: number,
  width: number,
  height: number,
): string {
  const span = sharedMax - sharedMin;
  const points: string[] = [];
  for (let index = 0; index < series.length; index += 1) {
    const x = (index / Math.max(1, series.length - 1)) * width;
    const value = series[index] ?? 0;
    const normalized = span > 0 ? (value - sharedMin) / span : 0.5;
    const y = height - normalized * height;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return points.join(" ");
}

// ---------------------------------------------------------------------------
// The field diff
// ---------------------------------------------------------------------------

/** The same-field difference of two runs, as the overlays' input. */
export interface SimFieldDiff {
  /** The diffed field's id (both runs carry it). */
  readonly fieldId: string;
  /** The diff block's id — `<fieldId>-diff`, the stream the ledger commits. */
  readonly blockId: string;
  /** The values' unit (both runs agreed on it). */
  readonly unit: string;
  /** The diff block, document space, x-fastest — A − B per node. */
  readonly block: SimResultFieldBlock;
  /** ‖A − B‖₂ / ‖A‖₂ over the whole field (the stated convention). */
  readonly l2Relative: number;
  /** max|A − B| / ‖A‖∞ (the peak difference against run A's peak). */
  readonly linfRelative: number;
  /** The peak absolute difference, in the field's own unit. */
  readonly linfAbs: number;
  /** The symmetric diverging paint window [−m, +m] (m = ‖A − B‖∞). */
  readonly valueRange: readonly [number, number];
}

function blockOf(
  result: SimResult,
  fieldId: string,
  run: "a" | "b",
): SimParseResult<SimResultFieldBlock, SimCompareError> {
  const block = result.fields.find((candidate) => candidate.id === fieldId);
  if (block === undefined) {
    return simFail(
      compareError(
        SIM_COMPARE_ERROR_CODES.fieldMissing,
        `Run ${run} carries no "${fieldId}" field block; the field diff declines rather than diffing a mismatched pair.`,
        { run, fieldId, carried: result.fields.map((entry) => entry.id) },
      ),
    );
  }
  return simOk(block);
}

function sameGeometry(a: SimResultFieldBlock, b: SimResultFieldBlock): boolean {
  return (
    a.extent.every((value, axis) => value === b.extent[axis]) &&
    a.originMm.every((value, axis) => value === b.originMm[axis]) &&
    a.spacingMm.every((value, axis) => value === b.spacingMm[axis])
  );
}

/**
 * Derives the same-field difference of two runs: per-node A − B as a
 * document-space field block (the Phase 62 overlay family's input,
 * painted through a diverging colormap against the symmetric window),
 * with the L2 and L∞ difference norms stated beside it. Refuses —
 * loudly, never resampling — when the two runs' grids or units
 * disagree: a 2 mm run against a 4 mm run of the same scenario is not
 * a field diff; it is the grid-convergence ladder's question.
 */
export function simFieldDiffOf(
  runA: SimResult,
  runB: SimResult,
  fieldId: string,
): SimParseResult<SimFieldDiff, SimCompareError> {
  const a = blockOf(runA, fieldId, "a");
  if (!a.ok) return a;
  const b = blockOf(runB, fieldId, "b");
  if (!b.ok) return b;
  if (!sameGeometry(a.value, b.value)) {
    return simFail(
      compareError(
        SIM_COMPARE_ERROR_CODES.geometryMismatch,
        `The two runs' "${fieldId}" blocks do not share grid geometry (extent, origin, spacing must match exactly); the field diff refuses to resample one onto the other.`,
        {
          a: {
            extent: a.value.extent,
            originMm: a.value.originMm,
            spacingMm: a.value.spacingMm,
          },
          b: {
            extent: b.value.extent,
            originMm: b.value.originMm,
            spacingMm: b.value.spacingMm,
          },
        },
      ),
    );
  }
  const unitA = a.value.unit ?? "1";
  const unitB = b.value.unit ?? "1";
  if (unitA !== unitB) {
    return simFail(
      compareError(
        SIM_COMPARE_ERROR_CODES.unitMismatch,
        `The two runs' "${fieldId}" blocks carry different units ("${unitA}" vs "${unitB}"); a difference between unlike units is not a number.`,
        { unitA, unitB },
      ),
    );
  }
  if (a.value.values.length !== b.value.values.length) {
    return simFail(
      compareError(
        SIM_COMPARE_ERROR_CODES.geometryMismatch,
        `The two runs' "${fieldId}" blocks disagree on value count (${String(a.value.values.length)} vs ${String(b.value.values.length)}) for a shared extent — a malformed pair the diff refuses.`,
        { fieldId },
      ),
    );
  }
  const values: number[] = [];
  let sumSquaredDiff = 0;
  let sumSquaredA = 0;
  let linfAbs = 0;
  let linfA = 0;
  for (let index = 0; index < a.value.values.length; index += 1) {
    const va = a.value.values[index] ?? 0;
    const vb = b.value.values[index] ?? 0;
    const diff = va - vb;
    values.push(diff);
    sumSquaredDiff += diff * diff;
    sumSquaredA += va * va;
    const absDiff = Math.abs(diff);
    if (absDiff > linfAbs) linfAbs = absDiff;
    if (Math.abs(va) > linfA) linfA = Math.abs(va);
  }
  const block: SimResultFieldBlock = {
    id: `${fieldId}${SIM_COMPARE_DIFF_SUFFIX}`,
    ...(unitA === "1" ? {} : { unit: unitA }),
    extent: a.value.extent,
    originMm: a.value.originMm,
    spacingMm: a.value.spacingMm,
    dataType: "float32",
    values,
  };
  return simOk({
    fieldId,
    blockId: block.id,
    unit: unitA,
    block,
    l2Relative:
      sumSquaredA === 0
        ? sumSquaredDiff === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : Math.sqrt(sumSquaredDiff / sumSquaredA),
    linfRelative:
      linfA === 0
        ? linfAbs === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : linfAbs / linfA,
    linfAbs,
    // Identical runs diff to exactly zero; a zero window would divide
    // the color scale by zero, so the degenerate case paints against a
    // unit window (the neutral color everywhere — the honest picture).
    valueRange: linfAbs > 0 ? [-linfAbs, linfAbs] : [-1, 1],
  });
}

/**
 * Publishes the diff block as a chunk stream and applies every chunk
 * through the Phase 61d ledger — the exact committed-application door
 * the fixture grid and the run previews ride. Returns the committed
 * counters after the LAST application, or `null` when nothing applied
 * (the caller keeps the previous overlay and moves no counter).
 */
export function applySimFieldDiff(
  ledger: SimApplicationLedger,
  diff: SimFieldDiff,
): SimAppliedCounters | null {
  // The reassembler's own framing law: a chunk carries at least one
  // value, so a block smaller than the round's chunk count splits into
  // exactly its value count (the large real blocks keep the full 8).
  const chunkCount = Math.min(
    SIM_COMPARE_CHUNKS_PER_ROUND,
    diff.block.values.length,
  );
  let last: SimAppliedCounters | null = null;
  for (const chunk of splitSimFieldBlock(diff.block, chunkCount)) {
    const committed = applySimNotification(ledger, {
      ...chunk,
      kind: "field-chunk",
    });
    if (committed !== null) last = committed;
  }
  return last;
}
