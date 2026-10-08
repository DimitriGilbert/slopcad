/**
 * Component tests for the field overlay family (Phase 62b): jsdom has no
 * WebGL, so `@react-three/fiber` is mocked with a counting `invalidate`
 * (the demand-render surface law S6 pins) and geometry lifecycle is
 * asserted by spying `BufferGeometry.prototype.dispose` — every rebuild
 * and unmount must pass through it exactly once per geometry. The
 * overlays surface as unknown host elements (the `CadModel` test
 * discipline); full Canvas rendering is browser evidence for Phase 62c.
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CadScene } from "./cad-scene";
import { decodedFieldGrid, decodedVectorField } from "./field-grid";
import {
  FieldIsoContours,
  FieldSlicePlane,
  FieldStreamlines,
  FieldVectorGlyphs,
} from "./field-overlays";
import {
  CUBE_LATTICE,
  PLANE_LATTICE,
  scalarFieldBlock,
  vectorFieldBlocks,
} from "./field-fixtures";
import {
  FOLDED_SHEET_SHARED,
  makeObject,
  makeProjection,
} from "./render-fixtures";

const fiber = vi.hoisted(() => {
  const state = {
    camera: undefined as THREE.Camera | undefined,
    gl: undefined,
    scene: undefined as THREE.Scene | undefined,
    size: { width: 800, height: 600 },
    set: (): void => {},
    invalidateCount: 0,
    invalidate: (): void => {
      fiber.state.invalidateCount += 1;
    },
  };
  return { state };
});

vi.mock("@react-three/fiber", () => ({
  Canvas: (props: { children?: ReactNode }) => (
    <div data-testid="canvas-stub">{props.children}</div>
  ),
  useFrame: (): void => {},
  useThree: <T,>(selector: (state: typeof fiber.state) => T): T =>
    selector(fiber.state),
}));

const SCALAR = decodedFieldGrid(
  scalarFieldBlock(
    "linear",
    CUBE_LATTICE,
    (x, y, z) => x + 2 * y + 3 * z,
    "mm",
  ),
);
const VECTOR = decodedVectorField(
  vectorFieldBlocks("circular", PLANE_LATTICE, (x, y) => [-y, x, 0], "mm/s"),
);
const RANGE: readonly [number, number] = [0, 10];

let disposeSpy: ReturnType<typeof trackGeometryDisposals>;

/** The spy type source: spying three's own dispose entry point. */
function trackGeometryDisposals() {
  return vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
}

beforeEach(() => {
  fiber.state.invalidateCount = 0;
  disposeSpy = trackGeometryDisposals();
});

afterEach(() => {
  cleanup();
  disposeSpy.mockRestore();
});

describe("the overlay family's demand-render and disposal discipline", () => {
  it("a slice plane mounts its mesh and requests exactly one render", () => {
    const view = render(
      <FieldSlicePlane
        axis="z"
        field={SCALAR}
        positionMm={1}
        valueRange={RANGE}
      />,
    );
    expect(view.container.querySelectorAll("mesh")).toHaveLength(1);
    expect(view.container.querySelectorAll("meshbasicmaterial")).toHaveLength(
      1,
    );
    expect(fiber.state.invalidateCount).toBe(1);
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it("an identity-stable rerender requests nothing new", () => {
    const view = render(
      <FieldSlicePlane
        axis="z"
        field={SCALAR}
        positionMm={1}
        valueRange={RANGE}
      />,
    );
    view.rerender(
      <FieldSlicePlane
        axis="z"
        field={SCALAR}
        positionMm={1}
        valueRange={RANGE}
      />,
    );
    expect(fiber.state.invalidateCount).toBe(1);
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it("a parameter change rebuilds: one render request, the old geometry disposed", () => {
    const view = render(
      <FieldSlicePlane
        axis="z"
        field={SCALAR}
        positionMm={1}
        valueRange={RANGE}
      />,
    );
    view.rerender(
      <FieldSlicePlane
        axis="y"
        field={SCALAR}
        positionMm={0}
        valueRange={RANGE}
      />,
    );
    expect(fiber.state.invalidateCount).toBe(2);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("a field change rebuilds the same way", () => {
    const other = decodedFieldGrid(
      scalarFieldBlock("other", CUBE_LATTICE, (x, y) => x - y, "mm"),
    );
    const view = render(
      <FieldSlicePlane axis="z" field={SCALAR} positionMm={1} />,
    );
    view.rerender(<FieldSlicePlane axis="z" field={other} positionMm={1} />);
    expect(fiber.state.invalidateCount).toBe(2);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("unmount disposes the live geometry exactly once", () => {
    const view = render(
      <FieldSlicePlane axis="z" field={SCALAR} positionMm={1} />,
    );
    view.unmount();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("contours, streamlines, and glyphs mount as non-picking line overlays", () => {
    const view = render(
      <>
        <FieldIsoContours
          axis="z"
          field={SCALAR}
          positionMm={1}
          thresholds={[2, 4]}
        />
        <FieldStreamlines
          field={VECTOR}
          seeds={[
            [10, 0, 0],
            [0, 10, 0],
          ]}
          stepCount={8}
          stepMm={0.5}
        />
        <FieldVectorGlyphs field={VECTOR} scaleMm={2} stride={5} />
      </>,
    );
    expect(view.container.querySelectorAll("linesegments")).toHaveLength(3);
    expect(view.container.querySelectorAll("linebasicmaterial")).toHaveLength(
      3,
    );
    // One invalidate per mounted overlay geometry — three requests, one
    // frame's worth of evidence each, no ambient loops anywhere.
    expect(fiber.state.invalidateCount).toBe(3);
    view.unmount();
    expect(disposeSpy).toHaveBeenCalledTimes(3);
  });
});

describe("the CadScene overlay slot", () => {
  it("renders children inside the scene after the model, and nothing when absent", () => {
    const projection = makeProjection([
      makeObject("plate", FOLDED_SHEET_SHARED),
    ]);
    const withOverlay = render(
      <CadScene projection={projection}>
        <FieldSlicePlane axis="z" field={SCALAR} positionMm={1} />
      </CadScene>,
    );
    const canvas = withOverlay.container.querySelector(
      '[data-testid="canvas-stub"]',
    );
    expect(canvas).not.toBeNull();
    // The overlay mounts inside the canvas stub: the model's mesh, the
    // ground's origin-marker mesh, and the overlay's slice mesh.
    expect(canvas?.querySelectorAll("mesh")).toHaveLength(3);
    withOverlay.unmount();

    const withoutOverlay = render(<CadScene projection={projection} />);
    expect(
      withoutOverlay.container.querySelector('[data-testid="canvas-stub"]'),
    ).not.toBeNull();
    // The model's mesh and the ground's marker alone — the absent slot
    // renders nothing extra.
    expect(withoutOverlay.container.querySelectorAll("mesh")).toHaveLength(2);
  });
});
