/**
 * The composed-model suite: a Nema17-stepper-mount plate authored with the
 * full Phase 2 vocabulary — parameters, a shared bolt cylinder consumed by
 * four translated copies through `<Use>`, a union of the copies, a
 * subtract that drills the plate, and a fillet addressed through a
 * persistent-reference record — asserted as a FULL transaction golden, an
 * applyCommand fold (with the edge reference's record minted the way the
 * picking layer mints it), and a byte-identical determinism check. Plus
 * the shared-input reference test (one feature consumed by two different
 * booleans) and the document-level vocabulary folds for representative
 * kinds. Pure data: no DOM, no network, no database.
 */

import {
  addDocumentReference,
  applyCommand,
  CAD_DOCUMENT_FORMAT_VERSION,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createReferenceId,
  mintTopologyReference,
  referenceProvenance,
  serializeTopologyReference,
  serializeTransaction,
  type TopologyEntitySnapshot,
  type TopologySnapshot,
} from "@slopcad/cad-core";
import { createElement, Fragment } from "react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { compileModel } from "./compiler";
import {
  Body,
  Box,
  Cylinder,
  Fillet,
  Hole,
  Line,
  Mirror,
  Parameter,
  PatternLinear,
  Rib,
  Sketch,
  Sphere,
  Subtract,
  Translate,
  Union,
  Use,
} from "./elements";

const V = CAD_DOCUMENT_FORMAT_VERSION;

/** Canonical serialized quantities. */
const mm = (value: number) => ({ dimension: "length", unit: "mm", value });

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

/** The five golden commands one translated bolt copy compiles to. */
function boltCopyCommands(suffix: "a" | "b" | "c" | "d", x: number, y: number) {
  const slug = `bolt-${suffix}`;
  return [
    {
      formatVersion: V,
      type: "parameter.create",
      id: `param_${slug}-x`,
      name: `bolt${suffix}X`,
      value: mm(x),
    },
    {
      formatVersion: V,
      type: "parameter.create",
      id: `param_${slug}-y`,
      name: `bolt${suffix}Y`,
      value: mm(y),
    },
    {
      formatVersion: V,
      type: "parameter.create",
      id: `param_${slug}-z`,
      name: `bolt${suffix}Z`,
      value: mm(-2),
    },
    {
      formatVersion: V,
      type: "body.create",
      id: `body_${slug}`,
      name: `bolt ${suffix}`,
    },
    {
      formatVersion: V,
      type: "feature.create",
      id: `feat_${slug}`,
      kind: "translate",
      inputs: [
        { kind: "feature", id: "feat_bolt" },
        { kind: "parameter", id: `param_${slug}-x` },
        { kind: "parameter", id: `param_${slug}-y` },
        { kind: "parameter", id: `param_${slug}-z` },
      ],
      outputs: [`body_${slug}`],
    },
  ];
}

/** The bolt-copy translate: one of four corner placements of the shared bolt. */
const boltAt = (suffix: string, x: number, y: number) =>
  createElement(
    Translate,
    { id: `feat_bolt-${suffix}`, x, y, z: -2 },
    createElement(Use, { feature: "feat_bolt" }),
  );

/** The composed Nema17-mount model (NEMA17 bolt spacing: centres at ±15.5 mm). */
const Nema17Mount = (): ReactElement<unknown> =>
  createElement(
    Fragment,
    null,
    createElement(Parameter, { name: "boltRadius", value: 2.25 }),
    createElement(Parameter, { name: "boreRadius", value: 13.5 }),
    createElement(Cylinder, {
      id: "feat_bolt",
      radius: "param_boltRadius",
      height: 12,
    }),
    boltAt("a", 15.5, 15.5),
    boltAt("b", -15.5, 15.5),
    boltAt("c", 15.5, -15.5),
    boltAt("d", -15.5, -15.5),
    createElement(
      Union,
      { id: "feat_bolts" },
      createElement(Use, { feature: "feat_bolt-a" }),
      createElement(Use, { feature: "feat_bolt-b" }),
      createElement(Use, { feature: "feat_bolt-c" }),
      createElement(Use, { feature: "feat_bolt-d" }),
    ),
    createElement(Cylinder, {
      id: "feat_bore",
      radius: "param_boreRadius",
      height: 12,
    }),
    createElement(
      Subtract,
      { id: "feat_drilled" },
      createElement(Box, { width: 60, depth: 60, height: 8 }),
      createElement(Use, { feature: "feat_bolts" }),
      createElement(Use, { feature: "feat_bore" }),
    ),
    createElement(
      Body,
      { name: "mount" },
      createElement(
        Fillet,
        { id: "feat_edge-fillet", radius: 2, edges: ["ref_plate-edge"] },
        createElement(Use, { feature: "feat_drilled" }),
      ),
    ),
  );

