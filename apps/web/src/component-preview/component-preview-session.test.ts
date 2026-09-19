/**
 * The preview bounds readout (the review fix for the seating-offset
 * disagreement): the "bounds = X × Y × Z mm" line must report the SEATED
 * assembly's union — the same extent the camera frames — not a re-union
 * of the raw per-body kernel bounds, which ignores the seating offsets
 * (the enclosure's un-displaced lid carries below-origin bosses that
 * inflate the raw z extent from the true seated 29.8 mm to 33.4 mm).
 */

import { describe, expect, it } from "vitest";
import { createRenderProjection, type RenderBounds } from "@slopcad/cad-core";

import {
  assemblyBounds,
  previewBoundsReadoutMm,
  previewCamera,
  type ComponentPreviewBody,
  type ComponentPreviewState,
} from "./component-preview-session";

/** The enclosure-shaped synthetic: a shell at the origin plus a lid built
 * at the origin (bosses below it) that seats onto the shell's rim. */
const SHELL: ComponentPreviewBody = {
  bodyId: "body_shell",
  bounds: { min: [0, 0, 0], max: [30, 22, 27.4] },
  name: "shell",
  volumeMm3: 10_000,
};
const LID: ComponentPreviewBody = {
  bodyId: "body_lid",
  bounds: { min: [3, 3, -6], max: [17, 17, 2.4] },
  name: "lid",
  volumeMm3: 500,
};
const SEATED_LID_OFFSET: readonly [number, number, number] = [2.5, 2.5, 27.4];
const NO_OFFSET: readonly [number, number, number] = [0, 0, 0];

/** A full preview state over the synthetic bodies with `assembly` seated. */
function syntheticState(assembly: RenderBounds): ComponentPreviewState {
  const projection = createRenderProjection([], previewCamera(assembly));
  if (!projection.ok) {
    throw new Error(
      `The synthetic projection was rejected: ${projection.error.message}`,
    );
  }
  return {
    assemblyBounds: assembly,
    bodies: [SHELL, LID],
    componentId: "synthetic-two-body",
    expectedVolumeMm3: SHELL.volumeMm3 + LID.volumeMm3,
    projection: projection.value,
    totalVolumeMm3: SHELL.volumeMm3 + LID.volumeMm3,
    triangles: 0,
    values: {},
  };
}

describe("the seated assembly bounds derivation", () => {
  it("seats each body's offset into the union (raw union differs)", () => {
    const seated = assemblyBounds([SHELL, LID], [NO_OFFSET, SEATED_LID_OFFSET]);
    // The lid rides the rim: z 21.4..29.8 sits above the shell's 27.4 rim
    // only for its top, and its below-origin bosses are displaced to 21.4.
    expect(seated.min).toEqual([0, 0, 0]);
    expect(seated.max[0]).toBeCloseTo(30);
    expect(seated.max[1]).toBeCloseTo(22);
    expect(seated.max[2]).toBeCloseTo(29.8);

    // Control: the RAW union (what the old readout computed — no offsets)
    // includes the lid's below-origin bosses at z = -6 and misses the
    // seated lid above the rim: a 33.4 mm extent, NOT the seated 29.8.
    const raw = assemblyBounds([SHELL, LID], [NO_OFFSET, NO_OFFSET]);
    expect(raw.min[2]).toBe(-6);
    expect(raw.max[2]).toBeCloseTo(27.4);
    expect(raw.max[2] - raw.min[2]).toBeCloseTo(33.4);
    expect(seated.max[2] - seated.min[2]).toBeCloseTo(29.8);
  });

  it("leaves single-body (origin-seated) components exactly at their bounds", () => {
    expect(assemblyBounds([SHELL], [NO_OFFSET])).toEqual(SHELL.bounds);
  });
});

describe("the preview bounds readout reports the seated extents", () => {
  it("reads the state's seated assembly bounds, not a raw per-body union", () => {
    const seated = assemblyBounds([SHELL, LID], [NO_OFFSET, SEATED_LID_OFFSET]);
    const readout = previewBoundsReadoutMm(syntheticState(seated));
    expect(readout).toBe("30.000 × 22.000 × 29.800");
    // The raw-union value (33.400 z) is exactly what must NOT be reported.
    expect(readout).not.toContain("33.400");
  });
});
