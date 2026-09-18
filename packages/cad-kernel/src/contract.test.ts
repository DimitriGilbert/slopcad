/**
 * Runs the shared kernel contract suite against the fake kernel. Any
 * conforming kernel (the Phase 9 Manifold adapter, and every kernel after
 * it) runs the identical suite through `defineKernelContractSuite`.
 */

import {
  createFakeKernel,
  FAKE_BOX_EDGE_TABLE,
  FAKE_BOX_FACE_TABLE,
} from "./fake-kernel";
import { defineKernelContractSuite } from "./contract-suite";

defineKernelContractSuite(createFakeKernel, "fake kernel", {
  // The fake kernel's own box-edge table (see fake-kernel): verticals are
  // ordinals 8-11; the last ordinal is the corner (x = width, y = depth),
  // and last and first-of-group are opposite corners — disjoint removed
  // regions. The same addresses serve the chamfer fixtures: the corner
  // prism and the fillet quadrant scope identically.
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
  // The fake kernel's own box-face table (see fake-kernel): ordinal 5 is
  // the z-high face — the fixture's required 10 mm-extent opening.
  shell: { openFace: FAKE_BOX_FACE_TABLE.length - 1 },
});
