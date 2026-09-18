import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createFeatureId,
  type BodyId,
  type FeatureRecord,
  type SelectionReference,
} from "@slopcad/cad-core";

import { massPropertiesReadout } from "./mass-properties-inspection";

const PLATE_BODY: BodyId = createBodyId("body_plate");
const PAD_BODY: BodyId = createBodyId("body_extrude");
const TRANSLATE_FEATURE = createFeatureId("feat_translate_plate");

const FEATURES: readonly FeatureRecord[] = [
  {
    id: TRANSLATE_FEATURE,
    kind: "translate",
    inputs: [],
    outputs: [PLATE_BODY],
  },
];

/**
 * The plate scene's kernel-measured mass properties (Manifold's probed
 * 28-chord default inscribed bore): volume ≈ 5501.553 mm³, area ≈
 * 2351.111 mm².
 */
const PLATE_VOLUME = 5501.553107937856;
const PLATE_AREA = 2351.111048058981;

function readout(
  selected: readonly SelectionReference[],
  overrides: Partial<Parameters<typeof massPropertiesReadout>[0]> = {},
): ReturnType<typeof massPropertiesReadout> {
  return massPropertiesReadout({
    selected,
    features: FEATURES,
    sceneBodyId: PLATE_BODY,
    volume: PLATE_VOLUME,
    area: PLATE_AREA,
    ...overrides,
  });
}

describe("massPropertiesReadout", () => {
  it("formats the selected body's kernel-measured volume and area with unit suffixes", () => {
    expect(readout([{ kind: "body", bodyId: PLATE_BODY }])).toEqual({
      volumeText: "5501.553 mm³",
      areaText: "2351.111 mm²",
    });
  });

  it("resolves a selected feature through its single output body", () => {
    expect(
      readout([{ kind: "feature", featureId: TRANSLATE_FEATURE }]).volumeText,
    ).toBe("5501.553 mm³");
  });

  it("shows nothing before the first settled scene", () => {
    expect(
      readout([{ kind: "body", bodyId: PLATE_BODY }], {
        sceneBodyId: undefined,
        volume: undefined,
        area: undefined,
      }),
    ).toEqual({ volumeText: null, areaText: null });
  });

  it("shows nothing without a selection", () => {
    expect(readout([])).toEqual({ volumeText: null, areaText: null });
  });

  it("shows nothing when the selected body is not the measured scene body", () => {
    expect(readout([{ kind: "body", bodyId: PAD_BODY }])).toEqual({
      volumeText: null,
      areaText: null,
    });
  });

  it("follows the scene measurement, so a regeneration updates the text", () => {
    // The ⌀10 bore replaces the ⌀8 one: the readout follows the re-measured
    // scene without any further interaction. Values are the ⌀10 bore's
    // analytic pair (6000 − 250π mm³, 2200 + 50π mm²) — illustrative inputs,
    // not a kernel measurement.
    const next = readout([{ kind: "body", bodyId: PLATE_BODY }], {
      volume: 5214.601836602552,
      area: 2357.07963267949,
    });
    expect(next.volumeText).toBe("5214.602 mm³");
    expect(next.areaText).toBe("2357.080 mm²");
  });

  it("keeps the volume row honest when the scene carries no area measurement", () => {
    expect(
      readout([{ kind: "body", bodyId: PLATE_BODY }], { area: undefined }),
    ).toEqual({ volumeText: "5501.553 mm³", areaText: null });
  });

  it("shows both rows for the empty-solid measurement (0.000 mm³ / 0.000 mm²)", () => {
    const empty = readout([{ kind: "body", bodyId: PLATE_BODY }], {
      volume: 0,
      area: 0,
    });
    expect(empty.volumeText).toBe("0.000 mm³");
    expect(empty.areaText).toBe("0.000 mm²");
  });
});
