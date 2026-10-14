/**
 * The in-browser driver of the S5 oracle-vs-GPU tolerance matrix
 * (Phase 64b's WebGPU-under-Playwright/Dawn spike): the 64a harness
 * (`@slopcad/sim-flow`'s `runGpuOracleCase`) executed against the
 * PRODUCTION build's own WGSL provider, on whatever WebGPU device the
 * host exposes — the browser-real door the headless unit suites skip
 * loudly.
 *
 * The driver is deliberately thin: it feature-detects through the
 * provider's own seam (`requestWebGpuDevice`), runs every matrix case
 * {@link SIM_GPU_ORACLE_REPEATS} times (the spike's stability
 * measurement — the CPU oracle twin is bitwise deterministic, so any
 * repeat-to-repeat spread is the GPU path's), records each repeat's
 * deltas and tolerance violations verbatim, and publishes one JSON
 * shape the `/sim-gpu` fixture page stamps on its root attribute for
 * the Playwright spec to assert. No pass/fail is invented here: a
 * repeat is inside the recorded tolerances when its violations list is
 * empty, exactly the 64a gate's own arithmetic.
 *
 * Device provenance: beside the matrix, the report carries the adapter
 * the PAGE sees through its own guarded `navigator.gpu` probe — the
 * spike's findings doc records WHICH device class produced the numbers
 * (Dawn's SwiftShader software adapter on headless Linux), never a
 * fabricated hardware claim.
 */

import {
  GPU_ORACLE_MATRIX,
  type GpuOracleCaseReport,
  type GpuOracleTolerances,
  gpuOracleSkipReason,
  gpuOracleViolations,
  requestWebGpuDevice,
  runGpuOracleCase,
  type WgslDeviceSource,
} from "@slopcad/sim-flow";

/** How many times the spike runs each matrix case (stability spread). */
export const SIM_GPU_ORACLE_REPEATS = 3;

/** One repeat's full delta record — verbatim from the 64a report. */
export interface SimGpuOracleRepeat {
  readonly l2Relative: {
    readonly distribution: number;
    readonly rho: number;
    readonly ux: number;
    readonly uy: number;
    readonly drag: number;
    readonly lift: number;
  };
  readonly linfRelative: {
    readonly distribution: number;
    readonly rho: number;
    readonly ux: number;
    readonly uy: number;
    readonly drag: number;
    readonly lift: number;
  };
  /** Empty when the repeat sat inside the recorded tolerances. */
  readonly violations: readonly string[];
}

/** One matrix case's spike record: every repeat, in order. */
export interface SimGpuOracleCaseRecord {
  readonly id: string;
  readonly steps: number;
  readonly diverged: boolean;
  readonly repeats: readonly SimGpuOracleRepeat[];
}

/** The adapter provenance block (which device class ran the matrix). */
export interface SimGpuOracleAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

/** The whole published spike surface (JSON on the fixture's root). */
export interface SimGpuOracleRunReport {
  readonly phase: "running" | "done" | "failed";
  /** The adapter the page's own probe saw; null when `navigator.gpu` is absent. */
  readonly adapter: SimGpuOracleAdapterInfo | null;
  /** True when the provider's feature detect found no device (skip loudly). */
  readonly deviceAbsent: boolean;
  /** The loud skip reason, present exactly when `deviceAbsent`. */
  readonly skipReason: string | null;
  readonly repeatsPerCase: number;
  readonly cases: readonly SimGpuOracleCaseRecord[];
  readonly error: string | null;
}

/** The structural surface of a browser adapter's info block. */
interface BrowserAdapterInfo {
  readonly vendor?: unknown;
  readonly architecture?: unknown;
  readonly device?: unknown;
  readonly description?: unknown;
}

/** The structural surface of `navigator.gpu` the provenance probe reads. */
interface BrowserGpuSurface {
  requestAdapter(options?: {
    forceSoftwareAdapter?: boolean;
  }): Promise<BrowserAdapterSurface | null>;
}

interface BrowserAdapterSurface {
  readonly info?: unknown;
}

function isBrowserGpuSurface(value: unknown): value is BrowserGpuSurface {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly requestAdapter?: unknown }).requestAdapter ===
      "function"
  );
}

/**
 * Reads the page's adapter provenance (metadata only — the provider's
 * own feature detect stays its). Structural narrowing, no `any`; every
 * absent field records as an empty string.
 */
