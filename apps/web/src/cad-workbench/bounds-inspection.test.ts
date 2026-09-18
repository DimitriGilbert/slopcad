import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createFeatureId,
  type BodyId,
  type FeatureRecord,
  type RenderBounds,
  type SelectionReference,
} from "@slopcad/cad-core";

import { boundsReadout } from "./bounds-inspection";

const PLATE_BODY: BodyId = createBodyId("body_plate");
const PAD_BODY: BodyId = createBodyId("body_extrude");
const TRANSLATE_FEATURE = createFeatureId("feat_translate_plate");

/** The plate scene's measured bounds: `[0,30] × [0,20] × [0,10]` in mm. */
const PLATE_BOUNDS: RenderBounds = { min: [0, 0, 0], max: [30, 20, 10] };

const FEATURES: readonly FeatureRecord[] = [
  {
    id: TRANSLATE_FEATURE,
    kind: "translate",
    inputs: [],
    outputs: [PLATE_BODY],
  },
];

function readout(
  selected: readonly SelectionReference[],
  overrides: Partial<Parameters<typeof boundsReadout>[0]> = {},
): ReturnType<typeof boundsReadout> {
  return boundsReadout({
    selected,
    features: FEATURES,
    sceneBodyId: PLATE_BODY,
    bounds: PLATE_BOUNDS,
    tightBooleanBounds: true,
    ...overrides,
  });
}

describe("boundsReadout", () => {
  it("formats the selected body's kernel bounds with the unit suffix", () => {
    expect(readout([{ kind: "body", bodyId: PLATE_BODY }])).toEqual({
      text: "30.000 × 20.000 × 10.000 mm",
      tightness: "tight",
    });
  });

  it("resolves a selected feature through its single output body", () => {
    expect(
      readout([{ kind: "feature", featureId: TRANSLATE_FEATURE }]).text,
    ).toBe("30.000 × 20.000 × 10.000 mm");
  });

  it("shows nothing before the first settled scene", () => {
    expect(
      readout([{ kind: "body", bodyId: PLATE_BODY }], {
        sceneBodyId: undefined,
        bounds: undefined,
      }).text,
    ).toBeNull();
  });

  it("shows nothing without a selection", () => {
    expect(readout([]).text).toBeNull();
  });

  it("shows nothing when the selected body is not the measured scene body", () => {
    expect(readout([{ kind: "body", bodyId: PAD_BODY }]).text).toBeNull();
  });

  it("follows the scene measurement, so a regeneration updates the text", () => {
    const grown: RenderBounds = { min: [0, 0, 0], max: [30, 20, 30] };
    expect(
      readout([{ kind: "body", bodyId: PLATE_BODY }], { bounds: grown }).text,
    ).toBe("30.000 × 20.000 × 30.000 mm");
  });

  it("carries the kernel's declared bounds tightness verbatim", () => {
    expect(
      readout([{ kind: "body", bodyId: PLATE_BODY }], {
        tightBooleanBounds: false,
      }).tightness,
    ).toBe("possibly-conservative");
  });
});
