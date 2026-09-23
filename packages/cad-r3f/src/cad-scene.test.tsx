/**
 * Settle-protocol tests for `CadScene` (Phase 8, report 38 F1): jsdom has
 * no WebGL, so `@react-three/fiber` is mocked with a hand-driven demand
 * loop — the mock records every `useFrame` subscriber and the tests decide
 * when frames run. That is exactly the timing surface the settle probe
 * guards: R3F can schedule a frame between a projection prop's commit and
 * the passive effects that apply its geometry and camera, and the probe
 * must not certify content a frame has not drawn. The camera-content
 * comparator is pinned directly (hosts may memoize camera objects across
 * projections), and the full-scene test proves the wiring marks the ledger
 * for content-equal projection changes where the geometry diff's `onSync`
 * stays silent.
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderCamera, RenderProjection } from "@slopcad/cad-core";

import {
  camerasEqual,
  CadScene,
  type SettleLedger,
  SettleProbe,
} from "./cad-scene";
import { CAD_QUALITY_SHADOW_GROUND_OPACITY } from "./render-quality";
import {
  FOLDED_SHEET_SHARED,
  makeObject,
  makeProjection,
  TEST_CAMERA,
} from "./render-fixtures";

const fiber = vi.hoisted(() => {
  const state = {
    size: { width: 800, height: 600 },
    set: (): void => {},
    invalidate: (): void => {},
  };
  const frames: Array<() => void> = [];
  const framePriorities: number[] = [];
  return {
    state,
    frames,
    framePriorities,
    runFrames: (): void => {
      for (const frame of [...frames]) {
        frame();
      }
    },
  };
});

vi.mock("@react-three/fiber", () => ({
  Canvas: (props: { children?: ReactNode }) => (
    <div data-testid="canvas-stub">{props.children}</div>
  ),
  useFrame: (callback: () => void, priority?: number): void => {
    fiber.frames.push(callback);
    fiber.framePriorities.push(priority ?? 0);
  },
  useThree: <T,>(selector: (state: typeof fiber.state) => T): T =>
    selector(fiber.state),
}));

const PROJECTION: RenderProjection = makeProjection([
  makeObject("plate", FOLDED_SHEET_SHARED),
]);

/** A fresh, content-equal copy of a camera spec (identity differs). */
function cloneCamera(spec: RenderCamera): RenderCamera {
  if (spec.kind === "perspective") {
    return {
      kind: "perspective",
      position: [spec.position[0], spec.position[1], spec.position[2]],
      target: [spec.target[0], spec.target[1], spec.target[2]],
      up: [spec.up[0], spec.up[1], spec.up[2]],
      fovDeg: spec.fovDeg,
    };
  }
  return {
    kind: "orthographic",
    position: [spec.position[0], spec.position[1], spec.position[2]],
    target: [spec.target[0], spec.target[1], spec.target[2]],
    up: [spec.up[0], spec.up[1], spec.up[2]],
    viewWidth: spec.viewWidth,
    viewHeight: spec.viewHeight,
  };
}

/** A perspective camera with the fixture framing and optional overrides. */
function perspectiveCamera(overrides: {
  fovDeg?: number;
  position?: readonly [number, number, number];
  target?: readonly [number, number, number];
}): RenderCamera {
  return {
    kind: "perspective",
    position: overrides.position ?? [46, 34, 48],
    target: overrides.target ?? [0, 0, 0],
    up: [0, 1, 0],
    fovDeg: overrides.fovDeg ?? 40,
  };
}

beforeEach(() => {
  fiber.frames.length = 0;
});

afterEach(cleanup);

describe("camerasEqual", () => {
  it("compares camera content, not object identity", () => {
    expect(camerasEqual(TEST_CAMERA, cloneCamera(TEST_CAMERA))).toBe(true);
    expect(camerasEqual(TEST_CAMERA, TEST_CAMERA)).toBe(true);
    expect(camerasEqual(perspectiveCamera({}), perspectiveCamera({}))).toBe(
      true,
    );
  });

  it("distinguishes kind, framing, and projection parameters", () => {
    const orthographic: RenderCamera = {
      kind: "orthographic",
      position: [46, 34, 48],
      target: [0, 0, 0],
      up: [0, 1, 0],
      viewWidth: 80,
      viewHeight: 52,
    };
    expect(camerasEqual(perspectiveCamera({}), orthographic)).toBe(false);
    expect(
      camerasEqual(perspectiveCamera({}), perspectiveCamera({ fovDeg: 41 })),
    ).toBe(false);
    expect(
      camerasEqual(
        perspectiveCamera({}),
        perspectiveCamera({ position: [47, 34, 48] }),
      ),
    ).toBe(false);
    expect(
      camerasEqual(
        perspectiveCamera({}),
        perspectiveCamera({ target: [0, 1, 0] }),
      ),
    ).toBe(false);
    expect(
      camerasEqual(
        orthographic,
        cloneCamera({ ...orthographic, viewWidth: 81 }),
      ),
    ).toBe(false);
  });
});

