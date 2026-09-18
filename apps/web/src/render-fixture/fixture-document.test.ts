/**
 * Unit tests for the Phase 13 fixture document and the translate-offset
 * render derivation: the session boots with the tool system's modeling
 * convention (translate feature + three length parameters, rotate feature +
 * one angle parameter), tool-issued `parameter.set` transactions flow
 * through the session into the derived world offset, and
 * `offsetPlateRenderState` is identity at zero offset and shifts the
 * projected geometry (but never the measurement) by exactly the offset.
 */

import { describe, expect, it } from "vitest";
import {
  applySessionTransaction,
  createBodyId,
  createRenderProjection,
  length,
  projectTessellation,
  valueIn,
  type ParseResult,
  type ProjectionError,
  type RenderCamera,
} from "@slopcad/cad-core";
import type { PlateMeasurement } from "../worker-fixture/plate-scene";

import {
  appliedTranslationOffset,
  createFixtureSession,
  FIXTURE_BODY_ID,
  FIXTURE_ROTATE_PARAMETER,
  FIXTURE_TRANSLATE_PARAMETERS,
} from "./fixture-document";
import {
  offsetPlateRenderState,
  type PlateRenderState,
} from "./plate-render-scene";

const CAMERA: RenderCamera = {
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

const MEASUREMENT: PlateMeasurement = {
  volume: 6000,
  bounds: { min: [0, 0, 0], max: [30, 20, 10] },
  triangles: 2,
  tessellation: {
    positions: [0, 0, 0, 30, 0, 0, 0, 20, 10],
    indices: [0, 1, 2],
  },
};

function unwrap<T>(result: ParseResult<T, ProjectionError>): T {
  if (!result.ok) {
    throw new Error(`Plate projection rejected: ${result.error.message}`);
  }
  return result.value;
}

function renderState(): PlateRenderState {
  const object = unwrap(
    projectTessellation(FIXTURE_BODY_ID, MEASUREMENT.tessellation),
  );
  return {
    measurement: MEASUREMENT,
    projection: unwrap(createRenderProjection([object], CAMERA)),
  };
}

describe("fixture document", () => {
  it("boots with the translate and rotate plumbing at identity", () => {
    const session = createFixtureSession();
    expect(appliedTranslationOffset(session.document)).toEqual([0, 0, 0]);
    const rotate = session.document.parameters.parameters.find(
      (parameter) => parameter.id === FIXTURE_ROTATE_PARAMETER,
    );
    expect(valueIn(rotate?.value ?? length(0), "deg")).toBe(0);
  });

  it("derives the world offset from tool-issued parameter.set transactions", () => {
    const session = createFixtureSession();
    const applied = applySessionTransaction(session, {
      commands: [
        {
          type: "parameter.set",
          id: FIXTURE_TRANSLATE_PARAMETERS[0],
          value: length(5),
        },
        {
          type: "parameter.set",
          id: FIXTURE_TRANSLATE_PARAMETERS[1],
          value: length(-2.5),
        },
        {
          type: "parameter.set",
          id: FIXTURE_TRANSLATE_PARAMETERS[2],
          value: length(1),
        },
      ],
    });
    expect(applied.ok).toBe(true);
    const document = applied.ok ? applied.value.document : session.document;
    expect(appliedTranslationOffset(document)).toEqual([5, -2.5, 1]);
    // The translate feature is the resolved target for the plate body.
    expect(
      document.features.find((feature) => feature.kind === "translate")
        ?.outputs,
    ).toEqual([FIXTURE_BODY_ID]);
  });

  it("offsetPlateRenderState is identity at zero offset", () => {
    const state = renderState();
    expect(offsetPlateRenderState(state, [0, 0, 0])).toBe(state);
  });

  it("offsetPlateRenderState shifts the geometry by exactly the offset, never the measurement", () => {
    const state = renderState();
    const offsetState = offsetPlateRenderState(state, [5, -2, 1]);
    expect(offsetState.measurement).toBe(MEASUREMENT);
    expect(offsetState.projection.objects).toHaveLength(1);
    const object = offsetState.projection.objects[0];
    expect(object?.bodyId).toBe(FIXTURE_BODY_ID);
    expect(createBodyId("body_plate")).toBe(FIXTURE_BODY_ID);
    // Every position triple shifted by the offset; the first vertex was
    // (0, 0, 0) and is now exactly (5, -2, 1).
    expect(object?.positions.slice(0, 3)).toEqual([5, -2, 1]);
    expect(object?.bounds.min).toEqual([5, -2, 1]);
    expect(object?.bounds.max).toEqual([35, 18, 11]);
  });
});
