# Booleans

The kernel contract carries three boolean operations — `union`,
`subtract`, `intersect` — over opaque solid handles from the same kernel
instance:

```ts
import { length } from "@slopcad/cad-core";

const union = kernel.union([box, boxFar]); // 2+ operands
const cut = kernel.subtract(box, [cutter]); // target minus tools (1+)
const both = kernel.intersect([box, boxFar]); // disjoint → empty solid
```

## Semantics and honesty

- Every kernel in the repo implements booleans (`booleans: true` across
  the capability matrix — see [kernels.md](kernels.md)).
- **Exactness is declared, not assumed.** Manifold computes exact mesh
  volumes (`exactBooleanVolumes: true`, tight bounds). The fake kernel
  computes boolean volumes by deterministic voxel quadrature
  (`exactBooleanVolumes: false`) and returns conservative containers for
  subtract/intersect (`tightBooleanBounds: false`). JSCAD declines
  exactness for volumes (`false`) while keeping tight bounds. The shared
  contract suite branches its assertions on these flags — exactness
  where declared, documented bands where not.
- An empty result is a valid solid (volume 0), not an error.
  `tessellate` of a boolean result is a deterministic candidate soup;
  semantic truth lives in `volume`/`bounds`.

## Worked numbers (Manifold, asserted by the suite)

Two 30×20×10 boxes offset by 15 mm in x overlap in exactly 15×20×10:

```text
union      = 9000 mm³      (2 × 6000 − 3000 overlap)
intersect  = 3000 mm³
subtract(box, [r=4 cylinder at the box's min corner, h=10])
           = 6000 − (π·4²·10)/4 mm³   (a quarter of the cutter is inside)
```

## The runnable example

`packages/docs-examples/src/kernel/primitives.ts` computes all three
against the caller's kernel; the suite pins the Manifold numbers above
(plus the discretization band on the curved cut) and the `/docs` page
shows them live.
