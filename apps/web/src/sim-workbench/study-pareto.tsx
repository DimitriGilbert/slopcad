/**
 * The Pareto results view (Phase 70b): the Phase 63 comparison surface
 * generalized to N runs — deterministic data first, SVG second (the
 * `./fan-chart` family), nothing freehand. Three views, the risk-S17
 * boundary's own shape:
 *
 * - the PARETO SCATTER — every final-front candidate (rank 0) and the
 *   dominated survivors, one circle per candidate over the selected
 *   objective pair; with a single-objective study the x axis degrades
 *   honestly to the candidate index (a one-objective front is a ranking);
 * - the BEST-OF-GENERATION PROGRESSION — the per-generation best of the
 *   study's FIRST objective, the live-preview story rendered from the
 *   logged generations;
 * - the CAMPAIGN LIST — the store's run families
 *   (`groupSimCampaignFamilies`), the persisted front keyed to its
 *   deterministic family.
 *
 * Candidate replay lives in the page (the campaign host), not here:
 * this module is pure projection, the same discipline as
 * `simCurveOverlayOf`.
 */

import type { SimStudy } from "@slopcad/cad-core";
import type {
  SimResultRunRecord,
  WorkerSimOptimizeCandidate,
  WorkerSimOptimizeResult,
} from "@slopcad/sim-core";
import { groupSimCampaignFamilies } from "@slopcad/sim-optimization";
import type { ReactElement } from "react";

/** The panels' deterministic geometry, px (the compare family's). */
const PARETO_WIDTH = 256;
const PARETO_HEIGHT = 128;
const PROGRESSION_WIDTH = 256;
const PROGRESSION_HEIGHT = 64;

/** One scatter point: the candidate's index, its pair, and its front flag. */
export interface StudyScatterPoint {
  /** The candidate's evaluation index (its row identity). */
  readonly candidate: number;
  readonly x: number;
  readonly y: number;
  /** True on the final front (rank 0) — the blue circles. */
  readonly onFront: boolean;
}

/** The pure scatter projection over a campaign's last population + front. */
export interface StudyParetoScatter {
  readonly points: readonly StudyScatterPoint[];
  readonly xLabel: string;
  readonly yLabel: string;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  /** True when the x axis is the candidate index (single-objective honesty). */
  readonly xIsCandidateIndex: boolean;
}

/** One generation's best first-objective value (the progression series). */
export interface StudyProgressionPoint {
  readonly generation: number;
  readonly value: number;
}

/** The Pareto view's pure data: the scatter plus the progression. */
export interface StudyParetoView {
  readonly scatter: StudyParetoScatter;
  readonly progression: readonly StudyProgressionPoint[];
  /** The front's candidates in evaluation order (the replay targets). */
  readonly front: readonly WorkerSimOptimizeCandidate[];
}

/** The axis label of one objective index (quantity + direction). */
function objectiveLabel(study: SimStudy, index: number): string {
  const objective = study.objectives[index];
  return objective === undefined
    ? `objective ${String(index)}`
    : `${objective.direction === "minimize" ? "min" : "max"} ${objective.quantity}`;
}

function finiteRange(
  values: readonly number[],
): readonly [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) return null;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!(max > min)) max = min + 1;
  return [min, max];
}

/**
 * Projects the campaign result into the Pareto view: the last
 * generation's survivors and the final front scatter over the objective
 * pair (or the honest single-objective degradation), and the
 * best-of-generation progression over the first objective.
 */
export function paretoViewOf(
  study: SimStudy,
  result: WorkerSimOptimizeResult,
): StudyParetoView {
  const lastGeneration =
    result.generations[result.generations.length - 1]?.candidates ?? [];
  const scored = lastGeneration.filter(
    (candidate) => candidate.status === "ok",
  );
  const frontIndexes = new Set(
    result.pareto.map((candidate) => candidate.index),
  );
  const singleObjective = study.objectives.length === 1;
  const xIndex = 0;
  const yIndex = singleObjective ? 0 : 1;
  const xValues = scored.map((candidate) =>
    singleObjective ? candidate.index : (candidate.objectives[xIndex] ?? 0),
  );
  const yValues = scored.map((candidate) => candidate.objectives[yIndex] ?? 0);
  const xRange = finiteRange(xValues);
  const yRange = finiteRange(yValues);
  const scatter: StudyParetoScatter = {
    points: scored.map((candidate) => ({
      candidate: candidate.index,
      x: singleObjective
        ? candidate.index
        : (candidate.objectives[xIndex] ?? 0),
      y: candidate.objectives[yIndex] ?? 0,
      onFront: frontIndexes.has(candidate.index),
    })),
    xLabel: singleObjective ? "candidate" : objectiveLabel(study, xIndex),
    yLabel: objectiveLabel(study, yIndex),
    xMin: xRange === null ? 0 : xRange[0],
    xMax: xRange === null ? 1 : xRange[1],
    yMin: yRange === null ? 0 : yRange[0],
    yMax: yRange === null ? 1 : yRange[1],
    xIsCandidateIndex: singleObjective,
  };
  const progression: StudyProgressionPoint[] = [];
  for (const generation of result.generations) {
    const best = generation.candidates
      .filter((candidate) => candidate.status === "ok")
      .map((candidate) => candidate.objectives[0] ?? 0)
      .reduce<number | null>(
        (current, value) =>
          current === null
            ? value
            : study.objectives[0]?.direction === "maximize"
              ? value > current
                ? value
                : current
              : value < current
                ? value
                : current,
        null,
      );
    if (best !== null) {
      progression.push({ generation: generation.generation, value: best });
    }
  }
  return { scatter, progression, front: [...result.pareto] };
}

