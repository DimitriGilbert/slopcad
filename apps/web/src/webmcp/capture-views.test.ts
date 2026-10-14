// @vitest-environment node

/**
 * The `cad_capture_views` WebMCP tool (PLAN-AGENT-CHAT Phase 2.1, D10):
 * the capture views' camera math (REAL — pure float arithmetic, no DOM),
 * and the tool's orchestration through the registry boundary with the
 * snapshot machinery mocked (waitForRenderedFrame + captureViewportPng are
 * the only DOM-touching seams; base64 encoding stays real). No WebGL
 * anywhere — the orchestration mirrors the harness-proven user snapshot
 * path; live canvas execution is exercised in Phase 6's walk.
 *
 * Also pins the phase-wide output-shape constraint: the tool's RESULT
 * field names never contain apiKey-like fragments, so the relay's D1 deep
 * scan can never mistake a capture payload for a credential carrier.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type RenderCamera,
} from "@slopcad/cad-core";
import { createCadStore, type CadStore } from "@slopcad/cad-react";
import type * as SnapshotModule from "../cad-workbench/snapshot-export";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import { createCadWorkbenchSession } from "../cad-workbench/session";
import {
  captureViewCamera,
  captureViewName,
  captureViewportPng,
  waitForRenderedFrame,
} from "../cad-workbench/snapshot-export";
import {
  executeWebMcpTool,
  registerWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
  webMcpToolSnapshot,
} from "./registry";
import { bindWebMcpTools } from "./use-webmcp-tools";
import { createWorkbenchWebMcpTools } from "./workbench-tools";

/** The bytes the mocked canvas encoder "captures" — the PNG signature. */
const FAKE_PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** The FAKE_PNG_BYTES as the real base64 encoder must produce them. */
const FAKE_PNG_BASE64 = Buffer.from(FAKE_PNG_BYTES).toString("base64");

/** The module mock's own settle answer: the requested target, or 0 off-root. */
function defaultSettle(rootId: string, atLeast: number): Promise<number> {
  return Promise.resolve(rootId === "capture-test-root" ? atLeast : 0);
}

/** The module mock's own encode answer: a FAKE_PNG_BYTES blob. */
function defaultEncode(): Promise<Blob> {
  return Promise.resolve(new Blob([FAKE_PNG_BYTES]));
}

/**
 * The snapshot module with ONLY its two DOM seams replaced: the pure
 * camera math and the base64 encoding under test stay the real module.
 */
vi.mock("../cad-workbench/snapshot-export", async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotModule>();
  return {
    ...actual,
    captureViewportPng: vi.fn((): Promise<Blob | null> =>
      Promise.resolve(new Blob([FAKE_PNG_BYTES])),
    ),
    waitForRenderedFrame: vi.fn(
      (rootId: string, atLeast: number): Promise<number> =>
        Promise.resolve(rootId === "capture-test-root" ? atLeast : 0),
    ),
  };
});

/** The structured outcome of driving one tool through the registry. */
type ToolRun =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The box every camera-math test frames (30 × 20 × 10 mm). */
const BOUNDS = { max: [30, 20, 10], min: [0, 0, 0] } as const;

/** The mutable capture harness the tool drives. */
interface CaptureHarness {
  /** Every camera the overlay received, in order (including the restore). */
  readonly applied: readonly (RenderCamera | null)[];
  /** Whether the viewport's canvas answers (false = not mounted). */
  canvasMounted: boolean;
}

/** A fresh store over the app's own workbench session. */
function freshStore(): CadStore {
  return createCadStore({ session: createCadWorkbenchSession() });
}

/** Builds a real render state (projected body, kernel-shaped measurement). */
function renderStateOf(bodyId: string): PlateRenderState {
  const object = projectTessellation(createBodyId(bodyId), {
    indices: [0, 1, 2],
    positions: [0, 0, 0, 30, 0, 0, 0, 20, 0],
  });
  if (!object.ok) throw new Error(object.error.message);
  const projection = createRenderProjection([object.value], {
    fovDeg: 45,
    kind: "perspective",
    position: [80, -80, 60],
    target: [0, 0, 0],
    up: [0, 0, 1],
  });
  if (!projection.ok) throw new Error(projection.error.message);
  return {
    measurement: {
      area: 300,
      bounds: { max: [30, 20, 0], min: [0, 0, 0] },
      triangles: 1,
      tessellation: {
        indices: [0, 1, 2],
        positions: [0, 0, 0, 30, 0, 0, 0, 20, 0],
      },
      volume: 100,
    },
    projection: projection.value,
  };
}