describe("SettleProbe content gate", () => {
  it("does not report a projection until its geometry is synced AND its camera applied", () => {
    const settle: SettleLedger = {
      syncedProjection: null,
      appliedCamera: null,
    };
    const onSettled = vi.fn();
    const view = render(
      <SettleProbe
        camera={PROJECTION.camera}
        onSettled={onSettled}
        projection={PROJECTION}
        settle={settle}
      />,
    );
    // The premature frame: the projection prop is committed, but R3F can
    // schedule this demand frame before the passive effects apply it.
    fiber.runFrames();
    expect(onSettled).not.toHaveBeenCalled();
    settle.syncedProjection = PROJECTION;
    fiber.runFrames();
    expect(onSettled).not.toHaveBeenCalled();
    settle.appliedCamera = PROJECTION.camera;
    fiber.runFrames();
    expect(onSettled).toHaveBeenCalledTimes(1);
    // Exactly once per projection: later frames stay silent.
    fiber.runFrames();
    expect(onSettled).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("accepts a camera applied for a previous, content-equal projection", () => {
    // A host may reuse one camera value across rebuilt projections; the
    // applied camera object is not the projection's own, and the gate must
    // compare content, not identity.
    const settle: SettleLedger = {
      syncedProjection: PROJECTION,
      appliedCamera: cloneCamera(PROJECTION.camera),
    };
    const onSettled = vi.fn();
    const view = render(
      <SettleProbe
        camera={PROJECTION.camera}
        onSettled={onSettled}
        projection={PROJECTION}
        settle={settle}
      />,
    );
    fiber.runFrames();
    expect(onSettled).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("keeps waiting while the applied camera content differs", () => {
    const settle: SettleLedger = {
      syncedProjection: PROJECTION,
      appliedCamera: perspectiveCamera({ fovDeg: 41 }),
    };
    const onSettled = vi.fn();
    const view = render(
      <SettleProbe
        camera={PROJECTION.camera}
        onSettled={onSettled}
        projection={PROJECTION}
        settle={settle}
      />,
    );
    fiber.runFrames();
    expect(onSettled).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("CadScene settle wiring", () => {
  it("settles the mounted projection after its content applies, and re-settles an equal-content projection change", () => {
    const onSettled = vi.fn();
    const view = render(
      <CadScene
        projection={PROJECTION}
        onSettled={onSettled}
        showGround={false}
      />,
    );
    // render()'s act() has flushed the applying effects (geometry sync,
    // camera rig); the first demand frame therefore reports the projection.
    fiber.runFrames();
    expect(onSettled).toHaveBeenCalledTimes(1);
    // A content-equal projection: the geometry diff is a no-op (onSync stays
    // silent) and the rebuilt camera object is content-equal — the settle
    // protocol must still report it exactly once.
    const equal = makeProjection([makeObject("plate", FOLDED_SHEET_SHARED)]);
    view.rerender(
      <CadScene projection={equal} onSettled={onSettled} showGround={false} />,
    );
    fiber.runFrames();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });
});

describe("CadScene quality-mode render gate (Phase 59)", () => {
  // The quality post-processor is mounted ONLY behind the renderQuality
  // gate. A priority-1 useFrame takes the frame away from R3F's auto-render
  // even when its body is a no-op — an ALWAYS-mounted processor would blank
  // every standard-mode canvas (the pinned baselines' bytes). The mocked
  // fiber records each subscription's priority, so the gate class is
  // asserted at the unit level: standard mode registers no priority-1
  // subscriber and mounts no quality-only scene nodes; only quality mode
  // does (the shadow-catcher plane is the DOM-observable quality node —
  // boolean props like castShadow do not surface on these host elements).
  it("standard mode: no priority-1 frame subscriber and no quality-only nodes", () => {
    const view = render(<CadScene projection={PROJECTION} />);
    expect(
      fiber.framePriorities.filter((priority) => priority === 1),
    ).toHaveLength(0);
    expect(view.container.querySelector("shadowmaterial")).toBeNull();
    view.unmount();
  });

  it("quality mode: the processor mounts (priority-1) with the shadow catcher", () => {
    const view = render(
      <CadScene projection={PROJECTION} renderQuality="quality" />,
    );
    expect(
      fiber.framePriorities.filter((priority) => priority === 1).length,
    ).toBeGreaterThanOrEqual(1);
    const catcher = view.container.querySelector("shadowmaterial");
    expect(catcher).not.toBeNull();
    expect(catcher?.getAttribute("opacity")).toBe(
      String(CAD_QUALITY_SHADOW_GROUND_OPACITY),
    );
    view.unmount();
  });

  it("toggling quality off unmounts the gate's nodes and registers no new priority-1 frame", () => {
    const view = render(
      <CadScene projection={PROJECTION} renderQuality="quality" />,
    );
    expect(view.container.querySelector("shadowmaterial")).not.toBeNull();
    const before = fiber.framePriorities.length;
    view.rerender(<CadScene projection={PROJECTION} />);
    // The mocked useFrame re-registers on every render of a live subscriber,
    // so a permanently-mounted processor would re-register priority 1 here.
    expect(fiber.framePriorities.slice(before).includes(1)).toBe(false);
    expect(view.container.querySelector("shadowmaterial")).toBeNull();
    view.unmount();
  });
});
