/**
 * The `/workbench-sim` fixture pipeline's unit battery (Phase 62c): the
 * demo document's compile-and-fold shape, the voxelization door's
 * analytic exactness over a hand-authored box soup (the voxelizer's own
 * fixture convention — dyadic coordinates, exact node counts, never a
 * tolerance), the committed-application bridge's counter semantics
 * through the REAL Phase 61d ledger, and the overlay derivation the
 * 62b family renders. No worker, no WebGL, no network: the pipeline is
 * pure, and the browser e2e (the render baselines + the session stage)
 * covers the hosted half.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SimDistanceGrid, SimOccupancyGrid } from "@slopcad/sim-core";

import {
  applySimNotification,
  createSimApplicationLedger,
  SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE,
  SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE,
} from "../cad-workbench/sim-application-ledger";
import {
  applySimFixtureField,
  buildSimFixtureField,
  type SimFixtureControls,
  simFixtureChunkStream,
  SIM_FIXTURE_BOOT_CONTROLS,
  SIM_FIXTURE_CHUNKS_PER_ROUND,
  SIM_FIXTURE_COARSE_SHAPE,
  SIM_FIXTURE_FINE_SHAPE,
  simFixtureOccupiedNodes,
  simFixtureOverlayOf,
  simFixtureResolutionOf,
  simFixtureShapeAt,
  simDemoDocument,
  stampSimAppliedCounters,
} from "./sim-grid-fixture";

/** An exact axis-aligned box soup: 8 vertices, 12 outward-CCW triangles. */
function boxTessellation(box: {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}): {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
} {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  return {
    positions: [
      x0,
      y0,
      z0, // 0
      x1,
      y0,
      z0, // 1
      x1,
      y1,
      z0, // 2
      x0,
      y1,
      z0, // 3
      x0,
      y0,
      z1, // 4
      x1,
      y0,
      z1, // 5
      x1,
      y1,
      z1, // 6
      x0,
      y1,
      z1, // 7
    ],
    indices: [
      0,
      3,
      2,
      0,
      2,
      1, // zMin, outward −z
      4,
      5,
      6,
      4,
      6,
      7, // zMax, outward +z
      0,
      1,
      5,
      0,
      5,
      4, // yMin, outward −y
      2,
      3,
      7,
      2,
      7,
      6, // yMax, outward +y
      0,
      4,
      7,
      0,
      7,
      3, // xMin, outward −x
      1,
      2,
      6,
      1,
      6,
      5, // xMax, outward +x
    ],
  };
}

/** The demo plate as a box soup: [−40, 40] × [−24, 24] × [0, 6]. */
const PLATE_BOX = boxTessellation({
  min: [-40, -24, 0],
  max: [40, 24, 6],
});

/** The SDF semantic's controls (the fine preset, distance field). */
const SDF_CONTROLS: SimFixtureControls = {
  resolutionId: "fine",
  signedDistance: true,
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the demo document (the cad-jsx model's fold)", () => {
  it("compiles to the plate-with-bore feature graph, deterministically", () => {
    const documentA = simDemoDocument();
    const documentB = simDemoDocument();
    expect(documentA.features.map((feature) => feature.kind)).toEqual([
      "extrude",
      "hole",
    ]);
    expect(documentA.bodies.map((body) => body.id)).toEqual([
      "body_sim-demo",
      "body_plate",
    ]);
    expect(JSON.stringify(documentA)).toBe(JSON.stringify(documentB));
  });
});

describe("the voxelization door over the fixture domain", () => {
  it("resolves the authored shapes for both presets", () => {
    expect(simFixtureShapeAt(2)).toEqual([...SIM_FIXTURE_FINE_SHAPE]);
    expect(simFixtureShapeAt(4)).toEqual([...SIM_FIXTURE_COARSE_SHAPE]);
    expect(simFixtureResolutionOf("fine").resolutionMm).toBe(2);
    expect(simFixtureResolutionOf("coarse").resolutionMm).toBe(4);
  });

  it("counts the plate's occupied nodes exactly at the fine preset", () => {
    const field = buildSimFixtureField(PLATE_BOX, SIM_FIXTURE_BOOT_CONTROLS);
    if (!field.ok) throw new Error(field.error.message);
    expect(field.field.semantic).toBe("occupancy");
    const grid = field.field.grid as SimOccupancyGrid;
    expect([...grid.shape]).toEqual([...SIM_FIXTURE_FINE_SHAPE]);
    // Nodes inside the plate box: x −40..40 step 2 (41), y −24..24
    // (25), z 0..6 (4) — exact closed-set arithmetic.
    expect(simFixtureOccupiedNodes(field.field.grid)).toBe(41 * 25 * 4);
    expect(field.field.block.id).toBe("sim-demo.occupancy");
    expect(field.field.block.unit).toBe("1");
  });

  it("signs the distance field negative inside, positive outside", () => {
    const field = buildSimFixtureField(PLATE_BOX, SDF_CONTROLS);
    if (!field.ok) throw new Error(field.error.message);
    expect(field.field.semantic).toBe("signed-distance");
    expect(field.field.block.unit).toBe("mm");
    expect(simFixtureOccupiedNodes(field.field.grid)).toBeNull();
    // The node at the plate's centre (i=25, j=17, k=5 → (0, 0, 4) mm):
    // 2 mm below the top face, inside — signed −0.002 m.
    const index = 25 + 51 * (17 + 35 * 5);
    const distance = field.field.grid as SimDistanceGrid;
    expect(distance.distanceM[index]).toBeCloseTo(-0.002, 15);
    // A margin node straight out in x (i=0, j=17, k=5 → (−50, 0, 4) mm):
    // 10 mm outside the plate's −x face, inside its y/z span — exact.
    const marginIndex = 0 + 51 * (17 + 35 * 5);
    expect(distance.distanceM[marginIndex]).toBeCloseTo(0.01, 12);
  });
});

