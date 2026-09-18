/**
 * The MEASURE tool (Phase 13): two picks, one distance. The first click
 * (`pointer-up` over geometry) anchors the measurement; the second completes
 * it with the Euclidean distance between the two world points, computed in
 * canonical millimetres — the projection contract's world frame — and
 * surfaced as a Phase 4 dimensional value (`LengthValue`, unit `mm`), so the
 * result carries its unit by construction and converts through the public
 * dimensional API (`valueIn`) instead of by convention.
 *
 * The tool is a two-stage gesture machine: `awaiting-first` →
 * `awaiting-second` (first point stored as plain tool state) → completed.
 * Misses are no-ops; keyboard and pointer-down/move are ignored — measure is
 * deliberately a pick-pair tool. The completion detail carries the distance
 * AND both endpoints, so a host can render the measurement as data (label,
 * overlay, log) without re-deriving anything.
 */

import type { ToolInputEvent } from "./tool-events";
import type { CadTool, ToolTransition } from "./tool-manager";

import { type RenderVector3 } from "./projection";
import { length, type LengthValue } from "./dimensional";

/** The measure tool's two-stage gesture state. */
export type MeasureToolState =
  | { readonly stage: "awaiting-first" }
  | {
      readonly stage: "awaiting-second";
      /** The anchored first point (canonical millimetres). */
      readonly from: RenderVector3;
    };

const AWAITING_FIRST: MeasureToolState = Object.freeze({
  stage: "awaiting-first",
});

/** The tool id of {@link measureTool}. */
export const MEASURE_TOOL_ID = "measure";

function distanceBetween(from: RenderVector3, to: RenderVector3): LengthValue {
  return length(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]));
}

/**
 * The MEASURE tool: two geometry picks complete with the distance between
 * the picked world points as a canonical-millimetre dimensional value.
 */
export const measureTool: CadTool<MeasureToolState> = {
  id: MEASURE_TOOL_ID,
  initialState: AWAITING_FIRST,
  onEvent(
    state: MeasureToolState,
    event: ToolInputEvent,
    // No context: measure is a pure pick-pair computation over event data.
  ): ToolTransition<MeasureToolState> {
    if (
      event.type !== "pointer-up" ||
      event.pick === null ||
      event.point === null
    ) {
      return { state, phase: "active" };
    }
    if (state.stage === "awaiting-first") {
      return {
        state: { stage: "awaiting-second", from: event.point },
        phase: "active",
      };
    }
    const to = event.point;
    return {
      state: AWAITING_FIRST,
      phase: "completed",
      detail: {
        kind: "measurement",
        distance: distanceBetween(state.from, to),
        from: state.from,
        to,
      },
    };
  },
};