describe("the composed Nema17 mount", () => {
  it("compiles to the exact canonical transaction", () => {
    const result = serializedOf(Nema17Mount());
    expect(result.commands).toEqual([
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_boltRadius",
        name: "boltRadius",
        value: mm(2.25),
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_boreRadius",
        name: "boreRadius",
        value: mm(13.5),
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_bolt-height",
        name: "boltHeight",
        value: mm(12),
      },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_bolt",
        name: "bolt",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_bolt",
        kind: "cylinder",
        inputs: [
          { kind: "parameter", id: "param_boltRadius" },
          { kind: "parameter", id: "param_bolt-height" },
        ],
        outputs: ["body_bolt"],
      },
      ...boltCopyCommands("a", 15.5, 15.5),
      ...boltCopyCommands("b", -15.5, 15.5),
      ...boltCopyCommands("c", 15.5, -15.5),
      ...boltCopyCommands("d", -15.5, -15.5),
      {
        formatVersion: V,
        type: "body.create",
        id: "body_bolts",
        name: "bolts",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_bolts",
        kind: "union",
        inputs: [
          { kind: "feature", id: "feat_bolt-a" },
          { kind: "feature", id: "feat_bolt-b" },
          { kind: "feature", id: "feat_bolt-c" },
          { kind: "feature", id: "feat_bolt-d" },
        ],
        outputs: ["body_bolts"],
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_bore-height",
        name: "boreHeight",
        value: mm(12),
      },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_bore",
        name: "bore",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_bore",
        kind: "cylinder",
        inputs: [
          { kind: "parameter", id: "param_boreRadius" },
          { kind: "parameter", id: "param_bore-height" },
        ],
        outputs: ["body_bore"],
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_box-1-width",
        name: "box1Width",
        value: mm(60),
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_box-1-depth",
        name: "box1Depth",
        value: mm(60),
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_box-1-height",
        name: "box1Height",
        value: mm(8),
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
      {
        formatVersion: V,
        type: "body.create",
        id: "body_drilled",
        name: "drilled",
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_drilled",
        kind: "subtract",
        inputs: [
          { kind: "feature", id: "feat_box-1" },
          { kind: "feature", id: "feat_bolts" },
          { kind: "feature", id: "feat_bore" },
        ],
        outputs: ["body_drilled"],
      },
      {
        formatVersion: V,
        type: "body.create",
        id: "body_mount",
        name: "mount",
      },
      {
        formatVersion: V,
        type: "parameter.create",
        id: "param_edge-fillet-radius",
        name: "edgefilletRadius",
        value: mm(2),
      },
      {
        formatVersion: V,
        type: "feature.create",
        id: "feat_edge-fillet",
        kind: "fillet",
        inputs: [
          { kind: "feature", id: "feat_drilled" },
          { kind: "reference", id: "ref_plate-edge" },
          { kind: "parameter", id: "param_edge-fillet-radius" },
        ],
        outputs: ["body_mount"],
      },
    ]);
  });

  it("compiles byte-identically every time", () => {
    expect(JSON.stringify(serializedOf(Nema17Mount()))).toBe(
      JSON.stringify(serializedOf(Nema17Mount())),
    );
  });

  it("folds onto a document carrying the minted edge reference", () => {
    const result = compileModel(Nema17Mount());
    if (!result.ok) throw new Error(result.error.message);
    const commands = result.value.commands;
    expect(commands).toHaveLength(40);
    let document = createDocument(createDocumentId("doc_nema17_mount"));

    // Fold everything except the fillet's feature.create — the edge
    // reference's record must exist before the feature that consumes it.
    for (const command of commands.slice(0, commands.length - 1)) {
      const applied = applyCommand(document, command);
      if (!applied.ok) throw new Error(applied.error.message);
      document = applied.value;
    }

    // Mint the edge reference exactly the way the picking layer does: a
    // snapshot entity of the drilled plate's body, through cad-core's own
    // minting path (the core-bridge fillet test's fixture discipline).
    const referenceId = createReferenceId("ref_plate-edge");
    const drilledBody = createBodyId("body_drilled");
    const provenance = referenceProvenance(document, drilledBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const entity: TopologyEntitySnapshot = {
      kind: "edge",
      ordinal: 3,
      identity: {
        kernelId: "fixture-kernel",
        schema: "fixture-snapshot-v1",
        data: { hash: 4242 },
      },
      geometry: {
        lengthMm: 60,
        centroidAbsoluteMm: [30, 0, 4],
        centroidRelativeMm: [0, 0, 0],
      },
    };
    const snapshot: TopologySnapshot = {
      kernelId: "fixture-kernel",
      persistentTopology: true,
      identitySchemas: ["fixture-snapshot-v1"],
      bodyId: drilledBody,
      regeneration: 0,
      entities: [entity],
    };
    const minted = mintTopologyReference(snapshot, 3, provenance.value, {
      id: referenceId,
      kind: "edge",
    });
    if (!minted.ok) throw new Error(minted.error.message);
    const referenced = addDocumentReference(document, {
      id: referenceId,
      name: "plate edge",
      reference: { ...serializeTopologyReference(minted.value) },
    });
    if (!referenced.ok) throw new Error(referenced.error.message);
    document = referenced.value.document;

    // The fillet's feature.create lands last, its inputs all resolving.
    const final = applyCommand(
      document,
      commands[commands.length - 1] as (typeof commands)[number],
    );
    if (!final.ok) throw new Error(final.error.message);
    document = final.value;

    expect(document.parameters.parameters).toHaveLength(20);
    expect(document.bodies.map((body) => body.id)).toEqual([
      "body_bolt",
      "body_bolt-a",
      "body_bolt-b",
      "body_bolt-c",
      "body_bolt-d",
      "body_bolts",
      "body_bore",
      "body_box-1",
      "body_drilled",
      "body_mount",
    ]);
    expect(document.features.map((feature) => feature.kind)).toEqual([
      "cylinder",
      "translate",
      "translate",
      "translate",
      "translate",
      "union",
      "cylinder",
      "box",
      "subtract",
      "fillet",
    ]);
    const fillet = document.features.at(-1);
    expect(fillet?.inputs).toEqual([
      { kind: "feature", id: "feat_drilled" },
      { kind: "reference", id: "ref_plate-edge" },
      { kind: "parameter", id: "param_edge-fillet-radius" },
    ]);
    expect(fillet?.outputs).toEqual([createBodyId("body_mount")]);
    expect(document.references.map((record) => record.id)).toEqual([
      "ref_plate-edge",
    ]);
  });
});

