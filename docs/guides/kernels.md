# Kernels

`@slopcad/cad-kernel` is the pluggable geometry-kernel abstraction. A
backend implements the `GeometryKernel` interface — primitives, profile
operations (extrude/revolve/sweep/loft), fillet/chamfer/shell/mirror,
booleans, transform, measurements, tessellation, dispose — behind opaque
solid handles, and declares what it can actually do through
`KernelCapabilities`. Four backends ship:

| Backend       | Package                        | Runtime                             | Role                                                             |
| ------------- | ------------------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| `manifold`    | `@slopcad/cad-kernel-manifold` | manifold-3d WASM (541 KB)           | the production mesh kernel                                       |
| `opencascade` | `@slopcad/cad-kernel-occt`     | replicad-opencascadejs WASM (23 MB) | exact BREP: fillet/chamfer/shell, STEP/BREP, persistent topology |
| `jscad`       | `@slopcad/cad-jscad`           | pure-JS `@jscad/modeling`           | the compatibility/reference backend, in-process                  |
| `fake`        | `@slopcad/cad-kernel`          | none                                | deterministic, dependency-free; the contract suite's reference   |

## The capability matrix

Read the flags from the kernels' own constants
(`packages/docs-examples/src/kernel/capabilities.ts` re-exports them; the
`/docs` page renders this table live):

| capability            | manifold | opencascade | jscad | fake |
| --------------------- | -------- | ----------- | ----- | ---- |
| booleans              | ✓        | ✓           | ✓     | ✓    |
| transformTranslation  | ✓        | ✓           | ✓     | ✓    |
| transformRotation     | —        | ✓           | ✓     | —    |
| exactPrimitiveVolumes | ✓        | ✓           | ✓     | ✓    |
| exactBooleanVolumes   | ✓        | ✓           | —     | —    |
| tightBooleanBounds    | ✓        | ✓           | ✓     | —    |
| persistentTopology    | —        | ✓           | —     | —    |
| sweep                 | —        | ✓           | ✓     | ✓    |
| loft                  | —        | ✓           | ✓     | ✓    |
| helix                 | —        | ✓           | —     | ✓    |
| fillet                | —        | ✓           | —     | ✓    |
| chamfer               | —        | ✓           | —     | ✓    |
| shell                 | —        | ✓           | —     | ✓    |
| mirror                | ✓        | ✓           | ✓     | ✓    |
| surfaceArea           | ✓        | ✓           | ✓     | ✓    |

(`transformScale` is declared `false` everywhere today — the flag exists
so a kernel can declare readiness before the input type grows to carry
it.)

Every capability-gated decline answers the structured
`kernel/unsupported-operation` — Manifold's `sweep`, its `fillet`,
JSCAD's `shell`, Manifold's and JSCAD's `helix`, all of them — never a
silently wrong approximation. The `helix` flag carries one per-kernel
subset twist: the fake kernel's analytic screw-solid model declines
OVERLAPPING turns (`kernel/helix-turn-overlap`) rather than
overcounting, while OCCT builds them — the general helical sweep is
OCCT territory (its ruled meridian stations sit at the derived
`sin(Δθ)/Δθ` chord band of the exact screw volume).
That discipline is the point of the flags: callers and suites branch on
the declaration upfront instead of discovering limits through failures.

## Booting a kernel

```ts
// In-process (Node or browser with the wasm:url pin):
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
} from "@slopcad/cad-kernel-manifold";
const kernel = manifoldKernelFromRuntime(await createManifoldRuntime());

// The fake kernel needs nothing:
import { createFakeKernel } from "@slopcad/cad-kernel";
const fake = createFakeKernel();
```

The runtime is a per-JavaScript-context singleton; use one kernel per
bridge (and per regeneration run). Browser bundles pin the wasm asset
with `import wasmUrl from "manifold-3d/manifold.wasm?url"` and hand it
to `createManifoldRuntime({ locateFile: () => wasmUrl })` — the
consumer fixture and the `/docs` page both do exactly this.

## Testing equality

`defineKernelContractSuite(createKernel, label, options?)` — from the
documented subpath `@slopcad/cad-kernel/contract-suite` — registers the
shared battery every conforming kernel runs (semantic, tolerance-based,
capability-aware; see [testing.md](testing.md)). Semantic assertion
helpers (`assertVolumeClose`, `assertBoundsEqual`,
`assertTessellationValid`, `expectKernelFailure`, `unwrapKernelResult`)
live on the main entry.

## The runnable example

`packages/docs-examples/src/kernel/primitives.ts` (the operation tour),
`src/kernel/capabilities.ts` (the matrix data), and
`src/contract-suite.test.ts` (the suite over a custom adapter).
