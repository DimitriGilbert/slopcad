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
| transformScale        | ✓        | ✓           | ✓     | ✓    |
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
| thicken               | —        | ✓           | —     | ✓    |
| extrudeTaper          | —        | ✓           | ✓     | ✓    |
| mirror                | ✓        | ✓           | ✓     | ✓    |
| surfaceArea           | ✓        | ✓           | ✓     | ✓    |

Every capability-gated decline answers the structured
`kernel/unsupported-operation` — Manifold's `sweep`, its `fillet`,
JSCAD's `shell`, Manifold's and JSCAD's `helix`, all of them — never a
silently wrong approximation. Phase 41's additions: the uniform
`transformScale` is the mirror precedent (every kernel implements it —
OCCT through `gp_Trsf.SetScale`, the mesh kernels through their affine
matrices); `thicken` (the CLOSED hollow, `MakeThickSolidByJoin`'s cavity
plus one exact cut on OCCT, the analytic box/sphere subset on the fake
kernel) declines on Manifold and JSCAD (no 3D offset — the shell
verdict); `extrudeTaper` (the draft wall-angle on `extrude`) builds on
OCCT (`BRepOffsetAPI_DraftAngle`, declining ellipse/spline loops per
shape — its face domain is planar/cylindrical) and the chord-model
kernels (the fake kernel's two-station inset loft, JSCAD's
`extrudeFromSlices` pair), while Manifold declines — its extrude's
uniform top-scale is a provably different solid, never a draft. The
`helix` flag carries one per-kernel
subset twist: the fake kernel's analytic screw-solid model declines
OVERLAPPING turns (`kernel/helix-turn-overlap`) rather than
overcounting, while OCCT builds them — the general helical sweep is
OCCT territory (its ruled meridian stations sit at the derived
`sin(Δθ)/Δθ` chord band of the exact screw volume).
That discipline is the point of the flags: callers and suites branch on
the declaration upfront instead of discovering limits through failures.

## Derived coverage: the structured hole types (Phase 42)

The structured hole feature composes EXISTING ops — no new capability
flag — so its per-kernel coverage DERIVES from the flags above: every
type except the threaded one is one revolved meridian per position plus
one subtract (`revolve` + `booleans`, which every kernel implements),
and the threaded type adds Phase 40's ISO ridge sweep (`helix`):

| structured hole type                         | manifold | opencascade | jscad | fake |
| -------------------------------------------- | -------- | ----------- | ----- | ---- |
| straight / counterbore / countersink / taper | ✓        | ✓           | ✓     | ✓    |
| threaded (pilot + ISO ridge)                 | —        | ✓           | —     | ✓    |

The threaded decline is the bridge's capability gate (a feature
diagnostic naming the `helix` flag, before any geometry — the
mirror/scale precedent), not a per-call `kernel/unsupported-operation`.
Volumes: straight-edge meridians revolve to EXACT analytic
cylinders/cones on the fake kernel (Pappus closed form) and OCCT
(BREP), with the mesh kernels inside their documented sweep-angle chord
band; the threaded ridge rides Phase 40's exact screw-volume model and
OCCT's ruled band.

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
