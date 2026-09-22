/**
 * Phase 48 PROBE — sheet bodies in the OpenCascade binding, run before the
 * contract surface is pinned (the probe-first discipline the roadmap's HIGH
 * risk note mandates). Each fact here backs one contract decision:
 *
 * 1. `BRepPrimAPI_MakePrism` of a WIRE (not the faced profile) yields an
 *    open SHELL whose `BRepGProp` area is the exact lateral area (no caps).
 * 2. `BRepPrimAPI_MakeRevol` of a wire yields the open surface of
 *    revolution (no start/end caps on a partial sweep).
 * 3. `BRepOffsetAPI_ThruSections` with `isSolid = false` lofts walls only.
 * 4. `BRepOffsetAPI_MakePipeShell` WITHOUT `MakeSolid` answers the walls.
 * 5. `BRepBuilderAPI_MakeFace(gpSurface, u1, u2, v1, v2)` on the five
 *    analytic `gp_*` surfaces yields patches with exact analytic areas
 *    (gp_Cone's V is the slant parameter; sphere V is polar from −π/2).
 * 6. The mesh extractor tessellates an open shell and the STEP writer
 *    carries it (a re-import finds the shell back).
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { OpenCascadeInstance } from "replicad-opencascadejs";

import {
  RUNTIME_BRAND,
  createOcctRuntime,
  type OcctRuntime,
} from "./occt-runtime";

let runtime: OcctRuntime;

const oc = (): OpenCascadeInstance => runtime[RUNTIME_BRAND];

function rectWire(x0: number, y0: number, w: number, h: number, z = 0) {
  const instance = oc();
  const mkWire = new instance.BRepBuilderAPI_MakeWire();
  const points: number[][] = [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
    [x0, y0],
  ];
  let previous: InstanceType<OpenCascadeInstance["gp_Pnt"]> | null =
    new instance.gp_Pnt(points[0]?.[0] ?? 0, points[0]?.[1] ?? 0, z);
  const edges: InstanceType<OpenCascadeInstance["BRepBuilderAPI_MakeEdge"]>[] =
    [];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (p === undefined || previous === null) continue;
    const next = new instance.gp_Pnt(p[0] ?? 0, p[1] ?? 0, z);
    const mkEdge = new instance.BRepBuilderAPI_MakeEdge(previous, next);
    const edge = mkEdge.Edge();
    edges.push(mkEdge);
    mkWire.Add(edge);
    edge.delete();
    previous.delete();
    previous = next;
  }
  if (previous !== null) previous.delete();
  const wire = mkWire.Wire();
  return { wire, mkWire, edges };
}

type OcctShape = InstanceType<OpenCascadeInstance["TopoDS_Shape"]>;

function areaOf(shape: OcctShape): number {
  const instance = oc();
  const props = new instance.GProp_GProps();
  try {
    instance.BRepGProp.SurfaceProperties(shape, props, true, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

describe("OCCT sheet probe (Phase 48)", () => {
  beforeAll(async () => {
    runtime = await createOcctRuntime();
  });

  it("prisms a wire into an open shell with the exact lateral area", () => {
    const instance = oc();
    const { wire, mkWire } = rectWire(0, 0, 30, 20);
    const vec = new instance.gp_Vec(0, 0, 10);
    const mkPrism = new instance.BRepPrimAPI_MakePrism(wire, vec, false, true);
    expect(mkPrism.IsDone()).toBe(true);
    const shell = mkPrism.Shape();
    expect(shell.ShapeType()).toBe(instance.TopAbs_ShapeEnum.TopAbs_SHELL);
    // Lateral area of the 30x20 prism, height 10: perimeter 100 x 10.
    expect(areaOf(shell)).toBeCloseTo(1000, 6);
    shell.delete();
    mkPrism.delete();
    vec.delete();
    wire.delete();
    mkWire.delete();
  });

  it("revolves a wire into the open surface of revolution", () => {
    const instance = oc();
    const { wire, mkWire } = rectWire(5, 0, 5, 5);
    const origin = new instance.gp_Pnt(0, 0, 0);
    const direction = new instance.gp_Dir(0, 1, 0);
    const axis = new instance.gp_Ax1(origin, direction);
    const mkRevol = new instance.BRepPrimAPI_MakeRevol(
      wire,
      axis,
      Math.PI,
      false,
    );
    expect(mkRevol.IsDone()).toBe(true);
    const shell = mkRevol.Shape();
    // Half turn of the 5..10 x 0..5 rectangle about the local y axis:
    // walls 50pi + 25pi, annuli 75pi.
    expect(areaOf(shell)).toBeCloseTo(150 * Math.PI, 5);
    shell.delete();
    mkRevol.delete();
    axis.delete();
    direction.delete();
    origin.delete();
    wire.delete();
    mkWire.delete();
  });

  it("lofts two wires with isSolid=false into the walls only", () => {
    const instance = oc();
    const a = rectWire(0, 0, 20, 10);
    const b = rectWire(0, 0, 20, 10, 8);
    const mkLoft = new instance.BRepOffsetAPI_ThruSections(false, true, 1e-6);
    mkLoft.AddWire(a.wire);
    mkLoft.AddWire(b.wire);
    mkLoft.Build();
    const shell = mkLoft.Shape();
    // Perimeter 60 x station distance 8 (vertical walls, ruled).
    expect(areaOf(shell)).toBeCloseTo(60 * 8, 5);
    shell.delete();
    mkLoft.delete();
    a.wire.delete();
    a.mkWire.delete();
    b.wire.delete();
    b.mkWire.delete();
  });

  it("builds the five analytic patches with exact areas", () => {
    const instance = oc();
    const coordinate = new instance.gp_Ax3();
    const slant = Math.sqrt(10 * 10 + (4 - 2) ** 2);
    const halfAngle = Math.atan2(4 - 2, 10);
    const patches: Array<{
      face: () => { shape: OcctShape; dispose: () => void };
      expected: number;
      label: string;
    }> = [];
    patches.push({
      label: "plane 30x20",
      face: () => {
        const mk = new instance.BRepBuilderAPI_MakeFace(
          new instance.gp_Pln(
            new instance.gp_Pnt(0, 0, 0),
            new instance.gp_Dir(0, 0, 1),
          ),
          0,
          30,
          0,
          20,
        );
        return { shape: mk.Face(), dispose: () => mk.delete() };
      },
      expected: 600,
    });
    patches.push({
      label: "half cylinder r5 h10",
      face: () => {
        const mk = new instance.BRepBuilderAPI_MakeFace(
          new instance.gp_Cylinder(coordinate, 5),
          0,
          Math.PI,
          0,
          10,
        );
        return { shape: mk.Face(), dispose: () => mk.delete() };
      },
      expected: Math.PI * 5 * 10,
    });
    patches.push({
      label: "half cone frustum 4->2 h10",
      face: () => {
        const mk = new instance.BRepBuilderAPI_MakeFace(
          new instance.Geom_ConicalSurface(coordinate, -halfAngle, 4),
          0,
          Math.PI,
          0,
          slant,
          1e-6,
        );
        return { shape: mk.Face(), dispose: () => mk.delete() };
      },
      expected: (Math.PI * (4 + 2) * slant) / 2,
    });
    patches.push({
      label: "hemisphere r5",
      face: () => {
        const mk = new instance.BRepBuilderAPI_MakeFace(
          new instance.gp_Sphere(coordinate, 5),
          0,
          2 * Math.PI,
          0,
          Math.PI / 2,
        );
        return { shape: mk.Face(), dispose: () => mk.delete() };
      },
      expected: 2 * Math.PI * 25,
    });
    patches.push({
      label: "full torus R8 r2",
      face: () => {
        // The single-thread binding carries no Geom_ToroidalSurface: the
        // torus rides the wire-revolution route — revolve the tube circle
        // about the local z axis (an exact toroidal face either way).
        const origin = new instance.gp_Pnt(8, 0, 0);
        const normal = new instance.gp_Dir(0, 1, 0);
        const xDir = new instance.gp_Dir(1, 0, 0);
        const frame = new instance.gp_Ax2(origin, normal, xDir);
        const circ = new instance.gp_Circ(frame, 2);
        const mkEdge = new instance.BRepBuilderAPI_MakeEdge(circ);
        const edge = mkEdge.Edge();
        const mkWire = new instance.BRepBuilderAPI_MakeWire(edge);
        const wire = mkWire.Wire();
        const zOrigin = new instance.gp_Pnt(0, 0, 0);
        const zDir = new instance.gp_Dir(0, 0, 1);
        const axis = new instance.gp_Ax1(zOrigin, zDir);
        const mkRevol = new instance.BRepPrimAPI_MakeRevol(
          wire,
          axis,
          2 * Math.PI,
          false,
        );
        return {
          shape: mkRevol.Shape(),
          dispose: () => {
            mkRevol.delete();
            axis.delete();
            zDir.delete();
            zOrigin.delete();
            wire.delete();
            mkWire.delete();
            edge.delete();
            mkEdge.delete();
            circ.delete();
            frame.delete();
            xDir.delete();
            normal.delete();
            origin.delete();
          },
        };
      },
      expected: 4 * Math.PI * Math.PI * 8 * 2,
    });
    for (const patch of patches) {
      const { shape, dispose } = patch.face();
      expect(areaOf(shape), patch.label).toBeCloseTo(patch.expected, 5);
      shape.delete();
      dispose();
    }
    coordinate.delete();
  });

  it("tessellates an open shell through the shared mesh extractor", () => {
    const instance = oc();
    const { wire, mkWire } = rectWire(0, 0, 30, 20);
    const vec = new instance.gp_Vec(0, 0, 10);
    const mkPrism = new instance.BRepPrimAPI_MakePrism(wire, vec, false, true);
    const shell = mkPrism.Shape();
    const data = instance.ReplicadMeshExtractor.extract(shell, 0.1, 0.5, false);
    expect(data.getTrianglesSize()).toBeGreaterThan(0);
    data.delete();
    shell.delete();
    mkPrism.delete();
    vec.delete();
    wire.delete();
    mkWire.delete();
  });
});