describe("shared inputs by reference", () => {
  const sharedModel = (): ReactElement<unknown> =>
    createElement(
      Fragment,
      null,
      createElement(Sphere, { id: "feat_hub", radius: 5 }),
      createElement(Sphere, { radius: 8 }),
      createElement(
        Union,
        { id: "feat_fused" },
        createElement(Use, { feature: "feat_hub" }),
        createElement(Use, { feature: "feat_sphere-2" }),
      ),
      createElement(
        Subtract,
        { id: "feat_cored" },
        createElement(Use, { feature: "feat_fused" }),
        createElement(Use, { feature: "feat_hub" }),
      ),
    );

  it("emits the shared feature once and consumes it in two booleans", () => {
    const result = serializedOf(sharedModel());
    const hubFeatures = result.commands.filter(
      (command) =>
        command.type === "feature.create" && command.id === "feat_hub",
    );
    expect(hubFeatures).toHaveLength(1);
    const fused = result.commands.find(
      (command) =>
        command.type === "feature.create" && command.id === "feat_fused",
    );
    const cored = result.commands.find(
      (command) =>
        command.type === "feature.create" && command.id === "feat_cored",
    );
    expect(fused).toMatchObject({
      kind: "union",
      inputs: [
        { kind: "feature", id: "feat_hub" },
        { kind: "feature", id: "feat_sphere-2" },
      ],
    });
    expect(cored).toMatchObject({
      kind: "subtract",
      inputs: [
        { kind: "feature", id: "feat_fused" },
        { kind: "feature", id: "feat_hub" },
      ],
    });
  });

  it("keeps the ids stable across recompiles and folds onto a document", () => {
    const first = JSON.stringify(serializedOf(sharedModel()));
    const second = JSON.stringify(serializedOf(sharedModel()));
    expect(second).toBe(first);

    const result = compileModel(sharedModel());
    if (!result.ok) throw new Error(result.error.message);
    let document = createDocument(createDocumentId("doc_shared_inputs"));
    for (const command of result.value.commands) {
      const applied = applyCommand(document, command);
      if (!applied.ok) throw new Error(applied.error.message);
      document = applied.value;
    }
    expect(document.features.map((feature) => feature.id)).toEqual([
      "feat_hub",
      "feat_sphere-2",
      "feat_fused",
      "feat_cored",
    ]);
    const hubUses = document.features.filter((feature) =>
      feature.inputs.some((input) => input.id === "feat_hub"),
    );
    expect(hubUses.map((feature) => feature.id)).toEqual([
      "feat_fused",
      "feat_cored",
    ]);
  });
});

