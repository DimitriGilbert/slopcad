/**
 * Phase 45 display-mode table and feature-edge derivation: the pass
 * states are pinned per mode (the mode → material-flag mapping the
 * renderer applies), and the edge geometry fixture pins the documented
 * threshold behavior — box edges in, tessellation noise out.
 */

import { describe, expect, it } from "vitest";
import { BoxGeometry, CylinderGeometry } from "three";

import {
  buildFeatureEdgeGeometry,
  CAD_DISPLAY_MODES,
  CAD_EDGE_FEATURE_ANGLE_DEG,
  displayModePasses,
  type CadDisplayMode,
} from "./display-mode";

describe("displayModePasses", () => {
  it("shaded: the established bytes — lit occluding surfaces, no edges", () => {
    const passes = displayModePasses("shaded");
    expect(passes.surfaces).toEqual({ colorWrite: true, depthWrite: true });
    expect(passes.edges.visible).toBe(false);
  });

  it("shaded-edges: lit surfaces plus the edge overlay", () => {
    const passes = displayModePasses("shaded-edges");
    expect(passes.surfaces).toEqual({ colorWrite: true, depthWrite: true });
    expect(passes.edges.visible).toBe(true);
  });

  it("wireframe: invisible non-occluding surfaces (all edges visible)", () => {
    const passes = displayModePasses("wireframe");
    expect(passes.surfaces).toEqual({ colorWrite: false, depthWrite: false });
    expect(passes.edges.visible).toBe(true);
  });

  it("hidden-line: invisible OCCLUDING surfaces (depth removes hidden edges)", () => {
    const passes = displayModePasses("hidden-line");
    expect(passes.surfaces).toEqual({ colorWrite: false, depthWrite: true });
    expect(passes.edges.visible).toBe(true);
  });

  it("every accepted mode has a table entry (exhaustive modes list)", () => {
    for (const mode of CAD_DISPLAY_MODES) {
      expect(displayModePasses(mode)).toBeDefined();
    }
    expect(CAD_DISPLAY_MODES).toHaveLength(4);
  });
});

describe("buildFeatureEdgeGeometry", () => {
  it("a box yields exactly its 12 feature edges (24 edge vertices)", () => {
    const box = new BoxGeometry(10, 10, 10);
    const edges = buildFeatureEdgeGeometry(box);
    expect(edges.getAttribute("position").count).toBe(24);
    edges.dispose();
    box.dispose();
  });

  it("a smooth cylinder keeps its rims but not its tessellation seams", () => {
    const cylinder = new CylinderGeometry(5, 5, 10, 32);
    const edges = buildFeatureEdgeGeometry(cylinder);
    // Two rim circles at 32 segments each = 64 segments = 128 vertices;
    // the 32 side seams (coplanar adjacent faces, 11.25° apart) stay
    // under the documented 20° threshold and drop out.
    expect(edges.getAttribute("position").count).toBe(128);
    edges.dispose();
    cylinder.dispose();
  });

  it("the threshold is the documented constant", () => {
    expect(CAD_EDGE_FEATURE_ANGLE_DEG).toBe(20);
  });
});

/** Type-level sanity: the mode union has exactly the four modes. */
const MODES: readonly CadDisplayMode[] = CAD_DISPLAY_MODES;
void MODES;
