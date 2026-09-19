/**
 * The stale rollback-marker clamp's decision matrix: valid markers and
 * start-of-timeline markers pass through untouched (today's parking
 * semantics), only a marker whose anchored feature the list no longer
 * declares reads as stale (null).
 */

import { describe, expect, it } from "vitest";
import type { FeatureId, FeatureRollbackPoint } from "@slopcad/cad-react";

import { clampedRollbackMarker, rollbackMarkerKey } from "./rollback-marker";

const LIVE = "feat_live" as FeatureId;
const GONE = "feat_gone" as FeatureId;

const FEATURES: readonly { readonly id: FeatureId }[] = [
  { id: "feat_first" as FeatureId },
  { id: LIVE },
];

describe("clampedRollbackMarker", () => {
  it("passes a marker anchored at a declared feature through unchanged", () => {
    const marker: FeatureRollbackPoint = { afterFeatureId: LIVE };
    expect(clampedRollbackMarker(FEATURES, marker)).toBe(marker);
  });

  it("passes a start-of-timeline marker through unchanged (it never goes stale)", () => {
    const marker: FeatureRollbackPoint = { afterFeatureId: null };
    expect(clampedRollbackMarker(FEATURES, marker)).toBe(marker);
    expect(clampedRollbackMarker([], marker)).toBe(marker);
  });

  it("clamps a marker whose anchor the feature list does not declare", () => {
    expect(
      clampedRollbackMarker(FEATURES, { afterFeatureId: GONE }),
    ).toBeNull();
    // An empty list is the fully-regressed document: every anchor is dead.
    expect(clampedRollbackMarker([], { afterFeatureId: LIVE })).toBeNull();
  });

  it("maps no marker to no marker", () => {
    expect(clampedRollbackMarker(FEATURES, null)).toBeNull();
  });
});

describe("rollbackMarkerKey", () => {
  it("keys none, start-of-timeline, and anchored markers apart", () => {
    expect(rollbackMarkerKey(null)).toBe("");
    expect(rollbackMarkerKey({ afterFeatureId: null })).toBe("after:null");
    expect(rollbackMarkerKey({ afterFeatureId: LIVE })).toBe("after:feat_live");
  });
});