describe("document-level vocabulary folds", () => {
  /** Folds a model onto a fresh document and returns it. */
  function folded(root: ReactElement<unknown>): CadDocument {
    const result = compileModel(root);
    if (!result.ok) throw new Error(result.error.message);
    let document = createDocument(createDocumentId("doc_vocabulary_fold"));
    for (const command of result.value.commands) {
      const applied = applyCommand(document, command);
      if (!applied.ok) throw new Error(applied.error.message);
      document = applied.value;
    }
    return document;
  }

  it("folds a boolean chain: box + sphere → union", () => {
    const document = folded(
      createElement(
        Union,
        null,
        createElement(Box, { width: 30, depth: 20, height: 10 }),
        createElement(Sphere, { radius: 8 }),
      ),
    );
    expect(document.parameters.parameters).toHaveLength(4);
    expect(document.bodies.map((body) => body.id)).toEqual([
      "body_box-1",
      "body_sphere-1",
      "body_union-1",
    ]);
    expect(document.features.map((feature) => feature.kind)).toEqual([
      "box",
      "sphere",
      "union",
    ]);
  });

  it("folds a sketch-driven rib: sketch record + box + rib feature", () => {
    const document = folded(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          { id: "skd_gusset" },
          createElement(Line, { x1: 0, y1: 0, x2: 25, y2: 0 }),
          createElement(Line, { x1: 25, y1: 0, x2: 0, y2: 10 }),
          createElement(Line, { x1: 0, y1: 10, x2: 0, y2: 0 }),
        ),
        createElement(
          Rib,
          { thickness: 4, sketch: "skd_gusset" },
          createElement(Box, { width: 40, depth: 20, height: 15 }),
        ),
      ),
    );
    expect(document.sketches.map((sketch) => sketch.id)).toEqual([
      "skd_gusset",
    ]);
    expect(document.features.map((feature) => feature.kind)).toEqual([
      "box",
      "rib",
    ]);
    const rib = document.features.at(-1);
    expect(rib?.inputs).toEqual([
      { kind: "feature", id: "feat_box-1" },
      { kind: "sketch", id: "skd_gusset" },
      { kind: "parameter", id: "param_rib-1-thickness" },
    ]);
  });

  it("folds a flat hole and a linear pattern onto a plate", () => {
    const document = folded(
      createElement(
        Fragment,
        null,
        createElement(
          Hole,
          { diameter: 5, depth: 8, positionX: 10, positionY: 0 },
          createElement(Box, { width: 40, depth: 20, height: 8 }),
        ),
        createElement(
          PatternLinear,
          { count: 2, spacing: 20 },
          createElement(Use, { feature: "feat_hole-1" }),
        ),
        createElement(
          Mirror,
          { plane: "x" },
          createElement(Use, { feature: "feat_patternLinear-1" }),
        ),
      ),
    );
    expect(document.features.map((feature) => feature.kind)).toEqual([
      "box",
      "hole",
      "patternLinear",
      "mirror",
    ]);
    const hole = document.features[1];
    expect(hole?.inputs).toHaveLength(6);
    const mirror = document.features.at(-1);
    expect(mirror?.inputs).toEqual([
      { kind: "feature", id: "feat_patternLinear-1" },
      { kind: "parameter", id: "param_mirror-1-plane" },
      { kind: "parameter", id: "param_mirror-1-offset" },
    ]);
  });
});
