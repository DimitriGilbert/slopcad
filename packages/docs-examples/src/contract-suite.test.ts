/**
 * The docs-examples proof suite, part 2: the testing guide's headline
 * pattern — one shared contract suite every conforming kernel runs
 * (docs/guides/testing.md). The suite here judges the custom adapter's
 * logged wrapper around the fake kernel (the custom-kernels guide's
 * example), proving both documented claims at once: the wrapper is a
 * conforming kernel, and `defineKernelContractSuite` accepts any
 * implementation of the contract.
 *
 * Imported from the documented subpath `@slopcad/cad-kernel/contract-suite`
 * (the runtime index deliberately keeps the vitest-dependent suite out —
 * see the cad-kernel index's note).
 */

import { FAKE_BOX_EDGE_TABLE, FAKE_BOX_FACE_TABLE } from "@slopcad/cad-kernel";
import { defineKernelContractSuite } from "@slopcad/cad-kernel/contract-suite";

import { createLoggedFakeKernel } from "./kernel/custom-adapter";

defineKernelContractSuite(createLoggedFakeKernel, "docs fake kernel (logged)", {
  // The fake kernel's own box-edge/box-face tables (see fake-kernel): the
  // same fixture addresses its own contract.test.ts passes.
  fillet: {
    cornerEdge: [FAKE_BOX_EDGE_TABLE.length - 1],
    oppositeEdges: [
      FAKE_BOX_EDGE_TABLE.length - 1,
      FAKE_BOX_EDGE_TABLE.length - 4,
    ],
  },
  chamfer: {
    cornerEdge: [FAKE_BOX_EDGE_TABLE.length - 1],
    oppositeEdges: [
      FAKE_BOX_EDGE_TABLE.length - 1,
      FAKE_BOX_EDGE_TABLE.length - 4,
    ],
  },
  shell: { openFace: FAKE_BOX_FACE_TABLE.length - 1 },
});
