/**
 * The plate-workbench example's kernel-solid discipline (review Phase 9.B):
 * Manifold payloads are freed only in `dispose`, so every handle a build
 * mints must be released — success path and refusal paths included — each
 * exactly once (a zero translate aliases `moved` to `drilled`), and the
 * page-level kernel memo must clear on rejection so a transient WASM-load
 * failure stays retryable (the runtime's own documented semantics). The
 * Manifold module is mocked with a counting wrapper over the fake kernel,
 * so the tests observe mints and disposals without loading real WASM.
 */

import { describe, expect, it, vi } from "vitest";
import {
  KERNEL_ERROR_CODES,
  createFakeKernel,
  type GeometryKernel,
  type KernelResult,
  type KernelSolid,
} from "@slopcad/cad-kernel";
import type { PlateBuild } from "./plate-geometry";

const manifoldMocks = vi.hoisted(() => ({
  createRuntime: vi.fn<() => Promise<unknown>>(),
  kernelFromRuntime: vi.fn<(runtime: unknown) => GeometryKernel>(),
}));

vi.mock("@slopcad/cad-kernel-manifold", () => ({
  createManifoldRuntime: manifoldMocks.createRuntime,
  manifoldKernelFromRuntime: manifoldMocks.kernelFromRuntime,
}));

vi.mock("manifold-3d/manifold.wasm?url", () => ({
  default: "/test-manifold.wasm",
}));

/** The marker the mocked runtime resolves with (opaque to the mocks). */
const RUNTIME_MARKER = { runtime: true } as const;

/** What the counting wrapper exposes to a test's assertions. */
interface CountingKernel {
  readonly kernel: GeometryKernel;
  /** Every handle the kernel minted, in mint order (aliases included). */
  readonly minted: readonly KernelSolid[];
  /** Total `dispose` calls that reached the kernel. */
  readonly disposeCalls: () => number;
  /** `dispose` calls per handle (handles are identity-keyed). */
  readonly disposeCounts: () => ReadonlyMap<KernelSolid, number>;
}

function createCountingKernel(
  options: {
    /** Fails every `subtract`, structurally. */
    readonly failSubtract?: boolean;
  } = {},
): CountingKernel {
  const base = createFakeKernel();
  const minted: KernelSolid[] = [];
  const counts = new Map<KernelSolid, number>();
  let calls = 0;
  const track = (
    result: KernelResult<KernelSolid>,
  ): KernelResult<KernelSolid> => {
    if (result.ok) {
      minted.push(result.value);
    }
    return result;
  };
  const kernel: GeometryKernel = {
    ...base,
    createBox: (input) => track(base.createBox(input)),
    createCylinder: (input) => track(base.createCylinder(input)),
    transform: (solid, input) => track(base.transform(solid, input)),
    subtract: options.failSubtract
      ? (target, tools) => ({
          ok: false,
          error: {
            code: KERNEL_ERROR_CODES.invalidOperands,
            message: "injected subtract rejection",
            input: { target, tools: tools.length },
          },
        })
      : (target, tools) => track(base.subtract(target, tools)),
    dispose: (solid) => {
      calls += 1;
      counts.set(solid, (counts.get(solid) ?? 0) + 1);
      base.dispose(solid);
    },
  };
  return {
    kernel,
    minted,
    disposeCalls: () => calls,
    disposeCounts: () => counts,
  };
}

/**
 * The module-under-test surface the tests drive (the dynamic import below
 * is structurally checked against this, so signature drift fails here).
 */
interface PlateGeometrySurface {
  readonly getPlateKernel: () => Promise<GeometryKernel>;
  readonly buildPlateProjection: (parameters: {
    readonly holeDiameterMm: number;
    readonly translateMm: readonly [number, number, number];
  }) => Promise<PlateBuild>;
}

