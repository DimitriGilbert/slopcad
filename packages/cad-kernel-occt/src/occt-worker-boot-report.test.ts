/**
 * The boot report reader's defensive branches (Phase 21.2 carry-fix): the
 * reader is the main thread's ONLY view of the worker's boot message, and
 * the web entry sends it as one plain non-protocol message — so a malformed
 * report must read as absent data, never as a zero cost or a crash. These
 * tests pin the null path: non-plain-record messages (every protocol
 * message is one), missing or empty asset URLs, and non-finite (or
 * negative) boot measurements all return `null`; a well-formed report
 * parses verbatim.
 */

import { describe, expect, it } from "vitest";

import {
  occtWorkerBootReport,
  OCCT_WORKER_BOOT_REPORT_KEY,
  OCCT_WORKER_BOOT_WASM_URL_KEY,
} from "./occt-worker-boot-report";

const WELL_FORMED = {
  [OCCT_WORKER_BOOT_REPORT_KEY]: 182.5,
  [OCCT_WORKER_BOOT_WASM_URL_KEY]: "/assets/replicad_single-B_1cTsn_.wasm",
} as const;

describe("occtWorkerBootReport", () => {
  it("reads a well-formed report verbatim", () => {
    expect(occtWorkerBootReport(WELL_FORMED)).toEqual({
      bootMs: 182.5,
      wasmUrl: WELL_FORMED[OCCT_WORKER_BOOT_WASM_URL_KEY],
    });
  });

  it("reads a bootMs of exactly zero as a measurement, not absence", () => {
    // 0 ms is finite and non-negative: an honest (unusually fast) reading.
    expect(
      occtWorkerBootReport({
        [OCCT_WORKER_BOOT_REPORT_KEY]: 0,
        [OCCT_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
      }),
    ).toEqual({ bootMs: 0, wasmUrl: "a.wasm" });
  });

  it("rejects non-plain-record messages (protocol traffic included)", () => {
    for (const data of [null, undefined, 42, "report", []]) {
      expect(occtWorkerBootReport(data), `data ${String(data)}`).toBeNull();
    }
  });

  it("rejects a missing url", () => {
    expect(
      occtWorkerBootReport({ [OCCT_WORKER_BOOT_REPORT_KEY]: 100 }),
    ).toBeNull();
  });

  it("rejects an empty or non-string url", () => {
    expect(
      occtWorkerBootReport({
        [OCCT_WORKER_BOOT_REPORT_KEY]: 100,
        [OCCT_WORKER_BOOT_WASM_URL_KEY]: "",
      }),
    ).toBeNull();
    expect(
      occtWorkerBootReport({
        [OCCT_WORKER_BOOT_REPORT_KEY]: 100,
        [OCCT_WORKER_BOOT_WASM_URL_KEY]: 42,
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
        occtWorkerBootReport({
          [OCCT_WORKER_BOOT_REPORT_KEY]: bootMs,
          [OCCT_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
        }),
        `bootMs ${String(bootMs)}`,
      ).toBeNull();
    }
  });

  it("rejects a negative or non-numeric boot measurement", () => {
    expect(
      occtWorkerBootReport({
        [OCCT_WORKER_BOOT_REPORT_KEY]: -1,
        [OCCT_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
      }),
    ).toBeNull();
    expect(
      occtWorkerBootReport({
        [OCCT_WORKER_BOOT_REPORT_KEY]: "fast",
        [OCCT_WORKER_BOOT_WASM_URL_KEY]: "a.wasm",
      }),
    ).toBeNull();
  });
});
