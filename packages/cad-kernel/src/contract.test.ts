/**
 * Runs the shared kernel contract suite against the fake kernel. Any
 * conforming kernel (the Phase 9 Manifold adapter, and every kernel after
 * it) runs the identical suite through `defineKernelContractSuite`.
 */

import { createFakeKernel } from "./fake-kernel";
import { defineKernelContractSuite } from "./contract-suite";

defineKernelContractSuite(createFakeKernel, "fake kernel");