export async function readSimGpuAdapterProvenance(): Promise<SimGpuOracleAdapterInfo | null> {
  const navigatorMaybe = (globalThis as { readonly navigator?: unknown })
    .navigator;
  if (
    typeof navigatorMaybe !== "object" ||
    navigatorMaybe === null ||
    !("gpu" in navigatorMaybe)
  ) {
    return null;
  }
  const gpu = (navigatorMaybe as { readonly gpu?: unknown }).gpu;
  if (!isBrowserGpuSurface(gpu)) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null) return null;
    const info = adapter.info;
    if (typeof info !== "object" || info === null) {
      return { vendor: "", architecture: "", device: "", description: "" };
    }
    const source = info as BrowserAdapterInfo;
    const text = (value: unknown): string =>
      typeof value === "string" ? value : "";
    return {
      vendor: text(source.vendor),
      architecture: text(source.architecture),
      device: text(source.device),
      description: text(source.description),
    };
  } catch {
    return null;
  }
}

/** Maps one 64a report into the spike's published repeat record. */
export function simGpuOracleRepeatOf(
  report: GpuOracleCaseReport,
  tolerances: GpuOracleTolerances,
): SimGpuOracleRepeat {
  return {
    l2Relative: {
      distribution: report.distribution.l2Relative,
      rho: report.rho.l2Relative,
      ux: report.ux.l2Relative,
      uy: report.uy.l2Relative,
      drag: report.drag.l2Relative,
      lift: report.lift.l2Relative,
    },
    linfRelative: {
      distribution: report.distribution.linfRelative,
      rho: report.rho.linfRelative,
      ux: report.ux.linfRelative,
      uy: report.uy.linfRelative,
      drag: report.drag.linfRelative,
      lift: report.lift.linfRelative,
    },
    violations: gpuOracleViolations(report, tolerances),
  };
}

/** Options of {@link runSimGpuOracleMatrix}. */
export interface SimGpuOracleRunOptions {
  /** The device-source seam (the provider's own default when absent). */
  readonly deviceSource?: WgslDeviceSource;
  /** Repeats per case (defaults to {@link SIM_GPU_ORACLE_REPEATS}). */
  readonly repeats?: number;
  /** The adapter provenance block (the page probes it once per run). */
  readonly adapter?: SimGpuOracleAdapterInfo | null;
}

/**
 * Runs the oracle-vs-GPU matrix in-page: feature-detect through the
 * provider's seam, then every case `repeats` times. A device absence is
 * NOT a failure — the report carries the loud skip reason and the spec
 * treats it per the S5 law (the CPU oracle stays the test truth). An
 * execution error (a thrown harness case) IS a failure with its
 * message.
 */
export async function runSimGpuOracleMatrix(
  options: SimGpuOracleRunOptions = {},
): Promise<SimGpuOracleRunReport> {
  const repeats = options.repeats ?? SIM_GPU_ORACLE_REPEATS;
  const deviceSource = options.deviceSource ?? requestWebGpuDevice;
  const adapter = options.adapter === undefined ? null : options.adapter;
  const base = {
    adapter,
    repeatsPerCase: repeats,
  };
  let device;
  try {
    device = await deviceSource();
  } catch (error) {
    return {
      ...base,
      phase: "failed",
      deviceAbsent: false,
      skipReason: null,
      cases: [],
      error: `the device source threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (device === undefined) {
    return {
      ...base,
      phase: "done",
      deviceAbsent: true,
      skipReason: gpuOracleSkipReason(),
      cases: [],
      error: null,
    };
  }
  const records: SimGpuOracleCaseRecord[] = [];
  try {
    for (const testCase of GPU_ORACLE_MATRIX) {
      const repeatRecords: SimGpuOracleRepeat[] = [];
      let diverged = false;
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const report = await runGpuOracleCase(device, testCase);
        diverged = diverged || report.diverged;
        repeatRecords.push(simGpuOracleRepeatOf(report, testCase.tolerances));
      }
      records.push({
        id: testCase.id,
        steps: testCase.steps,
        diverged,
        repeats: repeatRecords,
      });
    }
  } catch (error) {
    return {
      ...base,
      phase: "failed",
      deviceAbsent: false,
      skipReason: null,
      cases: records,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    device.destroy();
  }
  return {
    ...base,
    phase: "done",
    deviceAbsent: false,
    skipReason: null,
    cases: records,
    error: null,
  };
}