describe("the committed-application bridge (law S6)", () => {
  it("advances the counter family once per applied chunk round", () => {
    const ledger = createSimApplicationLedger();
    const field = buildSimFixtureField(PLATE_BOX, SIM_FIXTURE_BOOT_CONTROLS);
    if (!field.ok) throw new Error(field.error.message);
    const committed = applySimFixtureField(ledger, field.field);
    expect(committed).not.toBeNull();
    if (committed === null) throw new Error("unreachable: checked above");
    expect(committed.notifications).toBe(SIM_FIXTURE_CHUNKS_PER_ROUND);
    expect(committed.fieldChunks).toBe(SIM_FIXTURE_CHUNKS_PER_ROUND);
    expect(committed.progressStep).toBeNull();
    expect(ledger.fields.get(field.field.block.id)?.roundsCompleted).toBe(1);

    // A re-publish (the control toggle's new round): chunk 0
    // re-establishes the stream and the full round applies again.
    const again = applySimFixtureField(ledger, field.field);
    expect(again?.notifications).toBe(SIM_FIXTURE_CHUNKS_PER_ROUND * 2);
    expect(again?.fieldChunks).toBe(SIM_FIXTURE_CHUNKS_PER_ROUND * 2);
    expect(ledger.fields.get(field.field.block.id)?.roundsCompleted).toBe(2);
  });

  it("moves nothing for a chunk that does not apply (a gap)", () => {
    const ledger = createSimApplicationLedger();
    const field = buildSimFixtureField(PLATE_BOX, SIM_FIXTURE_BOOT_CONTROLS);
    if (!field.ok) throw new Error(field.error.message);
    const chunks = simFixtureChunkStream(field.field.block);
    // Chunk 1 with no established stream: mid-stream, no commit.
    const stray = chunks[1];
    if (stray === undefined) throw new Error("the stream carries no chunks");
    expect(
      applySimNotification(ledger, { ...stray, kind: "field-chunk" }),
    ).toBeNull();
    expect(ledger.notifications).toBe(0);
    expect(ledger.fieldChunks).toBe(0);
  });

  it("stamps the attribute family on the settle root synchronously", () => {
    const root = document.createElement("div");
    root.id = "workbench-sim-root";
    document.body.append(root);
    stampSimAppliedCounters("workbench-sim-root", {
      notifications: 8,
      fieldChunks: 8,
      progressStep: null,
    });
    expect(root.getAttribute(SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE)).toBe("8");
    expect(root.getAttribute(SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE)).toBe("8");
  });
});

describe("the overlay derivation (the 62b family's props)", () => {
  it("paints occupancy at the mid-height node plane with the 0.5 iso", () => {
    const field = buildSimFixtureField(PLATE_BOX, SIM_FIXTURE_BOOT_CONTROLS);
    if (!field.ok) throw new Error(field.error.message);
    const overlay = simFixtureOverlayOf(field.field);
    expect(overlay.semantic).toBe("occupancy");
    expect(overlay.sliceAxis).toBe("z");
    // The z lattice: origin −6 mm, 10 nodes at 2 mm — the mid node
    // plane (k = 4) sits at z = 2 mm, inside the plate.
    expect(overlay.slicePositionMm).toBe(2);
    expect(overlay.thresholds).toEqual([0.5]);
    expect(overlay.valueRange).toEqual([0, 1]);
    expect(overlay.colormap.id).toBe("viridis");
    expect(overlay.field.range).toEqual([0, 1]);
  });

  it("paints the distance field with its own range and ±2 mm isos", () => {
    const field = buildSimFixtureField(PLATE_BOX, SDF_CONTROLS);
    if (!field.ok) throw new Error(field.error.message);
    const overlay = simFixtureOverlayOf(field.field);
    expect(overlay.semantic).toBe("signed-distance");
    expect(overlay.slicePositionMm).toBe(2);
    expect(overlay.thresholds).toEqual([-2, 0, 2]);
    expect(overlay.valueRange).toBeUndefined();
    expect(overlay.field.unit).toBe("mm");
  });
});