/** Binds the workbench tools over a spied capture surface; returns the harness. */
function bindCaptureTools(options: {
  readonly applied: PlateRenderState | null;
  readonly convention?: "first-angle" | "third-angle";
  /** Overrides the fixture's constant 7 (the serialization suite's live ledger). */
  readonly renderedFrames?: () => number;
}): { readonly harness: CaptureHarness; readonly unbind: () => void } {
  const applied: (RenderCamera | null)[] = [];
  let currentCamera: RenderCamera | null = null;
  const harness: CaptureHarness = {
    applied,
    canvasMounted: true,
  };
  const unbind = bindWebMcpTools(
    createWorkbenchWebMcpTools({
      appliedState: () => options.applied,
      capture: {
        canvas: () => (harness.canvasMounted ? FAKE_CANVAS : null),
        convention: () => options.convention ?? "third-angle",
        renderedFrames: () => options.renderedFrames?.() ?? 7,
        rootId: "capture-test-root",
        setUserCamera: (camera) => {
          currentCamera = camera;
          applied.push(camera);
        },
        userCamera: () => currentCamera,
      },
      commands: () => [],
      measureText: () => null,
      mode: () => "model",
      regenerationIssue: () => null,
      sketchSolve: () => null,
      store: freshStore(),
      timeline: () => null,
    }),
  );
  return { harness, unbind };
}

/**
 * Drives the capture tool with raw JSON input through the registry
 * boundary, decoding the tool's own refusals the way the agent loop does.
 */
async function runCapture(input: unknown): Promise<ToolRun> {
  const outcome = await executeWebMcpTool("cad_capture_views", input, {
    signal: new AbortController().signal,
  });
  if (!outcome.ok) {
    return { code: outcome.code, message: outcome.message, ok: false };
  }
  const payload: unknown = JSON.parse(outcome.result);
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { readonly ok?: unknown }).ok === false
  ) {
    const refusal = payload as {
      readonly code: string;
      readonly message: string;
    };
    return { code: refusal.code, message: refusal.message, ok: false };
  }
  return { ok: true, payload };
}

afterEach(() => {
  // Full reset plus default reinstall: clearAllMocks alone would let a
  // test's swapped implementation (the serialization suite's fake ledger,
  // gated encodes) or an unconsumed once-queue leak into later tests.
  vi.mocked(waitForRenderedFrame).mockReset();
  vi.mocked(captureViewportPng).mockReset();
  vi.mocked(waitForRenderedFrame).mockImplementation(defaultSettle);
  vi.mocked(captureViewportPng).mockImplementation(defaultEncode);
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
});

/**
 * The mounted-canvas stand-in the spied surface answers with: node has no
 * DOM, and the only consumer of the canvas in this suite is the MOCKED
 * encoder, which never reads it.
 */
const FAKE_CANVAS = {} as HTMLCanvasElement;

