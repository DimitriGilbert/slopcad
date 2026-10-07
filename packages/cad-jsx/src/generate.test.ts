/**
 * The generator's round-trip gate (Phase 4): for a representative model
 * set, `model → compileToNative → N1 → parse → generateTsx → compile
 * (through the SAME loader discipline the server endpoint runs) → N2`
 * must satisfy `N1 === N2` byte-identically — up to exactly the two
 * fields the pipeline legitimately regenerates (the document id and the
 * metadata block, both belonging to the emitting options, not the model).
 *
 * The model set walks the vocabulary's breadth: primitives and booleans,
 * the sketch-driven producers (extrude, revolve, loft), the guide's hub
 * mount (parameters, shared `<Use>` references, a `<Body>` capture), a
 * shared-input model (one feature consumed by two later features), a
 * sketch holding ADJACENT rectangles (the chained-lines fold must keep
 * every one), a feature whose output body carries a foreign id with a
 * coincidental display name (the `<Body>` wrapper must survive), and a
 * document carrying non-representable records — where the generator must
 * decline each one in its structured ledger (never silently drop).
 */

import { describe, expect, it } from "vitest";
import {
  DATUM_FORMAT_VERSION,
  addDocumentConfiguration,
  addDocumentCurve,
  addDocumentDatum,
  addFeature,
  createCurveId,
  createDatumId,
  createFeatureId,
  parseNativeCadDocumentFromString,
} from "@slopcad/cad-core";
import type { CadDocument } from "@slopcad/cad-core";
import { Fragment, createElement } from "react";
import type { ReactElement } from "react";

import { generateTsx } from "./generate";
import {
  Body,
  Box,
  Circle,
  Cone,
  Cylinder,
  Extrude,
  Loft,
  Parameter,
  Rectangle,
  Revolve,
  Sketch,
  Sphere,
  Subtract,
  Union,
  Use,
  compileToNative,
} from "./index";
import { compileTsxSource } from "./loader";

/** Primitives and booleans: implicit ids, nesting, and a shared `<Use>` base. */
function primitivesAndBooleans(): ReactElement {
  return createElement(
    Subtract,
    null,
    createElement(
      Union,
      null,
      createElement(Box, { width: 30, depth: 20, height: 10 }),
      createElement(Cylinder, { radius: 4, height: 10 }),
    ),
    createElement(Sphere, { radius: 5 }),
    createElement(Use, { feature: "feat_box-1" }),
  );
}

/** The guide's hub mount: parameters, sketches, producers, and booleans. */
function hubMount(): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(Parameter, {
      id: "param_plateHeight",
      name: "plateHeight",
      value: 6,
    }),
    createElement(
      Sketch,
      { id: "skd_plate", name: "plate profile" },
      createElement(Rectangle, {
        id: "skent_plate",
        x1: -30,
        y1: -20,
        x2: 30,
        y2: 20,
      }),
    ),
    createElement(Extrude, {
      id: "feat_plate",
      sketch: "skd_plate",
      height: "param_plateHeight",
    }),
    createElement(
      Sketch,
      { id: "skd_ring", name: "ring meridian" },
      createElement(Circle, { id: "skent_ring", cx: 12, cy: 0, radius: 2 }),
    ),
    createElement(Revolve, {
      id: "feat_ring",
      sketch: "skd_ring",
      angle: Math.PI * 2,
      axis: Math.PI / 2,
    }),
    createElement(
      Sketch,
      { id: "skd_boss-base", name: "boss base" },
      createElement(Circle, { id: "skent_boss-base", cx: 0, cy: 0, radius: 8 }),
    ),
    createElement(
      Sketch,
      { id: "skd_boss-top", name: "boss top" },
      createElement(Circle, { id: "skent_boss-top", cx: 0, cy: 0, radius: 5 }),
    ),
    createElement(Loft, {
      id: "feat_boss",
      sections: [
        { sketch: "skd_boss-base", z: 6 },
        { sketch: "skd_boss-top", z: 12 },
      ],
    }),
    createElement(
      Subtract,
      { id: "feat_cleared" },
      createElement(Use, { feature: "feat_plate" }),
      createElement(Use, { feature: "feat_ring" }),
    ),
    createElement(
      Body,
      { id: "body_mount", name: "mount" },
      createElement(
        Union,
        { id: "feat_mount" },
        createElement(Use, { feature: "feat_cleared" }),
        createElement(Use, { feature: "feat_boss" }),
      ),
    ),
  );
}