/** Maps a scatter x to panel pixels. */
function scatterX(scatter: StudyParetoScatter, value: number): number {
  const span = scatter.xMax - scatter.xMin;
  const fraction = span > 0 ? (value - scatter.xMin) / span : 0.5;
  return Math.min(PARETO_WIDTH - 3, Math.max(3, fraction * PARETO_WIDTH));
}

/** Maps a scatter y to panel pixels (SVG y grows downward). */
function scatterY(scatter: StudyParetoScatter, value: number): number {
  const span = scatter.yMax - scatter.yMin;
  const fraction = span > 0 ? (value - scatter.yMin) / span : 0.5;
  return PARETO_HEIGHT - Math.min(1, Math.max(0, fraction)) * PARETO_HEIGHT;
}

/** Maps a progression value to panel pixels (SVG y grows downward). */
function progressionY(
  points: readonly StudyProgressionPoint[],
  value: number,
): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
  }
  if (!(max > min)) max = min + 1;
  const fraction = (value - min) / (max - min);
  return (
    PROGRESSION_HEIGHT - Math.min(1, Math.max(0, fraction)) * PROGRESSION_HEIGHT
  );
}

/**
 * The Pareto panels: the scatter (front in blue, dominated gray) with a
 * Replay button per FRONT candidate, and the best-of-generation
 * progression polyline — both from the pure {@link StudyParetoView}.
 */
export function ParetoViewPanel({
  view,
  replayStatus,
  onReplay,
}: {
  readonly view: StudyParetoView;
  /** The replay family's status attribute mirror (idle | running | ok | declined). */
  readonly replayStatus: string;
  readonly onReplay: (candidate: WorkerSimOptimizeCandidate) => void;
}): ReactElement {
  const generationSpan = Math.max(1, view.progression.length - 1);
  return (
    <div className="space-y-1" data-testid="workbench-sim-pareto">
      <svg
        width={PARETO_WIDTH}
        height={PARETO_HEIGHT}
        viewBox={`0 0 ${String(PARETO_WIDTH)} ${String(PARETO_HEIGHT)}`}
        role="img"
        aria-label="Pareto scatter: the final front and the dominated survivors over the selected objectives"
        data-testid="workbench-sim-pareto-scatter"
      >
        {view.scatter.points.map((point) => (
          <circle
            key={point.candidate}
            data-candidate={point.candidate}
            data-front={point.onFront ? "true" : "false"}
            cx={scatterX(view.scatter, point.x)}
            cy={scatterY(view.scatter, point.y)}
            r={point.onFront ? 3 : 2}
            fill={point.onFront ? "#1d4ed8" : "#9ca3af"}
          />
        ))}
      </svg>
      <p className="font-mono text-[10px]">
        x {view.scatter.xLabel} [{view.scatter.xMin.toPrecision(4)} …{" "}
        {view.scatter.xMax.toPrecision(4)}] · y {view.scatter.yLabel} [
        {view.scatter.yMin.toPrecision(4)} … {view.scatter.yMax.toPrecision(4)}]
        · front {String(view.front.length)} blue · dominated gray
      </p>
      <svg
        width={PROGRESSION_WIDTH}
        height={PROGRESSION_HEIGHT}
        viewBox={`0 0 ${String(PROGRESSION_WIDTH)} ${String(PROGRESSION_HEIGHT)}`}
        role="img"
        aria-label="Best-of-generation progression of the first objective"
        data-testid="workbench-sim-pareto-progression"
      >
        <polyline
          data-series="best-of-generation"
          fill="none"
          stroke="#1d4ed8"
          strokeWidth={1.5}
          points={view.progression
            .map(
              (point, index) =>
                `${String(
                  Math.round((index / generationSpan) * PROGRESSION_WIDTH),
                )},${String(Math.round(progressionY(view.progression, point.value)))}`,
            )
            .join(" ")}
        />
      </svg>
      <div className="space-y-0.5">
        {view.front.map((candidate) => (
          <button
            key={candidate.index}
            type="button"
            id={`workbench-sim-replay-${String(candidate.index)}`}
            className="w-full border px-1 py-0.5 font-mono text-[10px]"
            disabled={replayStatus === "running"}
            onClick={() => {
              onReplay(candidate);
            }}
          >
            replay #{String(candidate.index)} →{" "}
            {candidate.objectives
              .map((value) => value.toPrecision(5))
              .join(", ")}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One campaign family row of the store's grouped runs. */
export interface StudyCampaignFamilyRow {
  readonly family: string;
  readonly studyId: string;
  readonly seed: number;
  readonly generations: readonly number[];
  readonly runs: number;
}

/**
 * Projects the persisted run list into the campaign list rows: only
 * campaign-tagged runs participate, grouped by family, each row the
 * family's study, seed, generation span, and run count.
 */
export function campaignFamilyRows(
  runs: readonly SimResultRunRecord[],
): readonly StudyCampaignFamilyRow[] {
  const families = groupSimCampaignFamilies(runs);
  const rows: StudyCampaignFamilyRow[] = [];
  for (const [family, byGeneration] of families) {
    let studyId = "";
    let seed = 0;
    let count = 0;
    const generations: number[] = [];
    for (const [generation, bucket] of byGeneration) {
      generations.push(generation);
      count += bucket.length;
      const tag = bucket[0]?.summary.campaign;
      if (tag !== undefined) {
        studyId = tag.studyId;
        seed = tag.seed;
      }
    }
    rows.push({
      family,
      studyId,
      seed,
      generations: [...generations].sort((left, right) => left - right),
      runs: count,
    });
  }
  return rows;
}
