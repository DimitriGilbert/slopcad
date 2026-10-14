import { describe, expect, it } from "vitest";
import type { SimResult } from "@slopcad/sim-core";

import { createSimApplicationLedger } from "../cad-workbench/sim-application-ledger";
import {
  applySimFieldDiff,
  simCurveOverlayOf,
  simCurvePolylinePoints,
  SIM_COMPARE_CHUNKS_PER_ROUND,
  simFieldDiffOf,
} from "./sim-compare";

/**
 * The comparison surface's pure core, pinned: the curve overlay derives
 * both runs' drag/lift against one shared window per quantity; the
 * field diff is the per-node same-geometry difference with stated
 * norms; mismatched geometry or units decline loudly; and the diff's
 * chunk stream applies through the Phase 61d ledger as one committed
 * round (law S6 — overlay application IS committed application).
 */

function run(
  hash: string,
  drag: number[],
  lift: number[],
  speed: number[],
  extent: readonly [number, number, number] = [3, 2, 1],
  unit = "mm/s",
): SimResult {
  return {
    summary: {
      schemaVersion: 1,
      scenarioSnapshotHash: hash,
      status: "completed",
      regime: { qualitative: [] },
      quantities: [],
    },
    fields: [
      {
        id: "speed",
        unit,
        extent,
        originMm: [0, 0, 0],
        spacingMm: [4, 4, 4],
        dataType: "float32",
        values: speed,
      },
    ],
    histories: [
      { name: "drag", unit: "N", samples: drag },
      { name: "lift", unit: "N", samples: lift },
    ],
  };
}

describe("the run comparison surface (curve overlay)", () => {
  it("lays both runs' drag and lift over one shared window per quantity", () => {
    const a = run("aaaa0001", [1, 2, 3], [0, 1, 0], [10, 20, 30, 40, 50, 60]);
    const b = run("bbbb0002", [2, 4, 6], [0, -1, 0], [12, 22, 30, 48, 50, 66]);
    const overlay = simCurveOverlayOf(a, b);
    expect(overlay.ok).toBe(true);
    if (!overlay.ok) throw new Error(overlay.error.message);
    // The shared window spans BOTH runs: drag [1, 6], lift [−1, 1].
    const drag = overlay.value.quantities[0];
    const lift = overlay.value.quantities[1];
    expect(drag?.name).toBe("drag");
    expect(drag?.sharedMin).toBe(1);
    expect(drag?.sharedMax).toBe(6);
    expect(lift?.sharedMin).toBe(-1);
    expect(lift?.sharedMax).toBe(1);
    // Four curves — both quantities, both runs — in fixed order.
    expect(overlay.value.series.map((series) => series.key)).toEqual([
      "drag-a",
      "drag-b",
      "lift-a",
      "lift-b",
    ]);
    expect(overlay.value.steps).toBe(3);
  });

  it("maps samples onto the panel deterministically, with a flat window at mid-height", () => {
    const rising = simCurvePolylinePoints([0, 5, 10], 0, 10, 100, 50);
    expect(rising).toBe("0.00,50.00 50.00,25.00 100.00,0.00");
    // A flat window (identical min and max) never divides by zero.
    expect(simCurvePolylinePoints([3, 3, 3], 3, 3, 100, 50)).toBe(
      "0.00,25.00 50.00,25.00 100.00,25.00",
    );
  });

  it("declines loudly when a run lacks the force pair", () => {
    const a = run("aaaa0001", [1], [0], [1, 2]);
    const incomplete: SimResult = {
      ...a,
      histories: [{ name: "drag", unit: "N", samples: [1] }],
    };
    const declined = simCurveOverlayOf(a, incomplete);
    expect(declined.ok).toBe(false);
    if (declined.ok) throw new Error("expected a decline");
    expect(declined.error.code).toBe("sim/compare-history-missing");
  });
});

