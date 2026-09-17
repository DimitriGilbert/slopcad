/**
 * The shared kernel contract suite run against the OpenCascade adapter
 * (Phase 21.1) — the second real kernel to face the suite after Manifold.
 * The suite's factory must be synchronous (it is invoked inside each
 * test), while the WASM initialization is async (~180 ms Node boot of a
 * ~22 MB binary), so the runtime is pre-initialized once in `beforeAll`
 * and the suite closes over the synchronous kernel constructor bound to
 * it. Every test still gets a FRESH kernel instance, preserving
 * per-instance ownership semantics.
 */

import { beforeAll, describe } from "vitest";
import { defineKernelContractSuite } from "@slopcad/cad-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

describe("occt kernel contract", () => {
  let runtime: OcctRuntime;

  beforeAll(async () => {
    runtime = await createOcctRuntime();
  });

  defineKernelContractSuite(() => occtKernelFromRuntime(runtime), "opencascade");
});
