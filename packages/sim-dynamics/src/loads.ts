/**
 * The quasi-static load coupling (Phase 67c, deliverable 4): the time
 * series a dynamics scenario carries beside its mechanism — flow force
 * histories (the 63/66 runs' drag/lift/torque outputs, applied per body
 * occurrence) and named combustion torque estimates (Phase 68's SHAPE:
 * an external torque series on a joint's drive DOF; the Phase 68
 * integration itself is Phase 68) — evaluated PER STEP into the
 * contract's control terms: flow forces become the gravity-sharing
 * `loads` term (world forces at world points), torque estimates become
 * `jointEfforts`.
 *
 * The evaluation is the tabulated motor's discipline, stated once:
 * piecewise-linear interpolation between samples, clamped to the
 * constant END values outside their range (the first sample's value
 * at and before its time, the last sample's value at and after).
 * Deterministic pure functions — no state, no closures over state
 * (law S2).
 */

import type { CompiledSimDynamicsLoad } from "@slopcad/sim-core";
import type { DynamicsJointEffort, DynamicsLoad } from "./contract";

/**
 * One load series compiled for stepping: the per-component sample
 * tables and the addresses the control terms need. The flow-force and
 * joint-torque kinds share the interpolation spine.
 */
export interface CompiledDynamicsLoadSeries {
  readonly kind: "flow-force" | "joint-torque";
  /** The flow-force target occurrence; absent on joint torques. */
  readonly occurrenceId?: string;
  /** The named estimate's display name; absent on flow forces. */
  readonly name?: string;
  /** The joint-torque target joint; absent on flow forces. */
  readonly jointId?: string;
  /** The sample times, s (strictly increasing, ≥ 2 entries). */
  readonly times: readonly number[];
  /** The force components per sample, N (flow forces only). */
  readonly forces?: readonly (readonly [number, number, number])[];
  /** The optional application points per sample, m (flow forces only). */
  readonly points?: readonly (readonly [number, number, number] | undefined)[];
  /** The drive efforts per sample, N·m (joint torques only). */
  readonly efforts?: readonly number[];
}

/**
 * Compiles the scenario's load couplings into the stepping form. Every
 * series already validated at the sim-core compile boundary; this door
 * re-checks the invariants it consumes (the established restating
 * discipline) and declines as `sim/mechanism-invalid` — the dynamics
 * domain's own refusal code — never guesses a series.
 */
