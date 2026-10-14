/**
 * The workbench export path's tests (Phase 63c, law S7): the decimated
 * `.vti` field series and the force-history CSV produced from a stored
 * run — deterministic bytes (the same result exports to the identical
 * files), the decimation honesty stated in every file's metadata, one
 * file per field block with provenance-keyed names, and the CSV's
 * step-first column layout.
 */

import { describe, expect, it } from "vitest";
import type { SimResult } from "@slopcad/sim-core";

import {
  SIM_EXPORT_DEFAULT_VTI_DECIMATION,
  exportSimResultCombustionCsvs,
  exportSimResultForceHistoryCsv,
  exportSimResultJointHistoryCsv,
  exportSimResultSummaryCsv,
  exportSimResultVtiSeries,
} from "./sim-exports";

/** A stored-run fixture: the field family and histories a flow run carries. */
function storedResult(): SimResult {
  return {
    summary: {
      schemaVersion: 1,
      scenarioSnapshotHash: "0a1b2c3d",
      status: "completed",
      regime: { prandtl: 0.7, qualitative: [] },
      quantities: [{ name: "mean-drag-force", value: 0.5, unit: "N" }],
    },
    fields: [
      {
        id: "speed",
        unit: "mm/s",
        extent: [4, 4, 1],
        originMm: [0, 0, 3],
        spacingMm: [1, 1, 1],
        dataType: "float32",
        values: Array.from({ length: 16 }, (_, index) => index + 0.5),
      },
      {
        id: "pressure",
        unit: "Pa",
        extent: [4, 4, 1],
        originMm: [0, 0, 3],
        spacingMm: [1, 1, 1],
        dataType: "float32",
        values: Array.from({ length: 16 }, (_, index) => index - 8),
      },
    ],
    histories: [
      {
        name: "drag",
        unit: "N/m",
        samples: [0.1, 0.2, 0.3],
      },
      {
        name: "lift",
        unit: "N/m",
        samples: [-0.01, 0.0, 0.01],
      },
    ],
  };
}

describe("exportSimResultVtiSeries", () => {
  it("exports one honest decimated file per field block, deterministically", () => {
    const first = exportSimResultVtiSeries(storedResult());
    const second = exportSimResultVtiSeries(storedResult());
    expect(second).toEqual(first);
    expect(first.map((file) => file.filename)).toEqual([
      "0a1b2c3d-speed-dec2.vti",
      "0a1b2c3d-pressure-dec2.vti",
    ]);
    for (const file of first) {
      expect(file.text).toContain('Name="decimation"');
      expect(file.text).toContain("2x2x2");
      // The default decimation thinned the 4×4 lattice to 2×2.
      expect(file.text).toContain('WholeExtent="0 1 0 1 0 0"');
    }
    // Full fidelity on request stays full, still marked.
    const full = exportSimResultVtiSeries(storedResult(), 1);
    expect(full[0]?.filename).toBe("0a1b2c3d-speed-dec1.vti");
    expect(full[0]?.text).toContain('WholeExtent="0 3 0 3 0 0"');
    expect(full[0]?.text).toContain("1x1x1");
    expect(SIM_EXPORT_DEFAULT_VTI_DECIMATION).toBe(2);
  });
});

describe("exportSimResultForceHistoryCsv", () => {
  it("emits the step-first table through the 61 CSV exporter, deterministically", () => {
    const first = exportSimResultForceHistoryCsv(storedResult());
    const second = exportSimResultForceHistoryCsv(storedResult());
    expect(second).toBe(first);
    expect(first).toBe(
      [
        "step (1),drag (N/m),lift (N/m)",
        "1,0.1,-0.01",
        "2,0.2,0",
        "3,0.3,0.01",
        "",
      ].join("\n"),
    );
    expect(
      exportSimResultForceHistoryCsv({
        ...storedResult(),
        histories: [],
      }),
    ).toBeNull();
  });
});

