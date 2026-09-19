# Custom kernel adapters

A kernel adapter maps the `GeometryKernel` contract onto an engine. The
contract (see [kernels.md](kernels.md)) is one interface plus one
capability record; implement it honestly and everything above — the
feature bridge, the worker protocol, the renderer, the UI — works
unchanged.

## The rules that matter

1. **Handles are yours.** `KernelSolid` is opaque; mint them with the
   kernel-internal `createSolidTag` (`@slopcad/cad-kernel/opaque`,
   kernel-implementers only). A handle from another instance fails every
   operation with `kernel/solid-not-owned` — check ownership on every
   entry point.
2. **Nothing throws.** Every operation returns a
   `KernelResult` (`ok`/`fail`) with a stable `kernel/*` code
   (`KERNEL_ERROR_CODES`). `dispose` never fails.
3. **Declare capabilities truthfully.** `KernelCapabilities` is the
   contract callers branch on. An engine without sweep answers
   `kernel/unsupported-operation` and declares `sweep: false` — the
   discipline every shipped adapter follows (Manifold's sweep/loft/
   fillet/chamfer/shell declines, JSCAD's fillet/chamfer/shell).
4. **Canonical units.** Lengths arrive as dimensional values; geometry
   and measurements answer in canonical millimetres (radians for
   angles).

## The smallest honest adapter

```ts
import { withOperationLog } from "@slopcad/docs-examples/kernel/custom-adapter";
// wraps ANY GeometryKernel, delegating every operation verbatim and
// recording the call names — the pattern to copy for a real engine mapping
```

The example's `withOperationLog` implements the full interface by
delegation: one line per operation, capabilities passed through
unchanged, no geometry invented. A real adapter replaces each delegation
with its engine call — the shipped ones (`manifold-kernel.ts`,
`occt-kernel.ts`, `jscad-kernel.ts`) are the reference implementations,
each mapping placement conventions, measurement exactness, and
tessellation deflection onto its engine.

## Prove it with the shared suite

```ts
import { defineKernelContractSuite } from "@slopcad/cad-kernel/contract-suite";
defineKernelContractSuite(() => withOperationLog(createFakeKernel()), "my adapter", {
  fillet:  { cornerEdge: [...], oppositeEdges: [...] },  // your engine's
  chamfer: { cornerEdge: [...], oppositeEdges: [...] },  // fixture addresses
  shell:   { openFace: ... },
});
```

The suite is semantic and capability-aware (analytic volumes with
documented bands, exact bounds where geometry is exact, structural
tessellation validity, determinism, structured error paths). The
documented subpath keeps the runtime index importable without vitest.
`packages/docs-examples/src/contract-suite.test.ts` runs exactly this
pattern over the logged wrapper — green, 47 tests.

## The worker twin (optional)

To host the adapter off-thread, add the two worker entries following
`manifold-worker.web.ts` / `manifold-worker.node.ts` (the shared
`createNodeWorkerChannel` factory parameterizes the Node channel by
entry URL), and pin your wasm asset with a `?url` import.