describe("the capture view camera math (real, pure)", () => {
  it("frames a preset from the bounds center at the standard FOV", () => {
    const camera = captureViewCamera(
      { preset: "front" },
      { bounds: BOUNDS, convention: "third-angle" },
    );
    expect(camera.kind).toBe("perspective");
    if (camera.kind !== "perspective") return;
    expect(camera.fovDeg).toBe(40);
    expect(camera.target).toEqual([15, 10, 5]);
    expect(camera.up).toEqual([0, 0, 1]);
    // Front views from -Y: eye dead ahead of the center on that axis.
    expect(camera.position[0]).toBeCloseTo(15, 9);
    expect(camera.position[1]).toBeLessThan(10);
    expect(camera.position[2]).toBeCloseTo(5, 9);
  });

  it("uses the top view's own up for the top preset", () => {
    const camera = captureViewCamera(
      { preset: "top" },
      { bounds: BOUNDS, convention: "third-angle" },
    );
    expect(camera.up).toEqual([0, 1, 0]);
    expect(camera.position[2]).toBeGreaterThan(10);
  });

  it("puts third-angle iso at the front-top-right corner, first-angle mirrored", () => {
    const third = captureViewCamera(
      { preset: "iso" },
      { bounds: BOUNDS, convention: "third-angle" },
    );
    expect(third.position[0]).toBeGreaterThan(15);
    expect(third.position[1]).toBeLessThan(10);
    expect(third.position[2]).toBeGreaterThan(5);
    const first = captureViewCamera(
      { preset: "iso" },
      { bounds: BOUNDS, convention: "first-angle" },
    );
    expect(first.position[0]).toBeLessThan(15);
    expect(first.position[1]).toBeLessThan(10);
  });

  it("maps azimuth 0 / elevation 0 onto the right view's side", () => {
    const camera = captureViewCamera(
      { azimuth: 0, elevation: 0 },
      { bounds: BOUNDS, convention: "third-angle" },
    );
    expect(camera.position[0]).toBeGreaterThan(15);
    expect(camera.position[1]).toBeCloseTo(10, 9);
    expect(camera.position[2]).toBeCloseTo(5, 9);
  });

  it("reproduces the front preset to floating-point exactness from azimuth -90 / elevation 0", () => {
    const byAngle = captureViewCamera(
      { azimuth: -90, elevation: 0 },
      { bounds: BOUNDS, convention: "third-angle" },
    );
    const byPreset = captureViewCamera(
      { preset: "front" },
      { bounds: BOUNDS, convention: "third-angle" },
    );
    for (const axis of [0, 1, 2] as const) {
      expect(byAngle.position[axis]).toBeCloseTo(byPreset.position[axis], 9);
    }
    expect(byAngle.target).toEqual(byPreset.target);
    expect(byAngle.up).toEqual(byPreset.up);
  });

  it("lands elevation on the eye's height above the center's plane", () => {
    const camera = captureViewCamera(
      { azimuth: 0, elevation: 30 },
      { bounds: BOUNDS, convention: "third-angle" },
    );
    const offset: [number, number, number] = [
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    ];
    const distance = Math.hypot(offset[0], offset[1], offset[2]);
    expect(offset[2] / distance).toBeCloseTo(
      Math.sin((30 * Math.PI) / 180),
      12,
    );
    // The azimuth stays measurable in the horizontal components.
    expect(Math.atan2(offset[1], offset[0])).toBeCloseTo(0, 9);
  });

  it("frames every view of one bounds at the same distance", () => {
    const views = [
      { preset: "front" as const },
      { preset: "top" as const },
      { preset: "iso" as const },
      { azimuth: 120, elevation: -12 },
    ];
    const distances = views.map((view) => {
      const camera = captureViewCamera(view, {
        bounds: BOUNDS,
        convention: "third-angle",
      });
      return Math.hypot(
        camera.position[0] - camera.target[0],
        camera.position[1] - camera.target[1],
        camera.position[2] - camera.target[2],
      );
    });
    const [reference, ...others] = distances;
    if (reference === undefined) return;
    for (const distance of others) {
      expect(distance).toBeCloseTo(reference, 9);
    }
  });

  it("names parts after their view, angles rounded to whole degrees", () => {
    expect(captureViewName({ preset: "iso" })).toBe("view-iso.png");
    expect(captureViewName({ azimuth: -45, elevation: 30 })).toBe(
      "view-az-45-el30.png",
    );
    expect(captureViewName({ azimuth: 359.6, elevation: 0.4 })).toBe(
      "view-az360-el0.png",
    );
  });
});