/** Loads the module under test fresh (its kernel memo is module state). */
async function loadPlateGeometry(): Promise<PlateGeometrySurface> {
  vi.resetModules();
  manifoldMocks.createRuntime.mockReset();
  manifoldMocks.kernelFromRuntime.mockReset();
  manifoldMocks.createRuntime.mockResolvedValue(RUNTIME_MARKER);
  manifoldMocks.kernelFromRuntime.mockImplementation(() => createFakeKernel());
  return import("./plate-geometry");
}

/** Installs a specific kernel as the module-level kernel memo's target. */
function installKernel(counting: CountingKernel): void {
  manifoldMocks.kernelFromRuntime.mockReturnValue(counting.kernel);
}

/** Every recorded dispose ran exactly once over exactly these handles. */
function expectEveryHandleDisposedExactlyOnce(
  counting: CountingKernel,
  expected: readonly KernelSolid[],
): void {
  const counts = counting.disposeCounts();
  expect(counts.size).toBe(expected.length);
  for (const handle of expected) {
    expect(counts.get(handle)).toBe(1);
  }
  expect(counting.disposeCalls()).toBe(expected.length);
}

describe("getPlateKernel", () => {
  it("re-invokes the factory after a rejected initialization, then memoizes success", async () => {
    const { getPlateKernel } = await loadPlateGeometry();
    manifoldMocks.createRuntime.mockRejectedValueOnce(
      new Error("wasm fetch failed"),
    );
    await expect(getPlateKernel()).rejects.toThrow("wasm fetch failed");

    const kernel = createFakeKernel();
    manifoldMocks.kernelFromRuntime.mockReturnValue(kernel);
    await expect(getPlateKernel()).resolves.toBe(kernel);

    // The successful kernel is memoized: a later call returns the same
    // instance without re-running the factory.
    await expect(getPlateKernel()).resolves.toBe(kernel);
    expect(manifoldMocks.createRuntime).toHaveBeenCalledTimes(2);
  });
});

describe("buildPlateProjection", () => {
  it("disposes every minted handle exactly once after a successful zero-translate build", async () => {
    const counting = createCountingKernel();
    const { buildPlateProjection } = await loadPlateGeometry();
    installKernel(counting);
    const build = await buildPlateProjection({
      holeDiameterMm: 8,
      translateMm: [0, 0, 0],
    });
    expect(build.ok).toBe(true);
    // A zero translate aliases `moved` to `drilled` (no transform call):
    // 4 mints, 4 distinct handles, each released exactly once.
    expect(counting.minted).toHaveLength(4);
    const distinct = [...new Set(counting.minted)];
    expect(distinct).toHaveLength(4);
    expectEveryHandleDisposedExactlyOnce(counting, distinct);
  });

  it("disposes every minted handle exactly once after a successful translated build", async () => {
    const counting = createCountingKernel();
    const { buildPlateProjection } = await loadPlateGeometry();
    installKernel(counting);
    const build = await buildPlateProjection({
      holeDiameterMm: 8,
      translateMm: [4, 2, 1],
    });
    expect(build.ok).toBe(true);
    // A non-zero translate mints a distinct `moved`: 5 distinct handles.
    expect(counting.minted).toHaveLength(5);
    expectEveryHandleDisposedExactlyOnce(counting, counting.minted);
    expect(counting.disposeCalls()).toBe(5);
  });

  it("disposes the mints so far when the build refuses mid-pipeline", async () => {
    const counting = createCountingKernel({ failSubtract: true });
    const { buildPlateProjection } = await loadPlateGeometry();
    installKernel(counting);
    const build = await buildPlateProjection({
      holeDiameterMm: 8,
      translateMm: [0, 0, 0],
    });
    expect(build).toMatchObject({
      ok: false,
      error: "injected subtract rejection",
    });
    // The subtract never minted: exactly the three prior mints (plate,
    // bore, placed bore) are released — each exactly once.
    expect(counting.minted).toHaveLength(3);
    expectEveryHandleDisposedExactlyOnce(counting, counting.minted);
  });
});
