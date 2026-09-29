/**
 * The compiler suite: per-element golden command assertions, the
 * applyCommand fold over a fresh document, determinism, composition
 * equivalence, and the structured rejection paths. Pure tree walking —
 * no DOM, no network, no database.
 */

import { CAD_DOCUMENT_FORMAT_VERSION } from "@slopcad/cad-core";
import {
  applyCommand,
  createDocument,
  createDocumentId,
  length,
  serializeTransaction,
} from "@slopcad/cad-core";
import type { SerializedCadTransaction } from "@slopcad/cad-core";
import { Component, createElement, Fragment, useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import {
  CAD_JSX_ERROR_CODES,
  compileModel,
  type CadJsxCompileError,
} from "./compiler";
import {
  Body,
  Box,
  Cone,
  Cylinder,
  defineCadElement,
  Parameter,
  Sphere,
  Translate,
} from "./elements";

const V = CAD_DOCUMENT_FORMAT_VERSION;

/** A canonical millimetre quantity in serialized form. */
const mm = (value: number) => ({ dimension: "length", unit: "mm", value });

/** Unwraps a successful compile (golden fixtures never fail). */
function compiled(root: ReactElement<unknown>): SerializedCadTransaction {
  const result = compileModel(root);
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.message} @ ${result.error.path.join(" > ")}`,
    );
  }
  return serializeTransaction(result.value);
}

/** Unwraps a failed compile (rejection fixtures never succeed). */
function rejectionOf(root: ReactElement<unknown>): CadJsxCompileError {
  const result = compileModel(root);
  if (result.ok) throw new Error("The fixture unexpectedly compiled.");
  return result.error;
}

describe("per-element golden commands", () => {
  it("compiles <Box> to three parameters, a body, and the box feature", () => {
    expect(
      compiled(createElement(Box, { width: 30, depth: 20, height: 10 })),
    ).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_box-1-width",
          name: "box1Width",
          value: mm(30),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_box-1-depth",
          name: "box1Depth",
          value: mm(20),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_box-1-height",
          name: "box1Height",
          value: mm(10),
        },
        {
          formatVersion: V,
          type: "body.create",
          id: "body_box-1",
          name: "box 1",
        },
        {
          formatVersion: V,
          type: "feature.create",
          id: "feat_box-1",
          kind: "box",
          inputs: [
            { kind: "parameter", id: "param_box-1-width" },
            { kind: "parameter", id: "param_box-1-depth" },
            { kind: "parameter", id: "param_box-1-height" },
          ],
          outputs: ["body_box-1"],
        },
      ],
    });
  });

  it("canonicalizes non-mm quantities onto the wire", () => {
    const result = compiled(
      createElement(Box, { width: length(2, "cm"), depth: 20, height: 10 }),
    );
    const width = result.commands[0];
    if (width === undefined || width.type !== "parameter.create") {
      throw new Error("the width parameter.create did not come first");
    }
    expect(width.value).toEqual(mm(20));
  });

  it("derives ids from an explicit feature id", () => {
    expect(
      compiled(
        createElement(Box, {
          id: "feat_plate",
          width: 30,
          depth: 20,
          height: 10,
        }),
      ),
    ).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_plate-width",
          name: "plateWidth",
          value: mm(30),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_plate-depth",
          name: "plateDepth",
          value: mm(20),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_plate-height",
          name: "plateHeight",
          value: mm(10),
        },
        {
          formatVersion: V,
          type: "body.create",
          id: "body_plate",
          name: "plate",
        },
        {
          formatVersion: V,
          type: "feature.create",
          id: "feat_plate",
          kind: "box",
          inputs: [
            { kind: "parameter", id: "param_plate-width" },
            { kind: "parameter", id: "param_plate-depth" },
            { kind: "parameter", id: "param_plate-height" },
          ],
          outputs: ["body_plate"],
        },
      ],
    });
  });

  it("compiles <Sphere> to one radius parameter and the sphere feature", () => {
    expect(compiled(createElement(Sphere, { radius: 5 }))).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_sphere-1-radius",
          name: "sphere1Radius",
          value: mm(5),
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
      ],
    });
  });

  it("compiles <Cylinder> to radius-then-height, the bridge's input order", () => {
    const result = compiled(createElement(Cylinder, { radius: 4, height: 10 }));
    const feature = result.commands[3];
    if (feature === undefined || feature.type !== "feature.create") {
      throw new Error("the cylinder feature.create did not come fourth");
    }
    expect(feature.inputs).toEqual([
      { kind: "parameter", id: "param_cylinder-1-radius" },
      { kind: "parameter", id: "param_cylinder-1-height" },
    ]);
  });

  it("compiles <Cone> to bottomRadius, topRadius, height, the bridge's input order", () => {
    const result = compiled(
      createElement(Cone, { bottomRadius: 6, topRadius: 3, height: 10 }),
    );
    const feature = result.commands[4];
    if (feature === undefined || feature.type !== "feature.create") {
      throw new Error("the cone feature.create did not come fifth");
    }
    expect(feature.inputs).toEqual([
      { kind: "parameter", id: "param_cone-1-bottomRadius" },
      { kind: "parameter", id: "param_cone-1-topRadius" },
      { kind: "parameter", id: "param_cone-1-height" },
    ]);
  });

  it("compiles <Translate> to its child's commands, three offsets, and a feature input", () => {
    expect(
      compiled(
        createElement(
          Translate,
          { x: 15, y: 10, z: 0 },
          createElement(Cylinder, { radius: 4, height: 10 }),
        ),
      ),
    ).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_cylinder-1-radius",
          name: "cylinder1Radius",
          value: mm(4),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_cylinder-1-height",
          name: "cylinder1Height",
          value: mm(10),
        },
        {
          formatVersion: V,
          type: "body.create",
          id: "body_cylinder-1",
          name: "cylinder 1",
        },
        {
          formatVersion: V,
          type: "feature.create",
          id: "feat_cylinder-1",
          kind: "cylinder",
          inputs: [
            { kind: "parameter", id: "param_cylinder-1-radius" },
            { kind: "parameter", id: "param_cylinder-1-height" },
          ],
          outputs: ["body_cylinder-1"],
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_translate-1-x",
          name: "translate1X",
          value: mm(15),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_translate-1-y",
          name: "translate1Y",
          value: mm(10),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_translate-1-z",
          name: "translate1Z",
          value: mm(0),
        },
        {
          formatVersion: V,
          type: "body.create",
          id: "body_translate-1",
          name: "translate 1",
        },
        {
          formatVersion: V,
          type: "feature.create",
          id: "feat_translate-1",
          kind: "translate",
          inputs: [
            { kind: "feature", id: "feat_cylinder-1" },
            { kind: "parameter", id: "param_translate-1-x" },
            { kind: "parameter", id: "param_translate-1-y" },
            { kind: "parameter", id: "param_translate-1-z" },
          ],
          outputs: ["body_translate-1"],
        },
      ],
    });
  });

  it("defaults missing <Translate> offsets to zero parameters", () => {
    const result = compiled(
      createElement(Translate, { x: 5 }, createElement(Sphere, { radius: 2 })),
    );
    const feature = result.commands[7];
    if (feature === undefined || feature.type !== "feature.create") {
      throw new Error("the translate feature.create did not come eighth");
    }
    expect(feature.inputs).toEqual([
      { kind: "feature", id: "feat_sphere-1" },
      { kind: "parameter", id: "param_translate-1-x" },
      { kind: "parameter", id: "param_translate-1-y" },
      { kind: "parameter", id: "param_translate-1-z" },
    ]);
    const y = result.commands[4];
    if (y === undefined || y.type !== "parameter.create") {
      throw new Error("the y offset parameter did not come fifth");
    }
    expect(y.value).toEqual(mm(0));
  });

  it("compiles <Parameter> to parameter.create with the name-derived id", () => {
    expect(
      compiled(createElement(Parameter, { name: "width", value: 30 })),
    ).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_width",
          name: "width",
          value: mm(30),
        },
      ],
    });
  });

  it("compiles a re-declared <Parameter> to parameter.set, keeping the name", () => {
    expect(
      compiled(
        createElement(Fragment, null, [
          createElement(Parameter, { name: "width", value: 30 }),
          createElement(Parameter, { name: "width", value: 35 }),
        ]),
      ),
    ).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_width",
          name: "width",
          value: mm(30),
        },
        {
          formatVersion: V,
          type: "parameter.set",
          id: "param_width",
          value: mm(35),
        },
      ],
    });
  });

  it("lets primitives consume a declared <Parameter> instead of creating one", () => {
    const result = compiled(
      createElement(
        Fragment,
        null,
        createElement(Parameter, { name: "width", value: 30 }),
        createElement(Box, { width: "param_width", depth: 20, height: 10 }),
      ),
    );
    expect(result.commands).toEqual([
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_width",
        name: "width",
        value: mm(30),
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_box-1-depth",
        name: "box1Depth",
        value: mm(20),
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_box-1-height",
        name: "box1Height",
        value: mm(10),
      },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_box-1",
        name: "box 1",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_box-1",
        kind: "box",
        inputs: [
          { kind: "parameter", id: "param_width" },
          { kind: "parameter", id: "param_box-1-depth" },
          { kind: "parameter", id: "param_box-1-height" },
        ],
        outputs: ["body_box-1"],
      },
    ]);
  });

  it("lets later elements reference an implicit parameter of an earlier one", () => {
    const result = compiled(
      createElement(
        Fragment,
        null,
        createElement(Sphere, { radius: 4 }),
        createElement(Cylinder, {
          radius: "param_sphere-1-radius",
          height: 10,
        }),
      ),
    );
    const cylinder = result.commands[5];
    if (cylinder === undefined || cylinder.type !== "feature.create") {
      throw new Error("the cylinder feature.create did not come sixth");
    }
    expect(cylinder.inputs[0]).toEqual({
      kind: "parameter",
      id: "param_sphere-1-radius",
    });
    const parameterCreates = result.commands.filter(
      (command) => command.type === "parameter.create",
    );
    expect(parameterCreates).toHaveLength(2);
  });

  it("compiles a bare <Body> to a body record with a name-derived id", () => {
    expect(compiled(createElement(Body, { name: "Top Plate" }))).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "body.create",
          id: "body_Top-Plate",
          name: "Top Plate",
        },
      ],
    });
  });

  it("captures a producing child's output into the enclosing <Body>", () => {
    expect(
      compiled(
        createElement(
          Body,
          { name: "plate", id: "body_plate" },
          createElement(Box, { width: 30, depth: 20, height: 10 }),
        ),
      ),
    ).toEqual({
      formatVersion: V,
      commands: [
        {
          formatVersion: V,
          type: "body.create",
          id: "body_plate",
          name: "plate",
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_box-1-width",
          name: "box1Width",
          value: mm(30),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_box-1-depth",
          name: "box1Depth",
          value: mm(20),
        },
        {
          formatVersion: V,
          type: "parameter.create",
          id: "param_box-1-height",
          name: "box1Height",
          value: mm(10),
        },
        {
          formatVersion: V,
          type: "feature.create",
          id: "feat_box-1",
          kind: "box",
          inputs: [
            { kind: "parameter", id: "param_box-1-width" },
            { kind: "parameter", id: "param_box-1-depth" },
            { kind: "parameter", id: "param_box-1-height" },
          ],
          outputs: ["body_plate"],
        },
      ],
    });
  });

  it("captures a <Translate> producer, whose child still owns its body", () => {
    const result = compiled(
      createElement(
        Body,
        { name: "bore" },
        createElement(
          Translate,
          { x: 15, y: 10, z: 5 },
          createElement(Cylinder, { radius: 4, height: 10 }),
        ),
      ),
    );
    const translate = result.commands[8];
    if (translate === undefined || translate.type !== "feature.create") {
      throw new Error("the translate feature did not come ninth");
    }
    expect(translate.outputs).toEqual(["body_bore"]);
    const bodyCreates = result.commands.filter(
      (command) => command.type === "body.create",
    );
    expect(bodyCreates).toEqual([
      { formatVersion: V, type: "body.create", id: "body_bore", name: "bore" },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_cylinder-1",
        name: "cylinder 1",
      },
    ]);
  });
});

describe("determinism", () => {
  it("compiles the same tree to byte-identical serialized transactions", () => {
    const model = createElement(
      Fragment,
      null,
      createElement(Parameter, { name: "boreRadius", value: 4 }),
      createElement(
        Body,
        { name: "plate" },
        createElement(Box, { width: 30, depth: 20, height: 10 }),
      ),
      createElement(
        Translate,
        { x: 15, y: 10, z: 5 },
        createElement(Cylinder, { radius: "param_boreRadius", height: 10 }),
      ),
    );
    const first = JSON.stringify(compiled(model));
    const second = JSON.stringify(compiled(model));
    expect(second).toBe(first);
  });

  it("assigns occurrence-indexed ids to repeated elements in document order", () => {
    const result = compiled(
      createElement(Fragment, null, [
        createElement(Sphere, { radius: 1 }),
        createElement(Sphere, { radius: 2 }),
      ]),
    );
    const kinds = result.commands
      .filter((command) => command.type === "feature.create")
      .map((command) => (command.type === "feature.create" ? command.id : ""));
    expect(kinds).toEqual(["feat_sphere-1", "feat_sphere-2"]);
  });
});

describe("the applyCommand fold", () => {
  it("replays a compiled transaction onto a fresh document", () => {
    const model = createElement(
      Fragment,
      null,
      createElement(Parameter, { name: "boreRadius", value: 4 }),
      createElement(
        Body,
        { name: "plate" },
        createElement(Box, { width: 30, depth: 20, height: 10 }),
      ),
      createElement(
        Translate,
        { x: 15, y: 10, z: 5 },
        createElement(Cylinder, { radius: "param_boreRadius", height: 10 }),
      ),
    );
    const result = compileModel(model);
    if (!result.ok) throw new Error(result.error.message);
    let document = createDocument(createDocumentId("doc_cad_jsx_test"));
    for (const command of result.value.commands) {
      const applied = applyCommand(document, command);
      if (!applied.ok) throw new Error(applied.error.message);
      document = applied.value;
    }
    expect(document.parameters.parameters).toHaveLength(8);
    expect(document.bodies.map((body) => body.id)).toEqual([
      "body_plate",
      "body_cylinder-1",
      "body_translate-1",
    ]);
    expect(document.features).toHaveLength(3);
    expect(document.features.map((feature) => feature.kind)).toEqual([
      "box",
      "cylinder",
      "translate",
    ]);
    const plateFeature = document.features[0];
    if (plateFeature === undefined)
      throw new Error("the box feature is missing");
    expect(plateFeature.outputs).toEqual(["body_plate" as const]);
  });
});

describe("composition", () => {
  it("compiles a wrapping component to the same commands as inlining it", () => {
    const WideBox = (props: { width: number }) =>
      createElement(Box, { width: props.width, depth: 5, height: 5 });
    expect(compiled(createElement(WideBox, { width: 40 }))).toEqual(
      compiled(createElement(Box, { width: 40, depth: 5, height: 5 })),
    );
  });

  it("flattens Fragments, arrays, and conditional children", () => {
    const model = (withCylinder: boolean) =>
      createElement(
        Fragment,
        null,
        createElement(Sphere, { radius: 2 }),
        withCylinder ? createElement(Cylinder, { radius: 1, height: 3 }) : null,
        false,
        undefined,
        [
          createElement(Sphere, { radius: 3 }),
          [
            null,
            createElement(Cone, { bottomRadius: 2, topRadius: 1, height: 2 }),
          ],
        ],
      );
    const features = (root: ReactElement<unknown>) =>
      compiled(root)
        .commands.filter((command) => command.type === "feature.create")
        .map((command) =>
          command.type === "feature.create" ? command.kind : "",
        );
    expect(features(model(true))).toEqual([
      "sphere",
      "cylinder",
      "sphere",
      "cone",
    ]);
    expect(features(model(false))).toEqual(["sphere", "sphere", "cone"]);
  });
});

describe("rejections", () => {
  it("rejects class components", () => {
    class ClassModel extends Component {
      render(): ReactElement<unknown> {
        return createElement(Sphere, { radius: 1 });
      }
    }
    const error = rejectionOf(createElement(ClassModel, {}));
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.classComponentRejected);
    expect(error.path).toEqual(["<root>"]);
  });

  it("rejects HTML string tags", () => {
    const error = rejectionOf(createElement("div", null, "hello"));
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.stringTagRejected);
    expect(error.path).toEqual(["<root>"]);
  });

  it("rejects symbol element types", () => {
    const SymbolTag = Symbol("cadjsx.test.symbol-tag");
    const error = rejectionOf(
      createElement(SymbolTag as unknown as string, {}),
    );
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.elementTypeUnknown);
    expect(error.path).toEqual(["<root>"]);
  });

  it("rejects functions in user component props", () => {
    const WithCallback: (props: {
      onPick: () => void;
    }) => ReactElement<unknown> = () => createElement(Sphere, { radius: 1 });
    const error = rejectionOf(
      createElement(WithCallback, { onPick: () => {} }),
    );
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.propsInvalid);
    expect(error.path).toEqual(["<root>", "WithCallback"]);
    expect(error.message).toContain("onPick");
  });

  it("rejects a component that calls a React hook, naming the component", () => {
    const Hooky = (): ReactElement<unknown> => {
      useState(0);
      return createElement(Sphere, { radius: 1 });
    };
    const error = rejectionOf(createElement(Hooky, {}));
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.componentThrew);
    expect(error.path).toEqual(["<root>", "Hooky"]);
  });

  it("rejects a component returning text", () => {
    const Textual = (): string => "hello";
    const error = rejectionOf(createElement(Textual, {}));
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.componentReturnInvalid);
    expect(error.path).toEqual(["<root>", "Textual"]);
  });

  it("rejects unknown element kinds", () => {
    const Quantum = defineCadElement<Record<string, never>>("quantum");
    const error = rejectionOf(createElement(Quantum, {}));
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.kindUnsupported);
    expect(error.path).toEqual(["<root>", "<quantum>"]);
  });

  it("rejects unknown props, non-finite numbers, and functions in descriptor props", () => {
    const LooseBox = defineCadElement<{
      readonly width?: unknown;
      readonly depth?: unknown;
      readonly height?: unknown;
      readonly id?: string;
      readonly bogus?: unknown;
    }>("box");
    const unknownProp = rejectionOf(
      createElement(LooseBox, { width: 1, depth: 1, height: 1, bogus: 2 }),
    );
    expect(unknownProp.code).toBe(CAD_JSX_ERROR_CODES.propUnknown);
    expect(unknownProp.message).toContain("bogus");

    const notFinite = rejectionOf(
      createElement(LooseBox, { width: Number.NaN, depth: 1, height: 1 }),
    );
    expect(notFinite.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
    expect(notFinite.path).toEqual(["<root>", "<box>"]);

    const asFunction = rejectionOf(
      createElement(LooseBox, { width: () => 3, depth: 1, height: 1 }),
    );
    expect(asFunction.code).toBe(CAD_JSX_ERROR_CODES.propValueInvalid);
  });

  it("rejects references to parameters that are not declared before use", () => {
    const error = rejectionOf(
      createElement(Box, { width: "param_ghost", depth: 20, height: 10 }),
    );
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.parameterUnknown);
    expect(error.path).toEqual(["<root>", "<box>"]);
  });

  it("rejects duplicate ids with the second occurrence's path", () => {
    const error = rejectionOf(
      createElement(Fragment, null, [
        createElement(Box, { id: "feat_dupe", width: 1, depth: 1, height: 1 }),
        createElement(Box, { id: "feat_dupe", width: 2, depth: 2, height: 2 }),
      ]),
    );
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.idConflict);
    expect(error.path).toEqual(["<root>", "Fragment", "children[1]", "<box>"]);
  });

  it("rejects a <Body> holding two producing children", () => {
    const error = rejectionOf(
      createElement(
        Body,
        { name: "two" },
        createElement(Sphere, { radius: 1 }),
        createElement(Sphere, { radius: 2 }),
      ),
    );
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.bodyProducerConflict);
  });

  it("rejects a <Translate> without exactly one producing child", () => {
    const none = rejectionOf(
      createElement(Translate, { x: 1, children: null }),
    );
    expect(none.code).toBe(CAD_JSX_ERROR_CODES.translateTargetInvalid);
    const two = rejectionOf(
      createElement(
        Translate,
        { x: 1 },
        createElement(Sphere, { radius: 1 }),
        createElement(Sphere, { radius: 2 }),
      ),
    );
    expect(two.code).toBe(CAD_JSX_ERROR_CODES.translateTargetInvalid);
  });

  it("rejects nested <Body> containers", () => {
    const nested = rejectionOf(
      createElement(
        Body,
        { name: "outer" },
        createElement(Body, { name: "inner" }),
      ),
    );
    expect(nested.code).toBe(CAD_JSX_ERROR_CODES.bodyNested);
    const translated = rejectionOf(
      createElement(Translate, { x: 1 }, createElement(Body, { name: "b" })),
    );
    expect(translated.code).toBe(CAD_JSX_ERROR_CODES.bodyNested);
  });

  it("rejects text children", () => {
    const error = rejectionOf(createElement(Body, { name: "b" }, "hello"));
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.childInvalid);
    expect(error.path).toEqual(["<root>", "<body>"]);
  });

  it("rejects runaway recursion with the depth guard", () => {
    let model: ReactElement<unknown> = createElement(Sphere, { radius: 1 });
    for (let index = 0; index < 150; index += 1) {
      model = createElement(Fragment, null, model);
    }
    const error = rejectionOf(model);
    expect(error.code).toBe(CAD_JSX_ERROR_CODES.treeTooDeep);
  });
});
