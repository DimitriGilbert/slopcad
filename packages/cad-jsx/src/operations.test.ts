/**
 * The Phase 2 operation suite: per-element golden command assertions for
 * the boolean, local-operation, pattern, and mirror vocabulary — every
 * expected input layout mirrors the kernel bridge's `run*Operation` reader
 * — plus the structured rejection paths for each element's misuse. Pure
 * tree walking: no DOM, no network, no database.
 */

import {
  angle,
  CAD_DOCUMENT_FORMAT_VERSION,
  dimensionless,
  serializeDimensionalValue,
  serializeTransaction,
} from "@slopcad/cad-core";
import { createElement, Fragment } from "react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import {
  CAD_JSX_ERROR_CODES,
  type CadJsxCompileError,
  compileModel,
} from "./compiler";
import {
  Box,
  Chamfer,
  Circle,
  Cylinder,
  defineCadElement,
  DeleteFace,
  Fillet,
  Helix,
  Hole,
  Intersect,
  Line,
  Mirror,
  Parameter,
  MoveFace,
  PatternCircular,
  PatternLinear,
  PatternPath,
  Point,
  ReplaceFace,
  Rib,
  Scale,
  Shell,
  Sketch,
  Sphere,
  Split,
  Subtract,
  Thicken,
  Thread,
  Translate,
  Union,
  Use,
} from "./elements";

const V = CAD_DOCUMENT_FORMAT_VERSION;

/** Canonical serialized quantities. */
const mm = (value: number) => ({ dimension: "length", unit: "mm", value });
const rad = (value: number) => ({ dimension: "angle", unit: "rad", value });
const scalar = (value: number) => ({
  dimension: "dimensionless",
  unit: "1",
  value,
});

/** Unwraps a failed compile (rejection fixtures never succeed). */
function rejectionOf(root: ReactElement<unknown>): CadJsxCompileError {
  const result = compileModel(root);
  if (result.ok) throw new Error("The fixture unexpectedly compiled.");
  return result.error;
}

