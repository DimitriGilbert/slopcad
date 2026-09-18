import { describe, expect, it } from "vitest";

import {
  boundsExtents,
  createBodyId,
  createFeatureId,
  formatBoundsExtents,
  type FeatureRecord,
  type RenderBounds,
  selectedBoundsBody,
  valueIn,
} from "./index";

/** The plate fixture's bounds: `[0,30] × [0,20] × [0,10]` in mm. */
const PLATE_BOUNDS: RenderBounds = {
  min: [0, 0, 0],
  max: [30, 20, 10],
};

const PLATE_BODY = createBodyId("body_plate");
const PAD_BODY = createBodyId("body_pad");
const TRANSLATE_FEATURE = createFeatureId("feat_translate");
const SPLIT_FEATURE = createFeatureId("feat_split");

/** The feature table the selection-resolution tests run against. */
const FEATURES: readonly FeatureRecord[] = [
  {
    id: TRANSLATE_FEATURE,
    kind: "translate",
    inputs: [],
    outputs: [PLATE_BODY],
  },
  {
    id: SPLIT_FEATURE,
    kind: "split",
    inputs: [],
    outputs: [PLATE_BODY, PAD_BODY],
  },
];

describe("boundsExtents", () => {
  it("measures the axis extents as canonical-millimetre lengths", () => {
    const [x, y, z] = boundsExtents(PLATE_BOUNDS);
    expect(valueIn(x, "mm")).toBe(30);
    expect(valueIn(y, "mm")).toBe(20);
    expect(valueIn(z, "mm")).toBe(10);
    expect(x.unit).toBe("mm");
    expect(y.unit).toBe("mm");
    expect(z.unit).toBe("mm");
  });

  it("measures extents from a non-origin minimum", () => {
    const [x, y, z] = boundsExtents({ min: [1, 2, 3], max: [11, 22, 13] });
    expect(valueIn(x, "mm")).toBe(10);
    expect(valueIn(y, "mm")).toBe(20);
    expect(valueIn(z, "mm")).toBe(10);
  });
});

describe("formatBoundsExtents", () => {
  it("renders the fixtures' `30.000 × 20.000 × 10.000` extents form", () => {
    expect(formatBoundsExtents(PLATE_BOUNDS)).toBe("30.000 × 20.000 × 10.000");
  });

  it("renders fractional extents at three decimals", () => {
    expect(
      formatBoundsExtents({ min: [0, 0, 0], max: [2.5, 3.25, 1.125] }),
    ).toBe("2.500 × 3.250 × 1.125");
  });
});

describe("selectedBoundsBody", () => {
  it("resolves a body reference to its body", () => {
    expect(selectedBoundsBody([{ kind: "body", bodyId: PLATE_BODY }], [])).toBe(
      PLATE_BODY,
    );
  });

  it("resolves a solid reference to its body", () => {
    expect(
      selectedBoundsBody([{ kind: "solid", bodyId: PLATE_BODY }], []),
    ).toBe(PLATE_BODY);
  });

  it("resolves a synthetic face reference to its body", () => {
    expect(
      selectedBoundsBody(
        [{ kind: "face", bodyId: PLATE_BODY, regeneration: 0, faceIndex: 2 }],
        [],
      ),
    ).toBe(PLATE_BODY);
  });

  it("resolves a feature reference through its single output body", () => {
    expect(
      selectedBoundsBody(
        [{ kind: "feature", featureId: TRANSLATE_FEATURE }],
        FEATURES,
      ),
    ).toBe(PLATE_BODY);
  });

  it("leaves a multi-output feature unresolved", () => {
    expect(
      selectedBoundsBody(
        [{ kind: "feature", featureId: SPLIT_FEATURE }],
        FEATURES,
      ),
    ).toBeUndefined();
  });

  it("leaves an unknown feature reference unresolved", () => {
    expect(
      selectedBoundsBody(
        [{ kind: "feature", featureId: createFeatureId("feat_unknown") }],
        FEATURES,
      ),
    ).toBeUndefined();
  });

  it("collapses references that address the same body into that body", () => {
    expect(
      selectedBoundsBody(
        [
          { kind: "body", bodyId: PLATE_BODY },
          { kind: "face", bodyId: PLATE_BODY, regeneration: 0, faceIndex: 1 },
        ],
        FEATURES,
      ),
    ).toBe(PLATE_BODY);
  });

  it("leaves a selection spanning two distinct bodies unresolved", () => {
    expect(
      selectedBoundsBody(
        [
          { kind: "body", bodyId: PLATE_BODY },
          { kind: "body", bodyId: PAD_BODY },
        ],
        FEATURES,
      ),
    ).toBeUndefined();
  });

  it("leaves an empty selection unresolved", () => {
    expect(selectedBoundsBody([], FEATURES)).toBeUndefined();
  });
});
