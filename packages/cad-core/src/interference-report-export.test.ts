/**
 * Interference snapshot export tests (Phase 58): the deterministic
 * JSON/HTML serializations — byte identity for identical snapshots,
 * canonicalized numbers, escaped host labels, fixed key order, and the
 * djb2 change-detector digest.
 */

import { describe, expect, it } from "vitest";

import {
  buildInterferenceSnapshot,
  createBodyId,
  createOccurrenceId,
  formatSnapshotNumber,
  interferenceSnapshotDigest,
  INTERFERENCE_SNAPSHOT_KIND,
  INTERFERENCE_SNAPSHOT_VERSION,
  serializeInterferenceSnapshotHtml,
  serializeInterferenceSnapshotJson,
  type InterferenceReport,
} from "./index";

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
      firstBounds: {
        min: [0, 0, 0],
        max: [60, 40, 12],
      },
      secondBounds: {
        min: [45, 0, 0],
        max: [75, 30, 30],
      },
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

const LABELS: Record<string, string> = {
  occ_plate: "plate",
  occ_block: `block <&"special">`,
  occ_sheet: "sheet",
};

function labelOf(occurrenceId: string): string {
  return LABELS[occurrenceId] ?? occurrenceId;
}

describe("interference snapshot export", () => {
  it("serializes identically twice (byte determinism)", () => {
    const snapshot = buildInterferenceSnapshot({
      documentId: "doc_snapshot_test",
      interference: REPORT,
      labelOf,
    });
    const first = serializeInterferenceSnapshotJson(snapshot);
    const second = serializeInterferenceSnapshotJson(snapshot);
    expect(first).toBe(second);
    expect(first).toContain('"kind": "slopcad-interference-snapshot"');
    expect(first).toContain('"documentId": "doc_snapshot_test"');
    expect(first).toContain('"volume": 5400');
    expect(first).toContain('"tolerance": 0.001');
  });

  it("writes the snapshot envelope and counts", () => {
    const snapshot = buildInterferenceSnapshot({
      documentId: "doc_snapshot_test",
      interference: REPORT,
      labelOf,
    });
    expect(snapshot.kind).toBe(INTERFERENCE_SNAPSHOT_KIND);
    expect(snapshot.version).toBe(INTERFERENCE_SNAPSHOT_VERSION);
    expect(snapshot.interferencePairs).toBe(1);
    expect(snapshot.skippedPairs).toBe(1);
    expect(snapshot.checkedPairs).toBe(2);
    expect(snapshot.pairs[0]?.firstLabel).toBe("plate");
    expect(snapshot.pairs[0]?.secondLabel).toBe(`block <&"special">`);
    expect(snapshot.skipped[0]?.reason).toBe("kernel-declined");
  });

  it("carries clearance rows with labels when a clearance report rides along", () => {
    const snapshot = buildInterferenceSnapshot({
      documentId: "doc_snapshot_test",
      interference: REPORT,
      clearances: {
        clearances: [
          {
            firstPath: [OCCURRENCES.plate],
            secondPath: [OCCURRENCES.far],
            distance: 140,
          },
        ],
        sampledTriangles: 24,
        precision: "sampled-vertex-triangle",
      },
      labelOf,
    });
    expect(snapshot.clearances).toHaveLength(1);
    expect(snapshot.clearances[0]).toMatchObject({
      first: "occ_plate",
      second: "occ_far",
      firstLabel: "plate",
      distance: 140,
    });
    const json = serializeInterferenceSnapshotJson(snapshot);
    expect(json).toContain('"clearancePrecision": "sampled-vertex-triangle"');
  });

  it("escapes host labels in the HTML template", () => {
    const html = serializeInterferenceSnapshotHtml(
      buildInterferenceSnapshot({
        documentId: "doc_snapshot_test",
        interference: REPORT,
        labelOf,
      }),
    );
    expect(html).toContain(`block &lt;&amp;&quot;special&quot;&gt;`);
    expect(html).not.toContain(`<&"special">`);
    expect(html).toContain(`<td class="num">5400</td>`);
    expect(html).toContain("Interference snapshot");
    // An empty table renders its honest "none" row.
    expect(html).toContain(`<td colspan="3">none</td>`);
  });

  it("is script-free, clock-free, and stable across serializations", () => {
    const snapshot = buildInterferenceSnapshot({
      documentId: "doc_snapshot_test",
      interference: REPORT,
      labelOf,
    });
    const first = serializeInterferenceSnapshotHtml(snapshot);
    const second = serializeInterferenceSnapshotHtml(snapshot);
    expect(first).toBe(second);
    expect(first).not.toContain("<script");
    expect(first).not.toContain("Date");
  });

  it("canonicalizes numbers and refuses non-finite ones", () => {
    expect(formatSnapshotNumber(5400)).toBe("5400");
    expect(formatSnapshotNumber(0.5)).toBe("0.5");
    expect(formatSnapshotNumber(-0)).toBe("0");
    expect(formatSnapshotNumber(1e-9)).toBe("0.000000001");
    expect(() => formatSnapshotNumber(Number.NaN)).toThrow();
    expect(() => formatSnapshotNumber(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("digests identical bytes identically and distinguishes different ones", () => {
    const snapshot = buildInterferenceSnapshot({
      documentId: "doc_snapshot_test",
      interference: REPORT,
      labelOf,
    });
    const jsonDigest = interferenceSnapshotDigest(
      serializeInterferenceSnapshotJson(snapshot),
    );
    expect(jsonDigest).toBe(
      interferenceSnapshotDigest(serializeInterferenceSnapshotJson(snapshot)),
    );
    expect(jsonDigest).toMatch(/^[0-9a-f]{8}$/);
    const htmlDigest = interferenceSnapshotDigest(
      serializeInterferenceSnapshotHtml(snapshot),
    );
    expect(htmlDigest).not.toBe(jsonDigest);
  });
});