describe("the run comparison surface (field diff)", () => {
  it("diffs the same field per node with stated norms and a symmetric window", () => {
    const a = run("aaaa0001", [1], [0], [10, 20, 30, 40, 50, 60]);
    const b = run("bbbb0002", [1], [0], [10, 22, 30, 40, 50, 66]);
    const diff = simFieldDiffOf(a, b, "speed");
    expect(diff.ok).toBe(true);
    if (!diff.ok) throw new Error(diff.error.message);
    // A − B per node: the two known-different entries are −2 and −6.
    expect(diff.value.block.values).toEqual([0, -2, 0, 0, 0, -6]);
    expect(diff.value.blockId).toBe("speed-diff");
    expect(diff.value.unit).toBe("mm/s");
    // ‖A−B‖₂/‖A‖₂ and the peak over ‖A‖∞, hand-computed.
    const l2 = Math.sqrt((4 + 36) / (100 + 400 + 900 + 1600 + 2500 + 3600));
    expect(diff.value.l2Relative).toBeCloseTo(l2, 12);
    expect(diff.value.linfRelative).toBeCloseTo(6 / 60, 12);
    expect(diff.value.linfAbs).toBe(6);
    expect(diff.value.valueRange).toEqual([-6, 6]);
  });

  it("declines on mismatched grid geometry, never resampling", () => {
    const a = run("aaaa0001", [1], [0], [10, 20]);
    const b = run("bbbb0002", [1], [0], [10, 20, 30, 40], [4, 2, 1]);
    const declined = simFieldDiffOf(a, b, "speed");
    expect(declined.ok).toBe(false);
    if (declined.ok) throw new Error("expected a decline");
    expect(declined.error.code).toBe("sim/compare-geometry-mismatch");
  });

  it("declines on mismatched units and on an absent field", () => {
    const a = run("aaaa0001", [1], [0], [10, 20]);
    const wrongUnit = run("bbbb0002", [1], [0], [10, 20], [3, 2, 1], "Pa");
    const unitDecline = simFieldDiffOf(a, wrongUnit, "speed");
    expect(unitDecline.ok).toBe(false);
    if (unitDecline.ok) throw new Error("expected a decline");
    expect(unitDecline.error.code).toBe("sim/compare-unit-mismatch");

    const missing = simFieldDiffOf(a, { ...a, fields: [] }, "speed");
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected a decline");
    expect(missing.error.code).toBe("sim/compare-field-missing");
  });

  it("applies the diff through the ledger as one committed chunk round", () => {
    // A block large enough for the full 8-chunk round shape.
    const valuesA = Array.from({ length: 24 }, (_, i) => i + 1);
    const valuesB = valuesA.map((value) => value + (value % 3 === 0 ? 2 : 0));
    const a = run("aaaa0001", [1], [0], valuesA);
    const b = run("bbbb0002", [1], [0], valuesB);
    const diff = simFieldDiffOf(a, b, "speed");
    if (!diff.ok) throw new Error(diff.error.message);
    const ledger = createSimApplicationLedger();
    const committed = applySimFieldDiff(ledger, diff.value);
    expect(committed).not.toBeNull();
    expect(committed?.fieldChunks).toBe(SIM_COMPARE_CHUNKS_PER_ROUND);
    expect(committed?.notifications).toBe(SIM_COMPARE_CHUNKS_PER_ROUND);
    expect(ledger.fields.get("speed-diff")?.roundsCompleted).toBe(1);
    // A repeated application is a SECOND committed round of the same
    // stream — the ledger's own (re-)establishment rule.
    const again = applySimFieldDiff(ledger, diff.value);
    expect(again?.fieldChunks).toBe(SIM_COMPARE_CHUNKS_PER_ROUND * 2);
    expect(ledger.fields.get("speed-diff")?.roundsCompleted).toBe(2);
    // A block smaller than the round shape still applies: one chunk
    // per value, the reassembler's framing law.
    const small = simFieldDiffOf(
      run("aaaa0001", [1], [0], [10, 20, 30, 40, 50, 60]),
      run("bbbb0002", [1], [0], [10, 22, 30, 40, 50, 66]),
      "speed",
    );
    if (!small.ok) throw new Error(small.error.message);
    const smallLedger = createSimApplicationLedger();
    const smallCommitted = applySimFieldDiff(smallLedger, small.value);
    expect(smallCommitted?.fieldChunks).toBe(6);
  });
});
