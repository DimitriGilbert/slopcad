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
  exportSimResultForceHistoryCsv,
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