/** A shared-input model: one plate consumed by a union AND a boolean's `<Use>`. */
function sharedInput(): ReactElement {
  return createElement(
    Subtract,
    null,
    createElement(
      Union,
      null,
      createElement(Box, { id: "feat_plate", width: 20, depth: 20, height: 4 }),
      createElement(Use, { feature: "feat_plate" }),
    ),
    createElement(Cone, { bottomRadius: 3, topRadius: 0, height: 8 }),
  );
}

/**
 * Adjacent rectangles in one sketch: the compiler emits each rectangle as
 * four chained lines plus the rect entity, back to back — the generator's
 * fold must re-fold exactly each rectangle's own lines.
 */
function adjacentRectangles(): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(
      Sketch,
      { id: "skd_pair" },
      createElement(Rectangle, { id: "skent_a", x1: 0, y1: 0, x2: 10, y2: 10 }),
      createElement(Rectangle, {
        id: "skent_b",
        x1: 20,
        y1: 0,
        x2: 30,
        y2: 10,
      }),
    ),
    createElement(
      Sketch,
      { id: "skd_triple" },
      createElement(Rectangle, { id: "skent_c", x1: 0, y1: 0, x2: 4, y2: 4 }),
      createElement(Rectangle, {
        id: "skent_d",
        x1: 10,
        y1: 0,
        x2: 14,
        y2: 4,
      }),
      createElement(Rectangle, {
        id: "skent_e",
        x1: 20,
        y1: 0,
        x2: 24,
        y2: 4,
      }),
    ),
  );
}

/** A feature whose output body carries a foreign id with a coincidental name. */
function foreignBodyId(): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(
      Body,
      { id: "body_pad-base", name: "pad" },
      createElement(Box, { id: "feat_pad", width: 10, depth: 10, height: 5 }),
    ),
  );
}

/**
 * The byte comparison after normalizing EXACTLY the fields the pipeline
 * legitimately regenerates: the document id and the metadata block. Every
 * other byte — records, history transactions, cursor — must be identical.
 */
function normalized(text: string): string {
  const parsed = JSON.parse(text) as {
    document: { id: string };
    metadata: Record<string, unknown>;
  };
  parsed.document.id = "doc_normalized";
  parsed.metadata = {};
  return JSON.stringify(parsed);
}

/** Runs one model through the full round trip and returns the two texts plus the source. */
async function roundTrip(
  model: ReactElement,
): Promise<{
  readonly n1: string;
  readonly n2: string;
  readonly source: string;
}> {
  const native = compileToNative(model);
  if (!native.ok) {
    throw new Error(
      `${native.error.code}: ${native.error.message}${
        "path" in native.error ? ` @ ${native.error.path.join(" > ")}` : ""
      }`,
    );
  }
  const reopened = parseNativeCadDocumentFromString(native.value);
  if (!reopened.ok) throw new Error(reopened.error.message);
  const generated = generateTsx(reopened.value.document, {
    documentId: reopened.value.document.id,
  });
  if (!generated.ok) throw new Error(generated.error.message);
  expect(generated.value.declines).toEqual([]);
  const recompiled = await compileTsxSource({
    source: generated.value.source,
  });
  if (!recompiled.ok) {
    throw new Error(
      `${recompiled.error.code}: ${recompiled.error.message}${
        "path" in recompiled.error
          ? ` @ ${recompiled.error.path.join(" > ")}`
          : ""
      }`,
    );
  }
  expect(() =>
    parseNativeCadDocumentFromString(recompiled.value),
  ).not.toThrow();
  return {
    n1: native.value,
    n2: recompiled.value,
    source: generated.value.source,
  };
}