describe("exportSimResultJointHistoryCsv", () => {
  it("emits the time-first joint table, joint series only, deterministically", () => {
    const result = {
      ...storedResult(),
      histories: [
        { name: "time", unit: "s", samples: [0.04, 0.08] },
        {
          name: "joint:jnt_crank:dof0:position",
          unit: "rad",
          samples: [0.5, 1.0],
        },
        {
          name: "joint:jnt_crank:dissipated-power",
          unit: "W",
          samples: [0.01, 0.02],
        },
        { name: "energy:kinetic", unit: "J", samples: [1, 2] },
      ],
    };
    const first = exportSimResultJointHistoryCsv(result);
    const second = exportSimResultJointHistoryCsv(result);
    expect(second).toBe(first);
    expect(first).toBe(
      [
        "time (s),joint:jnt_crank:dof0:position (rad),joint:jnt_crank:dissipated-power (W)",
        "0.04,0.5,0.01",
        "0.08,1,0.02",
        "",
      ].join("\n"),
    );
    // A run with no joint series (the flow/thermal families) exports
    // nothing through THIS door — never a fabricated table.
    expect(exportSimResultJointHistoryCsv(storedResult())).toBeNull();
  });
});

describe("exportSimResultCombustionCsvs", () => {
  it("emits the crank-first cycle table and the axis-first sweep table, deterministically", () => {
    const result = {
      ...storedResult(),
      histories: [
        { name: "crank-angle", unit: "deg", samples: [-180, 0] },
        { name: "pressure", unit: "bar", samples: [1, 60] },
        { name: "sweep:spark-timing-btdc", unit: "deg", samples: [10, 20] },
        { name: "sweep:imep", unit: "Pa", samples: [1.1e6, 1.2e6] },
      ],
    };
    const first = exportSimResultCombustionCsvs(result);
    const second = exportSimResultCombustionCsvs(result);
    expect(second).toEqual(first);
    expect(first.length).toBe(2);
    const cycle = first[0];
    const sweep = first[1];
    if (cycle === undefined || sweep === undefined) return;
    expect(cycle.filename).toContain("-cycle.csv");
    expect(cycle.text.split("\n")[0]).toBe("crank-angle (deg),pressure (bar)");
    expect(sweep.filename).toContain("-sweep.csv");
    expect(sweep.text.split("\n")[0]).toBe(
      "sweep:spark-timing-btdc (deg),sweep:imep (Pa)",
    );
  });

  it("emits the time-first fire table for stove runs, nothing for other families", () => {
    const stove = {
      ...storedResult(),
      histories: [
        { name: "time", unit: "s", samples: [0, 1] },
        { name: "fire:progress", unit: "1", samples: [0, 1] },
      ],
    };
    const files = exportSimResultCombustionCsvs(stove);
    expect(files.length).toBe(1);
    const fire = files[0];
    if (fire === undefined) return;
    expect(fire.filename).toContain("-fire.csv");
    expect(fire.text.split("\n")[0]).toBe("time (s),fire:progress (1)");
    // A result whose series carry neither family exports nothing.
    expect(exportSimResultCombustionCsvs(storedResult())).toEqual([]);
  });
});

describe("exportSimResultSummaryCsv", () => {
  it("emits the one-row-per-quantity summary table, deterministically", () => {
    const first = exportSimResultSummaryCsv(storedResult());
    const second = exportSimResultSummaryCsv(storedResult());
    expect(second).toBe(first);
    // One `name,value,unit` row per projected quantity — the statics
    // run's machine-readable table (its histories are empty).
    expect(first).toBe(
      ["name,value,unit", "mean-drag-force,0.5,N", ""].join("\n"),
    );
    // A summary with no quantities exports nothing through THIS door —
    // never a fabricated table.
    expect(
      exportSimResultSummaryCsv({
        ...storedResult(),
        summary: { ...storedResult().summary, quantities: [] },
      }),
    ).toBeNull();
  });
});
