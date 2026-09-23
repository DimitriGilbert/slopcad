/**
 * The interference panel model tests (Phase 58): verdict pairing,
 * displayable numbers, isolation stamps/filters, and the prepared
 * snapshot exports' stable digests.
 */

import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createOccurrenceId,
  type ClearanceReport,
  type InterferenceReport,
} from "@slopcad/cad-core";

import {
  interferencePanelModel,
  interferencePairKey,
  isInstanceIsolated,
  isolationStamp,
  prepareSnapshotExports,
  type IsolatedPair,
} from "./interference-panel";

const OCCURRENCES = {
  plate: createOccurrenceId("occ_plate"),
  block: createOccurrenceId("occ_block"),
  sheet: createOccurrenceId("occ_sheet"),
  far: createOccurrenceId("occ_far"),
} as const;

const REPORT: InterferenceReport = {
  pairs: [
    {
      firstPath: [OCCURRENCES.plate],
      firstBodyId: createBodyId("body_plate"),
      secondPath: [OCCURRENCES.block],
      secondBodyId: createBodyId("body_block"),
      volume: 5400,
      firstBounds: { min: [0, 0, 0], max: [60, 40, 12] },
      secondBounds: { min: [45, 0, 0], max: [75, 30, 30] },
    },
  ],
  skipped: [
    {
      firstPath: [OCCURRENCES.plate],
      secondPath: [OCCURRENCES.sheet],
      reason: "kernel-declined",
    },
  ],
  checkedPairs: 2,
  tolerance: 0.001,
};

const CLEARANCES: ClearanceReport = {
  clearances: [
    {
      firstPath: [OCCURRENCES.plate],
      secondPath: [OCCURRENCES.far],
      distance: 140,
    },
  ],
  sampledTriangles: 24,
  precision: "sampled-vertex-triangle",
};

const LABELS: Record<string, string> = {
  occ_plate: "plate",
  occ_block: "block",
  occ_sheet: "sheet",
  occ_far: "far",
};

const labelOf = (occurrenceId: string): string =>
  LABELS[occurrenceId] ?? occurrenceId;

describe("interference panel model", () => {
  it("is idle with empty counts before any report exists", () => {
    const model = interferencePanelModel({
      interference: null,
      clearances: null,
      labelOf,
    });
    expect(model.status).toBe("idle");
    expect(model.rows).toEqual([]);
    expect(model.pairCount).toBe(0);
  });

  it("pairs each clearance with its verdict by path key", () => {
    const model = interferencePanelModel({
      interference: REPORT,
      clearances: CLEARANCES,
      labelOf,
    });
    expect(model.status).toBe("reported");
    expect(model.pairCount).toBe(1);
    expect(model.skippedCount).toBe(1);
    expect(model.checkedCount).toBe(2);
    expect(model.clearanceCount).toBe(1);
    // Interfering rows first, then skipped, then clear.
    expect(model.rows.map((row) => row.verdict)).toEqual([
      "interferes",
      "skipped",
      "clear",
    ]);
    const [interferes, skipped, clear] = model.rows;
    expect(interferes?.volumeText).toBe("5400.000 mm³");
    expect(interferes?.clearanceText).toBeNull();
    expect(skipped?.reasonText).toBe("kernel-declined");
    expect(clear?.clearanceText).toBe("140.000 mm");
    expect(clear?.volumeText).toBeNull();
  });

  it("never shows a clearance next to an interfering pair", () => {
    const withOverlappingClearance: ClearanceReport = {
      clearances: [
        {
          firstPath: [OCCURRENCES.plate],
          secondPath: [OCCURRENCES.block],
          distance: 0,
        },
      ],
      sampledTriangles: 24,
      precision: "sampled-vertex-triangle",
    };
    const model = interferencePanelModel({
      interference: REPORT,
      clearances: withOverlappingClearance,
      labelOf,
    });
    expect(model.rows.filter((row) => row.verdict === "clear")).toHaveLength(0);
  });

  it("stamps and filters isolation", () => {
    expect(isolationStamp(undefined)).toBe("none");
    const pair: IsolatedPair = { firstId: "occ_plate", secondId: "occ_block" };
    expect(isolationStamp(pair)).toBe("occ_plate|occ_block");
    expect(isInstanceIsolated("occ_plate", pair)).toBe(true);
    expect(isInstanceIsolated("occ_block", pair)).toBe(true);
    expect(isInstanceIsolated("occ_far", pair)).toBe(false);
    expect(isInstanceIsolated("occ_far", undefined)).toBe(true);
  });

  it("prepares both exports with stable digests and byte counts", () => {
    const prepared = prepareSnapshotExports({
      documentId: "doc_panel_test",
      interference: REPORT,
      clearances: CLEARANCES,
      labelOf,
      nameStem: "interference-snapshot",
    });
    expect(prepared.json.name).toBe("interference-snapshot.json");
    expect(prepared.html.name).toBe("interference-snapshot.html");
    expect(prepared.json.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(prepared.json.digest).not.toBe(prepared.html.digest);
    expect(prepared.json.bytes).toBeGreaterThan(0);
    const again = prepareSnapshotExports({
      documentId: "doc_panel_test",
      interference: REPORT,
      clearances: CLEARANCES,
      labelOf,
      nameStem: "interference-snapshot",
    });
    expect(again.json.digest).toBe(prepared.json.digest);
    expect(again.json.bytes).toBe(prepared.json.bytes);
    expect(again.json.text).toBe(prepared.json.text);
  });

  it("keys pairs by the joined path", () => {
    expect(interferencePairKey(["a", "b"])).toBe("a/b");
    expect(interferencePairKey(["a"])).toBe("a");
  });
});
