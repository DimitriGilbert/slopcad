/**
 * The boot-failure report reader's defensive branches, mirroring the kernel
 * boot-report readers (`@slopcad/cad-kernel-manifold`'s
 * `manifold-worker-boot-report.test`): the reader is the main-thread
 * channel's ONLY view of a worker's death note, and the web entries send it
 * as one plain non-protocol message — so a malformed report must read as
 * absent, never crash the settlement path on its own. These tests pin the
 * null path: non-plain-record messages, plain records without the failure
 * key (every protocol message is one), and empty or non-string failure
 * texts all return `null`; a well-formed report parses verbatim.
 */

import { describe, expect, it } from "vitest";

import {
  parseWorkerBootFailureReport,
  WORKER_BOOT_FAILURE_KEY,
} from "./worker-boot-failure-report";

describe("parseWorkerBootFailureReport", () => {
  it("reads a well-formed report verbatim", () => {
    const message = "hosting the Manifold kernel failed: out of memory";
    expect(
      parseWorkerBootFailureReport({ [WORKER_BOOT_FAILURE_KEY]: message }),
    ).toEqual({
      message,
    });
  });

  it("rejects non-plain-record messages", () => {
    for (const data of [null, undefined, 42, "boot failed", []]) {
      expect(
        parseWorkerBootFailureReport(data),
        `data ${String(data)}`,
      ).toBeNull();
    }
  });

  it("rejects plain records without the failure key (every protocol message)", () => {
    expect(
      parseWorkerBootFailureReport({
        requestId: "1",
        operation: "solid.createBox",
      }),
    ).toBeNull();
  });

  it("rejects an empty failure text", () => {
    expect(
      parseWorkerBootFailureReport({ [WORKER_BOOT_FAILURE_KEY]: "" }),
    ).toBeNull();
  });

  it("rejects a non-string failure text", () => {
    expect(
      parseWorkerBootFailureReport({ [WORKER_BOOT_FAILURE_KEY]: 42 }),
    ).toBeNull();
  });
});