export function compileDynamicsLoads(
  loads: readonly CompiledSimDynamicsLoad[],
):
  | {
      readonly ok: true;
      readonly series: readonly CompiledDynamicsLoadSeries[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly at: unknown;
    } {
  const series: CompiledDynamicsLoadSeries[] = [];
  for (const load of loads) {
    if (load.samples.length < 2) {
      return {
        ok: false,
        message:
          "A load coupling must carry at least two samples (a series interpolates).",
        at: load,
      };
    }
    const times: number[] = [];
    for (const sample of load.samples) {
      if (
        typeof sample.tS !== "number" ||
        !Number.isFinite(sample.tS) ||
        (times.length > 0 && sample.tS <= (times.at(-1) ?? 0))
      ) {
        return {
          ok: false,
          message:
            "A load coupling's sample times must be finite and strictly increasing.",
          at: load.samples,
        };
      }
      times.push(sample.tS);
    }
    if (load.kind === "flow-force") {
      const forces: (readonly [number, number, number])[] = [];
      const points: (readonly [number, number, number] | undefined)[] = [];
      for (const sample of load.samples) {
        forces.push([...sample.forceN] as readonly [number, number, number]);
        points.push(
          sample.atWorldPointM === undefined
            ? undefined
            : ([...sample.atWorldPointM] as readonly [number, number, number]),
        );
      }
      series.push({
        kind: "flow-force",
        occurrenceId: load.occurrenceId,
        times,
        forces,
        points,
      });
      continue;
    }
    const efforts: number[] = [];
    for (const sample of load.samples) {
      if (
        typeof sample.effortNPerM !== "number" ||
        !Number.isFinite(sample.effortNPerM)
      ) {
        return {
          ok: false,
          message: "A torque estimate's samples must be finite N·m values.",
          at: load.samples,
        };
      }
      efforts.push(sample.effortNPerM);
    }
    series.push({
      kind: "joint-torque",
      name: load.name,
      jointId: load.jointId,
      times,
      efforts,
    });
  }
  return { ok: true, series };
}

/** The interpolation weight of `t` inside a strictly increasing table. */
function bracket(
  times: readonly number[],
  t: number,
): readonly [number, number, number] {
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? 0;
  if (t <= first) return [0, 1, 0];
  if (t >= last) return [times.length - 1, 1, 0];
  for (let index = 1; index < times.length; index += 1) {
    const upper = times[index] ?? 0;
    const lower = times[index - 1] ?? 0;
    if (t <= upper) {
      const span = upper - lower;
      const weight = span === 0 ? 0 : (t - lower) / span;
      return [index - 1, 1 - weight, weight];
    }
  }
  return [times.length - 1, 1, 0];
}

/** One interpolated scalar: lower·a + upper·b at the bracket. */
function interpolate(
  times: readonly number[],
  values: readonly number[],
  t: number,
): number {
  const [index, lowerWeight, upperWeight] = bracket(times, t);
  const lower = values[index] ?? 0;
  const upper = values[index + 1] ?? lower;
  return lowerWeight * lower + upperWeight * upper;
}

/** The control terms every series evaluates to at time `t`, s. */
export interface DynamicsLoadControlTerms {
  readonly loads: readonly DynamicsLoad[];
  readonly jointEfforts: readonly DynamicsJointEffort[];
}

/** An empty control term — the no-load scenarios' steady shape. */
export function emptyDynamicsLoadTerms(): DynamicsLoadControlTerms {
  return { loads: [], jointEfforts: [] };
}

/**
 * Evaluates every series at time `t`: flow forces interpolate
 * component-wise (the application point with them — a point that
 * exists at some samples and not others interpolates from the last
 * authored one, the honest nearest-sample rule), torque estimates
 * interpolate on the effort. Both clamp outside the sampled range (the
 * constant-end extrapolation the module header states).
 */
export function evaluateDynamicsLoads(
  series: readonly CompiledDynamicsLoadSeries[],
  t: number,
): DynamicsLoadControlTerms {
  const loads: DynamicsLoad[] = [];
  const jointEfforts: DynamicsJointEffort[] = [];
  for (const entry of series) {
    if (entry.kind === "flow-force") {
      if (
        entry.occurrenceId === undefined ||
        entry.forces === undefined ||
        entry.points === undefined
      ) {
        continue; // compileDynamicsLoads declined malformed series already.
      }
      const forceN: [number, number, number] = [
        interpolate(
          entry.times,
          entry.forces.map((force) => force[0] ?? 0),
          t,
        ),
        interpolate(
          entry.times,
          entry.forces.map((force) => force[1] ?? 0),
          t,
        ),
        interpolate(
          entry.times,
          entry.forces.map((force) => force[2] ?? 0),
          t,
        ),
      ];
      const [index, lowerWeight, upperWeight] = bracket(entry.times, t);
      const lowerPoint = entry.points[index];
      const upperPoint = entry.points[index + 1];
      let atWorldPointM: readonly [number, number, number] | undefined;
      if (lowerPoint !== undefined && upperPoint !== undefined) {
        // Both bracketing samples carry a point: interpolate it with the
        // force (the moving application point).
        atWorldPointM = [
          lowerWeight * lowerPoint[0] + upperWeight * upperPoint[0],
          lowerWeight * lowerPoint[1] + upperWeight * upperPoint[1],
          lowerWeight * lowerPoint[2] + upperWeight * upperPoint[2],
        ];
      } else {
        // A point that exists at some samples and not others takes the
        // last authored one before `t` (the honest nearest-sample rule).
        atWorldPointM = entry.points[index];
        for (
          let back = index;
          back >= 0 && atWorldPointM === undefined;
          back -= 1
        ) {
          atWorldPointM = entry.points[back];
        }
      }
      loads.push({
        occurrenceId: entry.occurrenceId,
        forceN,
        ...(atWorldPointM === undefined
          ? {}
          : { atWorldPointM: [...atWorldPointM] }),
      });
      continue;
    }
    if (entry.jointId === undefined || entry.efforts === undefined) {
      continue; // compileDynamicsLoads declined malformed series already.
    }
    jointEfforts.push({
      jointId: entry.jointId,
      effort: interpolate(entry.times, entry.efforts, t),
    });
  }
  return { loads, jointEfforts };
}
