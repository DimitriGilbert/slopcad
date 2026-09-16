/**
 * Unit tests for the ground furniture geometry: three axis segments dodged
 * out of every plane an origin-resting model occupies (the z-fighting
 * rules), each carrying its convention color on both endpoints.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  CAD_SCENE_AXIS_CLEARANCE_MM,
  CAD_SCENE_AXIS_LENGTH_MM,
  CAD_SCENE_AXIS_X_COLOR,
  CAD_SCENE_AXIS_Y_COLOR,
  CAD_SCENE_AXIS_Z_COLOR,
  createAxesGeometry,
} from "./scene-ground";

/** The vertex offset of an axis's first endpoint in the flat buffers. */
function axisVertexOffset(axis: number): number {
  return axis * 6;
}

describe("ground axes geometry", () => {
  it("builds one two-vertex segment per axis", () => {
    const position = createAxesGeometry().getAttribute("position");
    expect(position.count).toBe(6);
  });

  it("runs the horizontal axes through the origin below the ground plane", () => {
    const position = createAxesGeometry().getAttribute("position");
    // The buffer is float32: source values compare after fround quantization.
    const clearance = Math.fround(CAD_SCENE_AXIS_CLEARANCE_MM);
    const length = CAD_SCENE_AXIS_LENGTH_MM;
    // X axis: full length, on the y = 0 face plane, `clearance` below z = 0.
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([
      -length,
      0,
      -clearance,
    ]);
    expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([
      length,
      0,
      -clearance,
    ]);
    // Y axis: full length, on the x = 0 face plane, `clearance` below z = 0.
    expect([position.getX(2), position.getY(2), position.getZ(2)]).toEqual([
      0,
      -length,
      -clearance,
    ]);
    expect([position.getX(3), position.getY(3), position.getZ(3)]).toEqual([
      0,
      length,
      -clearance,
    ]);
  });

  it("leans the vertical axis diagonally outside both vertical face planes", () => {
    const position = createAxesGeometry().getAttribute("position");
    const clearance = Math.fround(CAD_SCENE_AXIS_CLEARANCE_MM);
    const length = CAD_SCENE_AXIS_LENGTH_MM;
    expect([position.getX(4), position.getY(4), position.getZ(4)]).toEqual([
      -clearance,
      -clearance,
      -clearance,
    ]);
    expect([position.getX(5), position.getY(5), position.getZ(5)]).toEqual([
      -clearance,
      -clearance,
      length,
    ]);
  });

  it("colors both endpoints of each axis with its convention color", () => {
    const color = createAxesGeometry().getAttribute("color");
    const expected = [
      new THREE.Color(CAD_SCENE_AXIS_X_COLOR),
      new THREE.Color(CAD_SCENE_AXIS_Y_COLOR),
      new THREE.Color(CAD_SCENE_AXIS_Z_COLOR),
    ];
    for (let axis = 0; axis < expected.length; axis += 1) {
      const wanted = expected[axis];
      if (wanted === undefined) {
        throw new Error(`Axis ${axis} has no expected color.`);
      }
      for (let vertex = 0; vertex < 2; vertex += 1) {
        const index = axisVertexOffset(axis) + vertex * 3;
        // The buffer is float32: source values compare after fround.
        expect([
          color.array[index],
          color.array[index + 1],
          color.array[index + 2],
        ]).toEqual([
          Math.fround(wanted.r),
          Math.fround(wanted.g),
          Math.fround(wanted.b),
        ]);
      }
    }
  });
});