describe("cad_capture_views (snapshot functions mocked)", () => {
  it("returns exactly one image part for a single view", async () => {
    const bound = bindCaptureTools({ applied: renderStateOf("body_plate") });
    const run = await runCapture({ views: [{ preset: "front" }] });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const payload = run.payload as {
      readonly images: {
        readonly name: string;
        readonly mimeType: string;
        readonly data: string;
      }[];
      readonly ok: boolean;
    };
    expect(payload.ok).toBe(true);
    expect(payload.images).toEqual([
      { data: FAKE_PNG_BASE64, mimeType: "image/png", name: "view-front.png" },
    ]);
    bound.unbind();
  });

  it("returns N images for N views, settled and restored in order", async () => {
    const bound = bindCaptureTools({ applied: renderStateOf("body_plate") });
    const run = await runCapture({
      views: [
        { preset: "iso" },
        { azimuth: 0, elevation: 10 },
        { azimuth: -90, elevation: 0 },
      ],
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const payload = run.payload as {
      readonly images: { readonly name: string }[];
    };
    expect(payload.images.map((image) => image.name)).toEqual([
      "view-iso.png",
      "view-az0-el10.png",
      "view-az-90-el0.png",
    ]);
    // One frame-settled wait per view (framesAtStart 7 → 8, 9, 10) plus the
    // restore settling one frame past what actually rendered (11) — the
    // tool waits on rendered evidence, never past the request count.
    const waits = vi.mocked(waitForRenderedFrame).mock.calls;
    expect(waits.map((call) => call[1])).toEqual([8, 9, 10, 11]);
    expect(waits.every((call) => call[0] === "capture-test-root")).toBe(true);
    // The overlay saw each view's camera, then the user's own camera back.
    expect(bound.harness.applied).toHaveLength(4);
    expect(bound.harness.applied[3]).toBeNull();
    expect(vi.mocked(captureViewportPng)).toHaveBeenCalledTimes(3);
    bound.unbind();
  });

  it("follows the session's angle convention for the iso preset", async () => {
    const third = bindCaptureTools({
      applied: renderStateOf("body_plate"),
      convention: "third-angle",
    });
    await runCapture({ views: [{ preset: "iso" }] });
    const thirdEye = third.harness.applied[0]?.position;
    third.unbind();
    vi.clearAllMocks();
    const first = bindCaptureTools({
      applied: renderStateOf("body_plate"),
      convention: "first-angle",
    });
    await runCapture({ views: [{ preset: "iso" }] });
    const firstEye = first.harness.applied[0]?.position;
    first.unbind();
    expect(thirdEye).toBeDefined();
    expect(firstEye).toBeDefined();
    if (thirdEye === undefined || firstEye === undefined) return;
    // Third angle frames the front-top-RIGHT corner; first angle mirrors X.
    expect(thirdEye[0]).toBeGreaterThan(15);
    expect(firstEye[0]).toBeLessThan(15);
  });

  it("refuses structurally before the scene has settled", async () => {
    const bound = bindCaptureTools({ applied: null });
    const run = await runCapture({ views: [{ preset: "front" }] });
    expect(run).toMatchObject({
      code: "workbench/capture-no-settled-scene",
      ok: false,
    });
    expect(bound.harness.applied).toEqual([]);
    bound.unbind();
  });

  it("refuses when the viewport canvas is absent, camera restored", async () => {
    const bound = bindCaptureTools({ applied: renderStateOf("body_plate") });
    bound.harness.canvasMounted = false;
    const run = await runCapture({ views: [{ preset: "top" }] });
    expect(run).toMatchObject({
      code: "workbench/capture-no-viewport",
      ok: false,
    });
    expect(bound.harness.applied[1]).toBeNull();
    // The restore settles one frame past what actually rendered (view 0's
    // wait reached 8) — never past the refused views' unreachable targets.
    const waits = vi.mocked(waitForRenderedFrame).mock.calls;
    expect(waits.map((call) => call[1])).toEqual([8, 9]);
    bound.unbind();
  });

  it("refuses when the canvas cannot be encoded, camera restored", async () => {
    vi.mocked(captureViewportPng).mockResolvedValueOnce(null);
    const bound = bindCaptureTools({ applied: renderStateOf("body_plate") });
    const run = await runCapture({ views: [{ azimuth: 30, elevation: 5 }] });
    expect(run).toMatchObject({
      code: "workbench/capture-failed",
      ok: false,
    });
    if (run.ok) return;
    expect(run.message).toContain("views[0]");
    expect(bound.harness.applied[1]).toBeNull();
    // Same rendered-evidence settle: 8 rendered, the restore waits 9.
    const waits = vi.mocked(waitForRenderedFrame).mock.calls;
    expect(waits.map((call) => call[1])).toEqual([8, 9]);
    bound.unbind();
  });

  it("rejects malformed input at the registry schema, never throwing", async () => {
    const bound = bindCaptureTools({ applied: renderStateOf("body_plate") });
    for (const bad of [
      { views: [] },
      { views: [{ preset: "back" }] },
      { views: [{ preset: "front", azimuth: 10 }] },
      { views: [{ azimuth: 10 }] },
      { views: [{ elevation: 10 }] },
      { views: [{ azimuth: 10, elevation: 90 }] },
      { views: [{ azimuth: 10, elevation: -89 }] },
      {
        views: Array.from({ length: 17 }, () => ({ preset: "front" })),
      },
      {},
    ]) {
      const run = await runCapture(bad);
      expect(run, `input ${JSON.stringify(bad)}`).toMatchObject({
        code: "webmcp/invalid-input",
        ok: false,
      });
    }
    // Nothing reached the overlay or the canvas through any refusal.
    expect(bound.harness.applied).toEqual([]);
    expect(vi.mocked(captureViewportPng)).not.toHaveBeenCalled();
    bound.unbind();
  });

  it("keeps every output field name free of apiKey-like fragments", async () => {
    const forbidden = ["token", "secret", "password", "credential", "key"];
    const bound = bindCaptureTools({ applied: renderStateOf("body_plate") });
    const outcome = await executeWebMcpTool(
      "cad_capture_views",
      { views: [{ preset: "front" }, { azimuth: 45, elevation: 20 }] },
      { signal: new AbortController().signal },
    );
    expect(outcome.ok).toBe(true);
    bound.unbind();
    if (!outcome.ok) return;
    const scan = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) scan(entry);
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const [fieldName, entry] of Object.entries(
          value as Record<string, unknown>,
        )) {
          const normalized = fieldName.toLowerCase();
          for (const fragment of forbidden) {
            expect(
              normalized.includes(fragment),
              `field "${fieldName}" must not contain "${fragment}"`,
            ).toBe(false);
          }
          scan(entry);
        }
      }
    };
    scan(JSON.parse(outcome.result));
  });

  it("queues a second run behind an in-flight one, never interleaved", async () => {
    // A LIVE ledger: every settle parks the count at the waited-for
    // target, so each run's wait targets record when it read the count.
    let ledger = 7;
    const bound = bindCaptureTools({
      applied: renderStateOf("body_plate"),
      renderedFrames: () => ledger,
    });
    vi.mocked(waitForRenderedFrame).mockImplementation(
      (_rootId: string, atLeast: number) => {
        ledger = Math.max(ledger, atLeast);
        return Promise.resolve(atLeast);
      },
    );
    // Hold the FIRST run mid-view at its encode; only that one call is
    // gated (once), so the queued run's encodes fall through to default.
    let releaseFirstRun!: () => void;
    const firstRunEncode = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    vi.mocked(captureViewportPng).mockImplementationOnce(() =>
      firstRunEncode.then(() => new Blob([FAKE_PNG_BYTES])),
    );
    // One macrotask: the first run is parked in its gated encode and the
    // second run is queued behind it — before any camera may move.
    const flush = (): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    try {
      const first = runCapture({ views: [{ preset: "front" }] });
      const second = runCapture({ views: [{ preset: "top" }] });
      await flush();
      // While the first run is mid-view, the second has touched nothing.
      expect(bound.harness.applied).toHaveLength(1);
      releaseFirstRun();
      const [firstRun, secondRun] = await Promise.all([first, second]);
      expect(firstRun.ok).toBe(true);
      expect(secondRun.ok).toBe(true);
      // The overlay saw, in order: first run's camera, first run's
      // restore, second run's camera, second run's restore.
      const shapeOf = (camera: RenderCamera | null): string => {
        if (camera === null) return "restored";
        return camera.position[2] > 10 ? "top" : "front";
      };
      expect(bound.harness.applied.map(shapeOf)).toEqual([
        "front",
        "restored",
        "top",
        "restored",
      ]);
      // The ledger proves the serialization: the second run read the
      // count only AFTER the first run's restore settled (9), so its
      // targets start at 10 — an interleaved run would have read 7 too
      // and waited on the first run's own targets.
      const waits = vi.mocked(waitForRenderedFrame).mock.calls;
      expect(waits.map((call) => call[1])).toEqual([8, 9, 10, 11]);
      // Each run's result labels its own camera — never the other's.
      const namesOf = (run: ToolRun): readonly string[] => {
        if (!run.ok) return [];
        const payload = run.payload as {
          readonly images: readonly { readonly name: string }[];
        };
        return payload.images.map((image) => image.name);
      };
      expect(namesOf(firstRun)).toEqual(["view-front.png"]);
      expect(namesOf(secondRun)).toEqual(["view-top.png"]);
    } finally {
      releaseFirstRun();
      bound.unbind();
    }
  });

  it("derives a JSON object schema for the registry snapshot", () => {
    const entries = createWorkbenchWebMcpTools({
      appliedState: () => null,
      capture: {
        canvas: () => null,
        convention: () => "third-angle",
        renderedFrames: () => 0,
        rootId: "capture-test-root",
        setUserCamera: () => {},
        userCamera: () => null,
      },
      commands: () => [],
      measureText: () => null,
      mode: () => "model",
      regenerationIssue: () => null,
      sketchSolve: () => null,
      store: freshStore(),
      timeline: () => null,
    });
    for (const entry of entries) registerWebMcpTool(entry);
    const tool = webMcpToolSnapshot().find(
      (snapshot) => snapshot.name === "cad_capture_views",
    );
    expect(tool).toBeDefined();
    if (tool === undefined) return;
    expect((tool.inputSchema as { readonly type?: string }).type).toBe(
      "object",
    );
    const views = (
      tool.inputSchema as {
        readonly properties?: Record<string, unknown>;
      }
    ).properties?.views;
    expect(views).toMatchObject({ maxItems: 16, minItems: 1, type: "array" });
  });
});