/** Unwraps a successful compile into its canonical serialized transaction. */
function serializedOf(root: ReactElement<unknown>) {
  const result = compileModel(root);
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.message} @ ${result.error.path.join(" > ")}`,
    );
  }
  return serializeTransaction(result.value);
}

/** One box, the standard target fixture. */
const targetBox = () =>
  createElement(Box, { width: 30, depth: 20, height: 10 });

describe("boolean golden commands", () => {
  it("compiles <Union> to its children's features in declaration order", () => {
    const result = serializedOf(
      createElement(
        Union,
        null,
        createElement(Sphere, { radius: 2 }),
        createElement(Sphere, { radius: 3 }),
      ),
    );
    expect(result.commands).toEqual([
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_sphere-1-radius",
        name: "sphere1Radius",
        value: mm(2),
      },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_sphere-1",
        name: "sphere 1",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_sphere-1",
        kind: "sphere",
        inputs: [{ kind: "parameter", id: "param_sphere-1-radius" }],
        outputs: ["body_sphere-1"],
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_sphere-2-radius",
        name: "sphere2Radius",
        value: mm(3),
      },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_sphere-2",
        name: "sphere 2",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_sphere-2",
        kind: "sphere",
        inputs: [{ kind: "parameter", id: "param_sphere-2-radius" }],
        outputs: ["body_sphere-2"],
      },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_union-1",
        name: "union 1",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_union-1",
        kind: "union",
        inputs: [
          { kind: "feature", id: "feat_sphere-1" },
          { kind: "feature", id: "feat_sphere-2" },
        ],
        outputs: ["body_union-1"],
      },
    ]);
  });

  it("compiles <Subtract> with the first child as the base, the rest as tools", () => {
    const result = compileModel(
      createElement(
        Subtract,
        null,
        targetBox(),
        createElement(Circle, { cx: 0, cy: 0, radius: 1 }),
      ),
    );
    expect(result.ok).toBe(false);
    // A sketch entity is not a solid producer: the honest rejection first.
    const error = result.ok ? null : result.error;
    expect(error?.code).toBe(CAD_JSX_ERROR_CODES.sketchEntityOutside);

    const subtract = serializedOf(
      createElement(
        Subtract,
        null,
        targetBox(),
        createElement(Sphere, { radius: 3 }),
        createElement(Sphere, { radius: 2 }),
      ),
    );
    const feature = subtract.commands.at(-1);
    expect(feature).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_subtract-1",
      kind: "subtract",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "feature", id: "feat_sphere-1" },
        { kind: "feature", id: "feat_sphere-2" },
      ],
      outputs: ["body_subtract-1"],
    });
  });

  it("compiles <Intersect> over its children in declaration order", () => {
    const result = serializedOf(
      createElement(
        Intersect,
        null,
        targetBox(),
        createElement(Sphere, { radius: 8 }),
      ),
    );
    const feature = result.commands.at(-1);
    expect(feature).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_intersect-1",
      kind: "intersect",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "feature", id: "feat_sphere-1" },
      ],
      outputs: ["body_intersect-1"],
    });
  });

  it("lets <Use> feed a boolean the same feature a nested child would", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(Sphere, { id: "feat_shared", radius: 5 }),
        createElement(Sphere, { radius: 8 }),
        createElement(
          Union,
          null,
          createElement(Use, { feature: "feat_shared" }),
          createElement(Use, { feature: "feat_sphere-2" }),
        ),
      ),
    );
    const features = result.commands.filter(
      (command) => command.type === "feature.create",
    );
    expect(features).toHaveLength(3);
    const union = features.at(-1);
    if (union === undefined || union.type !== "feature.create") {
      throw new Error("the union feature is missing");
    }
    expect(union.inputs).toEqual([
      { kind: "feature", id: "feat_shared" },
      { kind: "feature", id: "feat_sphere-2" },
    ]);
  });
});

describe("local operation golden commands", () => {
  it("compiles <Fillet> to target, edge references, then the radius", () => {
    const result = serializedOf(
      createElement(
        Fillet,
        { radius: 2, edges: ["ref_corner_edge", "ref_top_edge"] },
        targetBox(),
      ),
    );
    const commands = result.commands;
    expect(commands).toHaveLength(8);
    expect(commands[5]).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_fillet-1-radius",
      name: "fillet1Radius",
      value: mm(2),
    });
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_fillet-1",
      kind: "fillet",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "reference", id: "ref_corner_edge" },
        { kind: "reference", id: "ref_top_edge" },
        { kind: "parameter", id: "param_fillet-1-radius" },
      ],
      outputs: ["body_fillet-1"],
    });
  });

  it("compiles <Chamfer> with the distance parameter and edge references", () => {
    const result = serializedOf(
      createElement(
        Chamfer,
        { distance: 1.5, edges: ["ref_corner_edge"] },
        targetBox(),
      ),
    );
    const feature = result.commands.at(-1);
    expect(feature).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_chamfer-1",
      kind: "chamfer",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "reference", id: "ref_corner_edge" },
        { kind: "parameter", id: "param_chamfer-1-distance" },
      ],
      outputs: ["body_chamfer-1"],
    });
  });

  it("compiles <Shell> with face references and the thickness", () => {
    const result = serializedOf(
      createElement(
        Shell,
        { thickness: 2, faces: ["ref_top_face"] },
        targetBox(),
      ),
    );
    const feature = result.commands.at(-1);
    expect(feature).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_shell-1",
      kind: "shell",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "reference", id: "ref_top_face" },
        { kind: "parameter", id: "param_shell-1-thickness" },
      ],
      outputs: ["body_shell-1"],
    });
  });

  it("compiles <Thicken> to target plus one thickness parameter", () => {
    const result = serializedOf(
      createElement(Thicken, { thickness: 3 }, targetBox()),
    );
    expect(result.commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_thicken-1",
      kind: "thicken",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "parameter", id: "param_thicken-1-thickness" },
      ],
      outputs: ["body_thicken-1"],
    });
  });

  it("compiles <Split> to target, datum plane, and the keep-side selector", () => {
    const result = serializedOf(
      createElement(Split, { plane: "dtm_top", keep: -1 }, targetBox()),
    );
    const commands = result.commands;
    expect(commands[5]).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_split-1-keep",
      name: "split1Keep",
      value: scalar(-1),
    });
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_split-1",
      kind: "split",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "datum", id: "dtm_top" },
        { kind: "parameter", id: "param_split-1-keep" },
      ],
      outputs: ["body_split-1"],
    });
  });

  it("compiles a flat <Hole> to the five-parameter layout, axis last", () => {
    const result = serializedOf(
      createElement(
        Hole,
        {
          diameter: 9,
          depth: 6,
          positionX: 10,
          positionY: 5,
          axis: "y",
        },
        targetBox(),
      ),
    );
    const commands = result.commands;
    expect(commands[5]).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_hole-1-diameter",
      name: "hole1Diameter",
      value: mm(9),
    });
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_hole-1",
      kind: "hole",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "parameter", id: "param_hole-1-diameter" },
        { kind: "parameter", id: "param_hole-1-depth" },
        { kind: "parameter", id: "param_hole-1-positionX" },
        { kind: "parameter", id: "param_hole-1-positionY" },
        { kind: "parameter", id: "param_hole-1-axis" },
      ],
      outputs: ["body_hole-1"],
    });
    const axis = commands[9];
    expect(axis).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_hole-1-axis",
      name: "hole1Axis",
      value: scalar(2),
    });
  });

  it("compiles a structured counterbore <Hole> in structuredHoleRoles order", () => {
    const result = serializedOf(
      createElement(
        Hole,
        {
          type: "counterbore",
          diameter: 5,
          depth: 6,
          tipAngle: angle(118, "deg"),
          cboreDiameter: 9,
          cboreDepth: 3,
          positionX: 15,
          positionY: 10,
        },
        targetBox(),
      ),
    );
    const commands = result.commands;
    const names = commands
      .filter(
        (
          command,
        ): command is Extract<
          (typeof commands)[number],
          { type: "parameter.create" }
        > => command.type === "parameter.create",
      )
      .map((command) => command.name);
    expect(names).toEqual([
      "box1Width",
      "box1Depth",
      "box1Height",
      "hole1Type",
      "hole1Diameter",
      "hole1Depth",
      "hole1TipAngle",
      "hole1CboreDiameter",
      "hole1CboreDepth",
      "hole1PositionX",
      "hole1PositionY",
      "hole1Axis",
    ]);
    const typeParameter = commands[5];
    expect(typeParameter).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_hole-1-type",
      name: "hole1Type",
      value: scalar(2),
    });
    const tipAngle = commands[8];
    expect(tipAngle).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_hole-1-tipAngle",
      name: "hole1TipAngle",
      value: serializeDimensionalValue(angle(118, "deg")),
    });
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_hole-1",
      kind: "hole",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "parameter", id: "param_hole-1-type" },
        { kind: "parameter", id: "param_hole-1-diameter" },
        { kind: "parameter", id: "param_hole-1-depth" },
        { kind: "parameter", id: "param_hole-1-tipAngle" },
        { kind: "parameter", id: "param_hole-1-cboreDiameter" },
        { kind: "parameter", id: "param_hole-1-cboreDepth" },
        { kind: "parameter", id: "param_hole-1-positionX" },
        { kind: "parameter", id: "param_hole-1-positionY" },
        { kind: "parameter", id: "param_hole-1-axis" },
      ],
      outputs: ["body_hole-1"],
    });
  });

  it("compiles a structured straight <Hole> with a positions sketch and datum axis", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          { id: "skd_centres" },
          createElement(Point, { x: 10, y: 10 }),
          createElement(Point, { x: 20, y: 10 }),
        ),
        createElement(
          Hole,
          {
            type: "straight",
            diameter: 4,
            depth: 8,
            tipAngle: angle(180, "deg"),
            positions: "skd_centres",
            axisDatum: "dtm_spindle",
          },
          targetBox(),
        ),
      ),
    );
    const feature = result.commands.at(-1);
    expect(feature).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_hole-1",
      kind: "hole",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "parameter", id: "param_hole-1-type" },
        { kind: "parameter", id: "param_hole-1-diameter" },
        { kind: "parameter", id: "param_hole-1-depth" },
        { kind: "parameter", id: "param_hole-1-tipAngle" },
        { kind: "sketch", id: "skd_centres" },
        { kind: "datum", id: "dtm_spindle" },
      ],
      outputs: ["body_hole-1"],
    });
  });

  it("compiles <Rib> to target, sketch, then the thickness parameter", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          { id: "skd_section" },
          createElement(Line, { x1: -20, y1: 0, x2: 20, y2: 0 }),
          createElement(Line, { x1: 20, y1: 0, x2: 0, y2: 8 }),
          createElement(Line, { x1: 0, y1: 8, x2: -20, y2: 0 }),
        ),
        createElement(
          Rib,
          { thickness: 4, sketch: "skd_section" },
          targetBox(),
        ),
      ),
    );
    const feature = result.commands.at(-1);
    expect(feature).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_rib-1",
      kind: "rib",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "sketch", id: "skd_section" },
        { kind: "parameter", id: "param_rib-1-thickness" },
      ],
      outputs: ["body_rib-1"],
    });
  });

  it("compiles <Thread> to five parameters then the axis selector", () => {
    const result = serializedOf(
      createElement(
        Thread,
        {
          majorDiameter: 6,
          pitch: 1,
          length: 10,
          mode: "internal",
          handedness: "left",
          axis: "x",
        },
        createElement(Cylinder, { radius: 3, height: 12 }),
      ),
    );
    const commands = result.commands;
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_thread-1",
      kind: "thread",
      inputs: [
        { kind: "feature", id: "feat_cylinder-1" },
        { kind: "parameter", id: "param_thread-1-majorDiameter" },
        { kind: "parameter", id: "param_thread-1-pitch" },
        { kind: "parameter", id: "param_thread-1-length" },
        { kind: "parameter", id: "param_thread-1-mode" },
        { kind: "parameter", id: "param_thread-1-handedness" },
        { kind: "parameter", id: "param_thread-1-axis" },
      ],
      outputs: ["body_thread-1"],
    });
    const selectors = commands.filter(
      (
        command,
      ): command is Extract<
        (typeof commands)[number],
        { type: "parameter.create" }
      > =>
        command.type === "parameter.create" &&
        command.id !== undefined &&
        command.id.startsWith("param_thread-1-"),
    );
    expect(selectors.map((command) => command.value)).toEqual([
      mm(6),
      mm(1),
      mm(10),
      scalar(2),
      scalar(-1),
      scalar(1),
    ]);
  });

  it("compiles <Thread> with a datum axis in place of the selector", () => {
    const result = serializedOf(
      createElement(
        Thread,
        {
          majorDiameter: 6,
          pitch: 1,
          length: 10,
          axisDatum: "dtm_bore",
        },
        createElement(Cylinder, { radius: 3, height: 12 }),
      ),
    );
    const feature = result.commands.at(-1);
    if (feature === undefined || feature.type !== "feature.create") {
      throw new Error("the thread feature is missing");
    }
    expect(feature.inputs).toEqual([
      { kind: "feature", id: "feat_cylinder-1" },
      { kind: "parameter", id: "param_thread-1-majorDiameter" },
      { kind: "parameter", id: "param_thread-1-pitch" },
      { kind: "parameter", id: "param_thread-1-length" },
      { kind: "parameter", id: "param_thread-1-mode" },
      { kind: "parameter", id: "param_thread-1-handedness" },
      { kind: "datum", id: "dtm_bore" },
    ]);
  });

  it("compiles <Helix> to sketch first, six parameters, no target", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          { id: "skd_meridian" },
          createElement(Circle, { cx: 10, cy: 0, radius: 1 }),
        ),
        createElement(Helix, {
          id: "feat_spring",
          sketch: "skd_meridian",
          radius: 10,
          pitch: 3,
          turns: 5,
        }),
      ),
    );
    const commands = result.commands;
    expect(commands).toHaveLength(9);
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_spring",
      kind: "helix",
      inputs: [
        { kind: "sketch", id: "skd_meridian" },
        { kind: "parameter", id: "param_spring-radius" },
        { kind: "parameter", id: "param_spring-pitch" },
        { kind: "parameter", id: "param_spring-turns" },
        { kind: "parameter", id: "param_spring-handedness" },
        { kind: "parameter", id: "param_spring-startAngle" },
        { kind: "parameter", id: "param_spring-taper" },
      ],
      outputs: ["body_spring"],
    });
    const helixParameters = commands.filter(
      (
        command,
      ): command is Extract<
        (typeof commands)[number],
        { type: "parameter.create" }
      > =>
        command.type === "parameter.create" &&
        command.id !== undefined &&
        command.id.startsWith("param_spring-"),
    );
    expect(helixParameters.map((command) => command.value)).toEqual([
      mm(10),
      mm(3),
      scalar(5),
      scalar(1),
      rad(0),
      mm(0),
    ]);
  });

  it("compiles <Scale> to one dimensionless factor parameter", () => {
    const result = serializedOf(
      createElement(Scale, { factor: 2 }, targetBox()),
    );
    const commands = result.commands;
    expect(commands[5]).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_scale-1-factor",
      name: "scale1Factor",
      value: scalar(2),
    });
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_scale-1",
      kind: "scale",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "parameter", id: "param_scale-1-factor" },
      ],
      outputs: ["body_scale-1"],
    });
  });

  it("compiles <MoveFace>, <ReplaceFace>, and <DeleteFace> to their face-reference layouts", () => {
    const move = serializedOf(
      createElement(
        MoveFace,
        { face: "ref_side", axis: "z", distance: 2 },
        targetBox(),
      ),
    );
    expect(move.commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_moveFace-1",
      kind: "moveFace",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "reference", id: "ref_side" },
        { kind: "parameter", id: "param_moveFace-1-axis" },
        { kind: "parameter", id: "param_moveFace-1-distance" },
      ],
      outputs: ["body_moveFace-1"],
    });

    const replace = serializedOf(
      createElement(
        ReplaceFace,
        { face: "ref_side", plane: "dtm_top" },
        targetBox(),
      ),
    );
    expect(replace.commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_replaceFace-1",
      kind: "replaceFace",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "reference", id: "ref_side" },
        { kind: "datum", id: "dtm_top" },
      ],
      outputs: ["body_replaceFace-1"],
    });

    const remove = serializedOf(
      createElement(DeleteFace, { face: "ref_side", heal: false }, targetBox()),
    );
    expect(remove.commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_deleteFace-1",
      kind: "deleteFace",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "reference", id: "ref_side" },
        { kind: "parameter", id: "param_deleteFace-1-heal" },
      ],
      outputs: ["body_deleteFace-1"],
    });
    const heal = remove.commands[5];
    expect(heal).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_deleteFace-1-heal",
      name: "deleteFace1Heal",
      value: scalar(0),
    });
  });
});

describe("pattern and mirror golden commands", () => {
  it("compiles <PatternLinear> to count, spacing, direction", () => {
    const result = serializedOf(
      createElement(
        PatternLinear,
        { count: 3, spacing: 10, direction: angle(90, "deg") },
        createElement(Sphere, { radius: 2 }),
      ),
    );
    const commands = result.commands;
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_patternLinear-1",
      kind: "patternLinear",
      inputs: [
        { kind: "feature", id: "feat_sphere-1" },
        { kind: "parameter", id: "param_patternLinear-1-count" },
        { kind: "parameter", id: "param_patternLinear-1-spacing" },
        { kind: "parameter", id: "param_patternLinear-1-direction" },
      ],
      outputs: ["body_patternLinear-1"],
    });
    const patternParameters = commands.filter(
      (
        command,
      ): command is Extract<
        (typeof commands)[number],
        { type: "parameter.create" }
      > =>
        command.type === "parameter.create" &&
        command.id !== undefined &&
        command.id.startsWith("param_patternLinear-1-"),
    );
    expect(patternParameters.map((command) => command.value)).toEqual([
      scalar(3),
      mm(10),
      rad(Math.PI / 2),
    ]);
  });

  it("defaults <PatternLinear>'s direction to +x", () => {
    const result = serializedOf(
      createElement(
        PatternLinear,
        { count: 2, spacing: 5 },
        createElement(Sphere, { radius: 2 }),
      ),
    );
    const direction = result.commands
      .filter(
        (
          command,
        ): command is Extract<
          (typeof result.commands)[number],
          { type: "parameter.create" }
        > =>
          command.type === "parameter.create" &&
          command.id === "param_patternLinear-1-direction",
      )
      .at(0);
    expect(direction?.value).toEqual(rad(0));
  });

  it("compiles <PatternCircular> to count, totalAngle, axis", () => {
    const result = serializedOf(
      createElement(
        PatternCircular,
        { count: 6, totalAngle: 2 * Math.PI, axis: "z" },
        createElement(Sphere, { radius: 2 }),
      ),
    );
    const commands = result.commands;
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_patternCircular-1",
      kind: "patternCircular",
      inputs: [
        { kind: "feature", id: "feat_sphere-1" },
        { kind: "parameter", id: "param_patternCircular-1-count" },
        { kind: "parameter", id: "param_patternCircular-1-totalAngle" },
        { kind: "parameter", id: "param_patternCircular-1-axis" },
      ],
      outputs: ["body_patternCircular-1"],
    });
    const axis = commands[5];
    expect(axis).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_patternCircular-1-axis",
      name: "patternCircular1Axis",
      value: scalar(3),
    });
  });

  it("compiles <PatternPath> to target, sketch, count, spacing, orientation", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          { id: "skd_path" },
          createElement(Line, { x1: 0, y1: 0, x2: 0, y2: 40 }),
        ),
        createElement(
          PatternPath,
          { count: 3, spacing: 15, orientation: "tangent", sketch: "skd_path" },
          createElement(Sphere, { radius: 2 }),
        ),
      ),
    );
    expect(result.commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_patternPath-1",
      kind: "patternPath",
      inputs: [
        { kind: "feature", id: "feat_sphere-1" },
        { kind: "sketch", id: "skd_path" },
        { kind: "parameter", id: "param_patternPath-1-count" },
        { kind: "parameter", id: "param_patternPath-1-spacing" },
        { kind: "parameter", id: "param_patternPath-1-orientation" },
      ],
      outputs: ["body_patternPath-1"],
    });
    const orientation = result.commands
      .filter(
        (
          command,
        ): command is Extract<
          (typeof result.commands)[number],
          { type: "parameter.create" }
        > =>
          command.type === "parameter.create" &&
          command.id === "param_patternPath-1-orientation",
      )
      .at(0);
    expect(orientation?.value).toEqual(scalar(2));
  });

  it("compiles <Mirror> in the world-axis selector form", () => {
    const result = serializedOf(
      createElement(Mirror, { plane: "y", offset: 20 }, targetBox()),
    );
    const commands = result.commands;
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_mirror-1",
      kind: "mirror",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "parameter", id: "param_mirror-1-plane" },
        { kind: "parameter", id: "param_mirror-1-offset" },
      ],
      outputs: ["body_mirror-1"],
    });
    const plane = commands[5];
    expect(plane).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_mirror-1-plane",
      name: "mirror1Plane",
      value: scalar(2),
    });
  });

  it("compiles <Mirror> in the datum-plane form, merging when asked", () => {
    const standalone = serializedOf(
      createElement(Mirror, { plane: "dtm_mid" }, targetBox()),
    );
    expect(standalone.commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_mirror-1",
      kind: "mirror",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "datum", id: "dtm_mid" },
      ],
      outputs: ["body_mirror-1"],
    });

    const merged = serializedOf(
      createElement(Mirror, { plane: "dtm_mid", merge: true }, targetBox()),
    );
    const commands = merged.commands;
    expect(commands.at(-1)).toEqual({
      formatVersion: V,
      type: "feature.create",
      id: "feat_mirror-1",
      kind: "mirror",
      inputs: [
        { kind: "feature", id: "feat_box-1" },
        { kind: "datum", id: "dtm_mid" },
        { kind: "parameter", id: "param_mirror-1-merge" },
      ],
      outputs: ["body_mirror-1"],
    });
    expect(commands[5]).toEqual({
      formatVersion: V,
      type: "parameter.create",
      id: "param_mirror-1-merge",
      name: "mirror1Merge",
      value: scalar(2),
    });
  });
});

describe("operation rejections", () => {
  it("rejects booleans with fewer than two producers", () => {
    const none = rejectionOf(createElement(Union, null));
    expect(none.code).toBe(CAD_JSX_ERROR_CODES.booleanInputsInvalid);
    const one = rejectionOf(createElement(Subtract, null, targetBox()));
    expect(one.code).toBe(CAD_JSX_ERROR_CODES.booleanInputsInvalid);
    const intersectAlone = rejectionOf(createElement(Intersect, null, null));
    expect(intersectAlone.code).toBe(CAD_JSX_ERROR_CODES.booleanInputsInvalid);
  });

  it("rejects <Use> of a feature not produced earlier, and <Use> with children", () => {
    const unknown = rejectionOf(createElement(Use, { feature: "feat_ghost" }));
    expect(unknown.code).toBe(CAD_JSX_ERROR_CODES.referenceUnknown);
    expect(unknown.path).toEqual(["<root>", "<use>"]);

    const forward = rejectionOf(
      createElement(
        Union,
        null,
        createElement(Use, { feature: "feat_late" }),
        createElement(Sphere, { id: "feat_late", radius: 1 }),
      ),
    );
    expect(forward.code).toBe(CAD_JSX_ERROR_CODES.referenceUnknown);

    const looseUse = defineCadElement<{
      readonly feature?: unknown;
      readonly children?: unknown;
    }>("use");
    const withChildren = rejectionOf(
      createElement(looseUse, { feature: "feat_x", children: "no" }),
    );
    expect(withChildren.code).toBe(CAD_JSX_ERROR_CODES.propUnknown);

    const malformed = rejectionOf(createElement(Use, { feature: "nope" }));
    expect(malformed.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);
  });

  it("rejects edge- and face-addressed elements with malformed reference lists", () => {
    const noEdges = rejectionOf(
      createElement(Fillet, { radius: 2, edges: [] }, targetBox()),
    );
    expect(noEdges.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);

    const badId = rejectionOf(
      createElement(
        Chamfer,
        { distance: 1, edges: ["ref_ok", "edge_5"] },
        targetBox(),
      ),
    );
    expect(badId.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);

    const looseShell = defineCadElement<{
      readonly thickness?: unknown;
      readonly faces?: unknown;
    }>("shell");
    const notAnArray = rejectionOf(
      createElement(
        looseShell,
        { thickness: 2, faces: "ref_top" },
        targetBox(),
      ),
    );
    expect(notAnArray.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);
  });

  it("rejects consuming elements without exactly one target child", () => {
    const none = rejectionOf(createElement(Thicken, { thickness: 2 }));
    expect(none.code).toBe(CAD_JSX_ERROR_CODES.operationTargetInvalid);
    const two = rejectionOf(
      createElement(
        Thicken,
        { thickness: 2 },
        targetBox(),
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(two.code).toBe(CAD_JSX_ERROR_CODES.operationTargetInvalid);
    const scaleTwo = rejectionOf(
      createElement(Scale, { factor: 2 }, targetBox(), targetBox()),
    );
    expect(scaleTwo.code).toBe(CAD_JSX_ERROR_CODES.operationTargetInvalid);
  });

  it("rejects <Split> without a plane or with a bad keep side", () => {
    const looseSplit = defineCadElement<{
      readonly plane?: unknown;
      readonly keep?: unknown;
    }>("split");
    const noPlane = rejectionOf(
      createElement(looseSplit, { keep: 1 }, targetBox()),
    );
    expect(noPlane.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    const badKeep = rejectionOf(
      createElement(looseSplit, { plane: "dtm_top", keep: 2 }, targetBox()),
    );
    expect(badKeep.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    const badDatum = rejectionOf(
      createElement(Split, { plane: "plane_top", keep: 1 }, targetBox()),
    );
    expect(badDatum.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);
  });

  it("rejects <Hole> misuse across both forms", () => {
    const structuredPropOnFlat = rejectionOf(
      createElement(
        Hole,
        { diameter: 5, depth: 5, positionX: 1, positionY: 1, cboreDepth: 2 },
        targetBox(),
      ),
    );
    expect(structuredPropOnFlat.code).toBe(CAD_JSX_ERROR_CODES.propConflict);

    const missingRole = rejectionOf(
      createElement(
        Hole,
        {
          type: "counterbore",
          diameter: 5,
          depth: 5,
          tipAngle: 0,
          positionX: 1,
          positionY: 1,
        },
        targetBox(),
      ),
    );
    expect(missingRole.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);

    const wrongTypeProp = rejectionOf(
      createElement(
        Hole,
        {
          type: "taper",
          diameter: 5,
          depth: 5,
          taperAngle: 0,
          cboreDiameter: 8,
          positionX: 1,
          positionY: 1,
        },
        targetBox(),
      ),
    );
    expect(wrongTypeProp.code).toBe(CAD_JSX_ERROR_CODES.propConflict);

    const bothAxes = rejectionOf(
      createElement(
        Hole,
        {
          diameter: 5,
          depth: 5,
          positionX: 1,
          positionY: 1,
          axis: "z",
          axisDatum: "dtm_a",
        },
        targetBox(),
      ),
    );
    expect(bothAxes.code).toBe(CAD_JSX_ERROR_CODES.propConflict);

    const positionsWithXY = rejectionOf(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          { id: "skd_c" },
          createElement(Point, { x: 0, y: 0 }),
        ),
        createElement(
          Hole,
          {
            type: "straight",
            diameter: 4,
            depth: 4,
            tipAngle: 0,
            positions: "skd_c",
            positionX: 1,
            positionY: 1,
          },
          targetBox(),
        ),
      ),
    );
    expect(positionsWithXY.code).toBe(CAD_JSX_ERROR_CODES.propConflict);

    const unknownSketch = rejectionOf(
      createElement(
        Hole,
        {
          type: "straight",
          diameter: 4,
          depth: 4,
          tipAngle: 0,
          positions: "skd_ghost",
        },
        targetBox(),
      ),
    );
    expect(unknownSketch.code).toBe(CAD_JSX_ERROR_CODES.sketchUnknown);

    const flatMissing = rejectionOf(
      createElement(Hole, { diameter: 5, depth: 5, positionX: 1 }, targetBox()),
    );
    expect(flatMissing.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
  });

  const looseHelix = defineCadElement<{
    readonly sketch?: unknown;
    readonly radius?: unknown;
    readonly pitch?: unknown;
    readonly turns?: unknown;
  }>("helix");

  it("rejects <Rib> and <Helix> whose sketch is not an in-scope <Sketch>", () => {
    const rib = rejectionOf(
      createElement(Rib, { thickness: 4, sketch: "skd_ghost" }, targetBox()),
    );
    expect(rib.code).toBe(CAD_JSX_ERROR_CODES.sketchUnknown);

    const helix = rejectionOf(
      createElement(looseHelix, {
        sketch: "skd_ghost",
        radius: 10,
        pitch: 3,
        turns: 2,
      }),
    );
    expect(helix.code).toBe(CAD_JSX_ERROR_CODES.sketchUnknown);
  });

  it("rejects <Helix> with children and missing dimensions", () => {
    const withChildren = rejectionOf(
      createElement(
        Helix,
        { sketch: "skd_m", radius: 1, pitch: 1, turns: 1 },
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(withChildren.code).toBe(CAD_JSX_ERROR_CODES.propUnknown);

    const missingTurns = rejectionOf(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          { id: "skd_m" },
          createElement(Circle, { cx: 5, cy: 0, radius: 1 }),
        ),
        createElement(looseHelix, { sketch: "skd_m", radius: 1, pitch: 1 }),
      ),
    );
    expect(missingTurns.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
  });

  it("rejects <Thread> with both axis forms at once", () => {
    const error = rejectionOf(
      createElement(
        Thread,
        {
          majorDiameter: 6,
          pitch: 1,
          length: 10,
          axis: "z",
          axisDatum: "dtm_a",
        },
        createElement(Cylinder, { radius: 3, height: 12 }),
      ),
    );
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.propConflict);
  });

  it("rejects local-face elements without their face reference", () => {
    const looseMoveFace = defineCadElement<{
      readonly face?: unknown;
      readonly axis?: unknown;
      readonly distance?: unknown;
    }>("moveFace");
    const move = rejectionOf(
      createElement(looseMoveFace, { axis: "z", distance: 2 }, targetBox()),
    );
    expect(move.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    const replace = rejectionOf(
      createElement(ReplaceFace, { face: "ref_f", plane: "nope" }, targetBox()),
    );
    expect(replace.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);
    const looseDeleteFace = defineCadElement<{
      readonly face?: unknown;
      readonly heal?: unknown;
    }>("deleteFace");
    const del = rejectionOf(
      createElement(
        looseDeleteFace,
        { face: "ref_f", heal: "yes" },
        targetBox(),
      ),
    );
    expect(del.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
  });

  it("rejects <Mirror> forms that mix the two layouts' props", () => {
    const mergeOnSelector = rejectionOf(
      createElement(Mirror, { plane: "y", merge: true }, targetBox()),
    );
    expect(mergeOnSelector.code).toBe(CAD_JSX_ERROR_CODES.propConflict);
    const offsetOnDatum = rejectionOf(
      createElement(Mirror, { plane: "dtm_mid", offset: 5 }, targetBox()),
    );
    expect(offsetOnDatum.code).toBe(CAD_JSX_ERROR_CODES.propConflict);
    const badPlane = rejectionOf(
      createElement(Mirror, { plane: "mid" }, targetBox()),
    );
    expect(badPlane.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);
  });

  const loosePatternLinear = defineCadElement<{
    readonly count?: unknown;
    readonly spacing?: unknown;
    readonly direction?: unknown;
  }>("patternLinear");
  const loosePatternCircular = defineCadElement<{
    readonly count?: unknown;
    readonly totalAngle?: unknown;
    readonly axis?: unknown;
  }>("patternCircular");
  const loosePatternPath = defineCadElement<{
    readonly count?: unknown;
    readonly spacing?: unknown;
    readonly sketch?: unknown;
  }>("patternPath");

  it("rejects patterns with missing dimensions or a bad selector", () => {
    const missing = rejectionOf(
      createElement(
        loosePatternLinear,
        { count: 3 },
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(missing.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    const badAxis = rejectionOf(
      createElement(
        loosePatternCircular,
        { count: 3, totalAngle: 1, axis: "w" },
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(badAxis.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    const pathWithoutSketch = rejectionOf(
      createElement(
        loosePatternPath,
        { count: 3, spacing: 5 },
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(pathWithoutSketch.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    const dimensionMismatch = rejectionOf(
      createElement(
        PatternLinear,
        { count: "param_spacing", spacing: 5, direction: 0 },
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(dimensionMismatch.code).toBe(CAD_JSX_ERROR_CODES.parameterUnknown);
  });

  it("rejects Object.prototype members smuggled as selector values", () => {
    const axis = rejectionOf(
      createElement(
        loosePatternCircular,
        { count: 3, totalAngle: 1, axis: "toString" },
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(axis.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    const plane = rejectionOf(
      createElement(
        Mirror,
        { plane: "constructor" },
        createElement(Sphere, { radius: 1 }),
      ),
    );
    expect(plane.code).toBe(CAD_JSX_ERROR_CODES.referenceInvalid);
  });

  it("rejects angle quantities where a length is required (compile-time dimension check)", () => {
    const error = rejectionOf(
      createElement(Thicken, { thickness: angle(90, "deg") }, targetBox()),
    );
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    expect(error.message).toContain("length");
  });

  it("lets <Translate> wrap any producing operation, not only primitives", () => {
    const result = serializedOf(
      createElement(
        Translate,
        { x: 1 },
        createElement(
          Union,
          null,
          createElement(Sphere, { radius: 1 }),
          createElement(Sphere, { radius: 2 }),
        ),
      ),
    );
    const feature = result.commands.at(-1);
    if (feature === undefined || feature.type !== "feature.create") {
      throw new Error("the translate feature is missing");
    }
    expect(feature.kind).toBe("translate");
    expect(feature.inputs[0]).toEqual({ kind: "feature", id: "feat_union-1" });
  });

  it("binds dimensionless counts to dimensionless parameters", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(Parameter, { name: "copies", value: dimensionless(4) }),
        createElement(
          PatternLinear,
          { count: "param_copies", spacing: 10 },
          createElement(Sphere, { radius: 1 }),
        ),
      ),
    );
    const feature = result.commands.at(-1);
    if (feature === undefined || feature.type !== "feature.create") {
      throw new Error("the pattern feature is missing");
    }
    expect(feature.inputs[1]).toEqual({
      kind: "parameter",
      id: "param_copies",
    });
  });
});
