/**
 * The Manifold boot report reader's defensive branches, mirroring the OCCT
 * twin's tests (`@slopcad/cad-kernel-occt`'s
 * `occt-worker-boot-report.test`): the reader is the main thread's ONLY
 * view of the worker's boot message, and the web entry sends it as one
 * plain non-protocol message — so a malformed report must read as absent
 * data, never as a zero cost or a crash. These tests pin the null path:
 * non-plain-record messages (every protocol message is one), missing or
 * empty asset URLs, and non-finite (or negative) boot measurements all
 * return `null`; a well-formed report parses verbatim.
 */

import { describe, expect, it } from "vitest";

import {
  manifoldWorkerBootReport,
  MANIFOLD_WORKER_BOOT_REPORT_KEY,
  MANIFOLD_WORKER_BOOT_WASM_URL_KEY,
} from "./manifold-worker-boot-report";

const WELL_FORMED = {
  [MANIFOLD_WORKER_BOOT_REPORT_KEY]: 42.5,
  [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: "/assets/manifold-B_1cTsn_.wasm",
} as const;

describe("manifoldWorkerBootReport", () => {
  it("reads a well-formed report verbatim", () => {
    expect(manifoldWorkerBootReport(WELL_FORMED)).toEqual({
      bootMs: 42.5,
      wasmUrl: WELL_FORMED[MANIFOLD_WORKER_BOOT_WASM_URL_KEY],
    });
  });

  it("reads a bootMs of exactly zero as a measurement, not absence", () => {
    // 0 ms is finite and non-negative: an honest (unusually fast) reading.
    expect(
      manifoldWorkerBootReport({
        [MANIFOLD_WORKER_BOOT_REPORT_KEY]: 0,
        [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
      }),
    ).toEqual({ bootMs: 0, wasmUrl: "a.wasm" });
  });

  it("rejects non-plain-record messages (protocol traffic included)", () => {
    for (const data of [null, undefined, 42, "report", []]) {
      expect(manifoldWorkerBootReport(data), `data ${String(data)}`).toBeNull();
    }
  });

  it("rejects a missing url", () => {
    expect(
      manifoldWorkerBootReport({ [MANIFOLD_WORKER_BOOT_REPORT_KEY]: 100 }),
    ).toBeNull();
  });

  it("rejects an empty or non-string url", () => {
    expect(
      manifoldWorkerBootReport({
        [MANIFOLD_WORKER_BOOT_REPORT_KEY]: 100,
        [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: "",
      }),
    ).toBeNull();
    expect(
      manifoldWorkerBootReport({
        [MANIFOLD_WORKER_BOOT_REPORT_KEY]: 100,
        [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: 42,
      }),
    ).toBeNull();
  });

  it("rejects non-finite boot measurements", () => {
    for (const bootMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        manifoldWorkerBootReport({
          [MANIFOLD_WORKER_BOOT_REPORT_KEY]: bootMs,
          [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
        }),
        `bootMs ${String(bootMs)}`,
      ).toBeNull();
    }
  });

  it("rejects a negative or non-numeric boot measurement", () => {
    expect(
      manifoldWorkerBootReport({
        [MANIFOLD_WORKER_BOOT_REPORT_KEY]: -1,
        [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
      }),
    ).toBeNull();
    expect(
      manifoldWorkerBootReport({
        [MANIFOLD_WORKER_BOOT_REPORT_KEY]: "fast",
        [MANIFOLD_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
      }),
    ).toBeNull();
  });
});
