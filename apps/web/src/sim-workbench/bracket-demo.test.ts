/**
 * The bracket demo's tests (Phase 69, the `./fan-demo` test precedent):
 * the demo document compiles from the cad-jsx model (deterministically
 * — two folds, identical documents), carries the two bodies the
 * structural form's material assignments address, and the demo's
 * authored numbers state the L-bracket the solver voxelizes (the base
 * plate bolted down at zMin, the wall's tip loaded in −y — the form
 * defaults restating exactly these).
 */

import { describe, expect, it } from "vitest";
import { BRACKET } from "@slopcad/docs-examples/cadjsx/bracket";

import { renderableBodyIds } from "../cad-workbench/document-scene";
import { BRACKET_DEMO, bracketDemoDocument } from "./bracket-demo";

describe("the bracket demo document", () => {
  it("compiles the cad-jsx model deterministically into the two bodies", () => {
    const first = bracketDemoDocument();
    const second = bracketDemoDocument();
    expect(second).toEqual(first);
    const bodies = first.bodies.map((body) => body.name);
    expect(bodies).toEqual(["bracket base", "bracket wall"]);
    expect(renderableBodyIds(first)).toEqual(
      new Set(first.bodies.map((body) => body.id as string)),
    );
  });

  it("carries the model's parameters the Phase 70 study would drive", () => {
    const document = bracketDemoDocument();
    const thickness = document.parameters.parameters.find(
      (parameter) => parameter.name === "thickness",
    );
    const wallHeight = document.parameters.parameters.find(
      (parameter) => parameter.name === "wallHeight",
    );
    // The parameters carry dimensional quantities — the millimetre
    // magnitude against the length dimension.
    expect(thickness?.value).toMatchObject({
      dimension: "length",
      value: BRACKET.thickness,
    });
    expect(wallHeight?.value).toMatchObject({
      dimension: "length",
      value: BRACKET.wallHeight,
    });
  });

  it("states the demo's authored numbers the form defaults restate", () => {
    expect(BRACKET_DEMO.domainMinMm).toEqual([
      -BRACKET.baseHalfX,
      -BRACKET.baseHalfY,
      0,
    ]);
    expect(BRACKET_DEMO.domainMaxMm).toEqual([
      BRACKET.baseHalfX,
      BRACKET.baseHalfY,
      BRACKET.wallHeight,
    ]);
    expect(BRACKET_DEMO.fixtureFace).toBe("zMin");
    expect(BRACKET_DEMO.tipPointMm).toEqual([...BRACKET.tipPointMm]);
    expect(BRACKET_DEMO.tipForceN[1]).toBeLessThan(0);
    expect(BRACKET_DEMO.resolutionMm).toBeGreaterThan(0);
  });
});
