/**
 * Exporter tests: byte-determinism pinned — the same field block always
 * exports to the identical .vti text, the same history table to the
 * identical CSV, and malformed input declines structured.
 */

import { describe, expect, it } from "vitest";

import { SIM_ERROR_CODES } from "./errors";
import { type SimHistoryTable, exportSimHistoryCsv } from "./export-csv";
import { exportSimFieldVti } from "./export-vtk";
import { type SimResultFieldBlock } from "./sim-result";

function requireOk<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The export test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

function block(): SimResultFieldBlock {
  return {
    id: "velocityMagnitude",
    unit: "mm/s",
    extent: [2, 2, 1],
    originMm: [0, 0, 0],
    spacingMm: [1, 1, 1],
    dataType: "float64",
    values: [1.5, 2.5, 3.5, 4.5],
  };
}

describe("the VTK .vti exporter", () => {
  it("emits a ParaView ImageData document with the exact pinned bytes", () => {
    const text = requireOk(exportSimFieldVti(block()), "the export");
    expect(text).toBe(
      `<?xml version="1.0"?>\n` +
        `<VTKFile type="ImageData" version="0.1" byte_order="LittleEndian">\n` +
        `  <ImageData WholeExtent="0 1 0 1 0 0" Origin="0 0 0" Spacing="1 1 1">\n` +
        `    <Piece Extent="0 1 0 1 0 0">\n` +
        `  <FieldData>\n    <DataArray type="String" Name="unit" NumberOfTuples="1" format="ascii">\n      mm/s\n    </DataArray>\n  </FieldData>\n` +
        `      <PointData Scalars="velocityMagnitude">\n` +
        `        <DataArray type="Float64" Name="velocityMagnitude" format="ascii" RangeMin="1.5" RangeMax="4.5">\n` +
        `          1.5 2.5 3.5 4.5\n` +
        `        </DataArray>\n` +
        `      </PointData>\n` +
        `    </Piece>\n` +
        `  </ImageData>\n` +
        `</VTKFile>\n`,
    );
  });

  it("is byte-deterministic across repeated exports", () => {
    const first = requireOk(exportSimFieldVti(block()), "export one");
    const second = requireOk(exportSimFieldVti(block()), "export two");
    expect(second).toBe(first);
  });

  it("omits the FieldData unit when the block carries none", () => {
    const text = requireOk(
      exportSimFieldVti({ ...block(), unit: undefined }),
      "the unitless export",
    );
    expect(text).not.toContain("FieldData");
  });

  it("declines non-finite values and mismatched extents", () => {
    const nonFinite = exportSimFieldVti({
      ...block(),
      values: [1, Number.POSITIVE_INFINITY, 3, 4],
    });
    expect(nonFinite.ok).toBe(false);
    if (nonFinite.ok) return;
    expect(nonFinite.error.code).toBe(SIM_ERROR_CODES.quantityInvalid);
    const mismatch = exportSimFieldVti({ ...block(), values: [1, 2, 3] });
    expect(mismatch.ok).toBe(false);
  });
});

describe("the history CSV exporter", () => {
  function table(): SimHistoryTable {
    return {
      columns: [
        { name: "time", unit: "s", samples: [0, 0.1, 0.25] },
        { name: "drag", unit: "N", samples: [1.25, 1.5, 1.75] },
      ],
    };
  }

  it("emits the header row and one row per sample, pinned", () => {
    const text = requireOk(exportSimHistoryCsv(table()), "the export");
    expect(text).toBe("time (s),drag (N)\n0,1.25\n0.1,1.5\n0.25,1.75\n");
  });

  it("renders exponent-form samples in canonical spelling, pinned", () => {
    // The formatter's exponent path through a real export: mantissa
    // trailing zeros trimmed, the exponent's own digits never touched.
    // These samples cover both historic corruptions — 1.23e-10 and 1e20
    // once lost a trailing exponent digit ("1.23000e-1", "1.00000e2"),
    // 3e-7 and 2.5e30 once kept padded mantissas ("3.00000e-7",
    // "2.50000e3").
    const text = requireOk(
      exportSimHistoryCsv({
        columns: [
          {
            name: "residual",
            unit: "1",
            samples: [1.23e-10, 1e20, 3e-7, 2.5e30],
          },
        ],
      }),
      "the exponent-form export",
    );
    expect(text).toBe("residual (1)\n1.23e-10\n1e20\n3e-7\n2.5e30\n");
  });

  it("is byte-deterministic across repeated exports", () => {
    const first = requireOk(exportSimHistoryCsv(table()), "export one");
    const second = requireOk(exportSimHistoryCsv(table()), "export two");
    expect(second).toBe(first);
  });

  it("declines ragged columns and labels needing quotes", () => {
    const ragged = exportSimHistoryCsv({
      columns: [
        { name: "time", unit: "s", samples: [0, 1] },
        { name: "drag", unit: "N", samples: [1] },
      ],
    });
    expect(ragged.ok).toBe(false);
    if (ragged.ok) return;
    expect(ragged.error.code).toBe(SIM_ERROR_CODES.quantityInvalid);
    const quoted = exportSimHistoryCsv({
      columns: [{ name: 'drag, "total"', unit: "N", samples: [1] }],
    });
    expect(quoted.ok).toBe(false);
  });
});
