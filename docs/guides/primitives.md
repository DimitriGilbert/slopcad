# Primitives

Primitives are the kernel contract's producer starting points: four
analytic solids created by any `GeometryKernel` (see [kernels.md](kernels.md)).
Inputs are dimensional values; outputs are opaque `KernelSolid` handles
owned by the kernel instance that minted them.

```ts
import { length } from "@slopcad/cad-core";
import { createFakeKernel } from "@slopcad/cad-kernel";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
} from "@slopcad/cad-kernel-manifold";

const kernel = createFakeKernel(); // or manifoldKernelFromRuntime(await createManifoldRuntime())

const box = kernel.createBox({
  width: length(30),
  depth: length(20),
  height: length(10),
});
if (!box.ok) throw new Error(box.error.message);

const sphere = kernel.createSphere({ radius: length(5) });
const cylinder = kernel.createCylinder({
  radius: length(4),
  height: length(10),
});
const cone = kernel.createCone({
  bottomRadius: length(4),
  topRadius: length(0),
  height: length(10),
});
```

## Conventions

- A box spans the axis-aligned region from the min corner at the origin;
  cylinders and cones run on the +z axis from `z = 0` to `z = height`;
  spheres are centred at the origin.
- Every measurement is a structured result: `volume(solid)` (mm³, 0 for
  an empty solid), `bounds(solid)` (fails `kernel/bounds-empty` when
  empty), `area(solid)` (the `surfaceArea` capability), and
  `tessellate(solid)` — a deterministic, valid, indexed triangle soup.
- Validation is honest: a non-positive length fails
  `kernel/invalid-length`; a negative cone top radius too. Nothing
  throws.
- Handles are nominal: pass a handle to a different kernel instance and
  every operation answers `kernel/solid-not-owned`.
- `dispose(solid)` releases kernel-side resources (a no-op that keeps
  the contract uniform on garbage-collected kernels).

## Fidelity, stated

Primitive volumes are analytic for the fake kernel and exact for
Manifold's box; curved primitives (sphere, cylinder, cone) on mesh
kernels are the documented inscribed discretization — a sphere of
radius 5 measures ≈511.9 mm³ against the analytic 523.6 (the contract
suite's 5% curved-volume band). The fake kernel's primitives are
analytic (`exactPrimitiveVolumes: true`).

## The runnable example

`packages/docs-examples/src/kernel/primitives.ts` runs the tour against
any kernel and reports volumes, area, and tessellation counts. The suite
asserts it over the real Manifold kernel (box 6000 mm³, area 2200 mm²,
12 triangles) and the fake kernel; the `/docs` page boots Manifold
in-process and shows the same numbers live.
