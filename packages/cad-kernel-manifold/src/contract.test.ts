/**
 * The shared Phase 8 kernel contract suite run against the Manifold
 * adapter. The suite's factory must be synchronous (it is invoked inside
 * each test), while Manifold's WASM initialization is async — so the
 * runtime is pre-initialized once in `beforeAll` and the suite closes
 * over the synchronous kernel constructor bound to it. Every test still
 * gets a FRESH kernel instance, preserving per-instance ownership
 * semantics.
 */

import { beforeAll, describe } from "vitest";
import { defineKernelContractSuite } from "@slopcad/cad-kernel/contract-suite";

import { manifoldKernelFromRuntime } from "./manifold-kernel";
import {
  type ManifoldRuntime,
  createManifoldRuntime,
} from "./manifold-runtime";

describe("manifold kernel contract", () => {
  let runtime: ManifoldRuntime;

  beforeAll(async () => {
    runtime = await createManifoldRuntime();
  });

  defineKernelContractSuite(
    () => manifoldKernelFromRuntime(runtime),
    "manifold",
  );
});
