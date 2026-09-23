/**
 * Phase 59 lighting-data coverage: the studio preset IS the pinned
 * constants, the lookup falls back safely, and every rig is total data.

 */

import { describe, expect, it } from "vitest";

import {
  CAD_SCENE_AMBIENT_INTENSITY,
  CAD_SCENE_FILL_LIGHT_INTENSITY,
  CAD_SCENE_FILL_LIGHT_POSITION,
  CAD_SCENE_KEY_LIGHT_INTENSITY,
  CAD_SCENE_KEY_LIGHT_POSITION,
} from "./scene-lights";
import { CAD_LIGHT_RIGS, CAD_LIGHT_RIG_STUDIO, lightRigById } from "./lighting";

describe("light rigs", () => {
  it("the studio rig carries the pinned Phase 11.3 constants verbatim", () => {
    expect(CAD_LIGHT_RIG_STUDIO.ambient).toBe(CAD_SCENE_AMBIENT_INTENSITY);
    expect(CAD_LIGHT_RIG_STUDIO.key.position).toEqual([
      ...CAD_SCENE_KEY_LIGHT_POSITION,
    ]);
    expect(CAD_LIGHT_RIG_STUDIO.key.intensity).toBe(
      CAD_SCENE_KEY_LIGHT_INTENSITY,
    );
    expect(CAD_LIGHT_RIG_STUDIO.fill.position).toEqual([
      ...CAD_SCENE_FILL_LIGHT_POSITION,
    ]);
    expect(CAD_LIGHT_RIG_STUDIO.fill.intensity).toBe(
      CAD_SCENE_FILL_LIGHT_INTENSITY,
    );
  });

  it("every rig is total: ambient and two lights with finite data", () => {
    for (const rig of CAD_LIGHT_RIGS) {
      expect(Number.isFinite(rig.ambient)).toBe(true);
      for (const light of [rig.key, rig.fill]) {
        expect(light.position).toHaveLength(3);
        for (const component of light.position) {
          expect(Number.isFinite(component)).toBe(true);
        }
        expect(Number.isFinite(light.intensity)).toBe(true);
      }
    }
  });

  it("the lookup falls back to the studio rig on an unknown id", () => {
    expect(lightRigById("studio").id).toBe("studio");
    expect(lightRigById("nonsense").id).toBe("studio");
  });
});
