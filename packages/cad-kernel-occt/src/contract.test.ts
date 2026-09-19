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
import { defineKernelContractSuite } from "@slopcad/cad-kernel/contract-suite";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

describe("occt kernel contract", () => {
  let runtime: OcctRuntime;

  beforeAll(async () => {
    runtime = await createOcctRuntime();
  });

  defineKernelContractSuite(
    () => occtKernelFromRuntime(runtime),
    "opencascade",
    {
      // OCCT's box-edge snapshot ordinals (probed against the kernel's own
      // exploration): ordinals 0 and 2 are disjoint vertical edges of the
      // fixture box (corners (0,0) and (0,20) — their removed regions do not
      // interact) — the pair fillet/chamfer measures the analytic disjoint
      // sum.
      fillet: {
        cornerEdge: [0],
        oppositeEdges: [0, 2],
      },
      chamfer: {
        cornerEdge: [0],
        oppositeEdges: [0, 2],
      },
      // OCCT's box-face snapshot ordinals (probed against the kernel's own
      // exploration): ordinal 5 is the fixture box's top face — the z-high
      // 10 mm-extent opening the shell fixtures require.
      shell: { openFace: 5 },
    },
  );
});