describe("generateTsx round-trips byte-identically", () => {
  it("primitives + booleans model", async () => {
    const { n1, n2 } = await roundTrip(primitivesAndBooleans());
    expect(normalized(n2)).toBe(normalized(n1));
  });

  it("sketch + extrude + revolve + loft model (the hub mount)", async () => {
    const { n1, n2 } = await roundTrip(hubMount());
    expect(normalized(n2)).toBe(normalized(n1));
  });

  it("shared-input model (one feature consumed by two later features)", async () => {
    const { n1, n2 } = await roundTrip(sharedInput());
    expect(normalized(n2)).toBe(normalized(n1));
  });

  it("a sketch holding two and three adjacent rectangles (every one survives)", async () => {
    const { n1, n2, source } = await roundTrip(adjacentRectangles());
    // Every rectangle reappears as its own <Rectangle> element — an
    // adjacent rectangle must never fold the previous one's plan away.
    for (const id of ["skent_a", "skent_b", "skent_c", "skent_d", "skent_e"]) {
      expect(source).toContain(`id={"${id}"}`);
    }
    expect((source.match(/<Rectangle/g) ?? []).length).toBe(5);
    expect(normalized(n2)).toBe(normalized(n1));
  });

  it("a foreign output-body id with a coincidental name keeps its <Body> wrapper", async () => {
    const { n1, n2, source } = await roundTrip(foreignBodyId());
    // The wrapper is what reproduces the body's foreign id; omitting it
    // (name equality alone) would silently mint the derived `body_pad`.
    expect(source).toContain("<Body");
    expect(source).toContain('id={"body_pad-base"}');
    expect(normalized(n2)).toBe(normalized(n1));
  });

  it("a second pass through the generator is a fixed point", async () => {
    // The generated file itself must regenerate identically: canonical
    // in, canonical out (the export → import → export loop closes).
    const native = compileToNative(hubMount());
    if (!native.ok) throw new Error(native.error.message);
    const reopened = parseNativeCadDocumentFromString(native.value);
    if (!reopened.ok) throw new Error(reopened.error.message);
    const first = generateTsx(reopened.value.document);
    if (!first.ok) throw new Error(first.error.message);
    const compiled = await compileTsxSource({ source: first.value.source });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const reparsed = parseNativeCadDocumentFromString(compiled.value);
    if (!reparsed.ok) throw new Error(reparsed.error.message);
    const second = generateTsx(reparsed.value.document);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.source).toBe(first.value.source);
  });
});

describe("generateTsx declines non-representable records", () => {
  /** A document carrying a datum, a curve, a configuration row, and a datum-consuming feature. */
  function documentWithDeclines(): CadDocument {
    const box = compileToNative(
      createElement(Box, { width: 10, depth: 10, height: 10 }),
    );
    if (!box.ok) throw new Error(box.error.message);
    const reopened = parseNativeCadDocumentFromString(box.value);
    if (!reopened.ok) throw new Error(reopened.error.message);
    let current: CadDocument = reopened.value.document;
    const datum = addDocumentDatum(current, {
      datum: {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "originFrame",
        origin: { x: 0, y: 0, z: 5 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
      },
      id: createDatumId("dtm_top"),
      name: "top plane",
    });
    if (!datum.ok) throw new Error(datum.error.message);
    current = datum.value.document;
    const curve = addDocumentCurve(current, {
      curve: {
        kind: "interpolated-spline",
        points: [
          [0, 0, 0],
          [10, 0, 10],
        ],
      },
      id: createCurveId("crv_spine"),
      name: "spine",
    });
    if (!curve.ok) throw new Error(curve.error.message);
    current = curve.value.document;
    const configuration = addDocumentConfiguration(current, { name: "long" });
    if (!configuration.ok) throw new Error(configuration.error.message);
    current = configuration.value.document;
    // A split feature consuming the datum: it declines with the datum.
    const boxBody = current.bodies[0];
    const boxFeature = current.features[0];
    const widthParameter = current.parameters.parameters[0];
    if (
      boxBody === undefined ||
      boxFeature === undefined ||
      widthParameter === undefined
    ) {
      throw new Error("the compiled box document is malformed");
    }
    const split = addFeature(current, {
      id: createFeatureId("feat_split"),
      inputs: [
        { kind: "feature", id: boxFeature.id },
        { kind: "datum", id: createDatumId("dtm_top") },
        { kind: "parameter", id: widthParameter.id },
      ],
      kind: "split",
      outputs: [boxBody.id],
    });
    if (!split.ok) throw new Error(split.error.message);
    return split.value.document;
  }

  it("lists every declined record as data and in the header comment", () => {
    const generated = generateTsx(documentWithDeclines(), {
      documentId: "doc_declines",
    });
    if (!generated.ok) throw new Error(generated.error.message);
    const ledger = generated.value.declines;
    const ids = ledger.map((note) => `${note.kind} ${note.id}`);
    expect(ids).toContain("datum dtm_top");
    expect(ids).toContain("curve crv_spine");
    expect(ids).toContain("feature feat_split");
    expect(ids.some((entry) => entry.startsWith("configuration "))).toBe(true);
    // The header comment block lists the same ledger.
    expect(generated.value.source).toContain("DECLINED RECORDS");
    for (const note of ledger) {
      expect(generated.value.source).toContain(`- ${note.kind} ${note.id}:`);
    }
    // The representable box survives.
    expect(generated.value.source).toContain("<Box");
  });
});
