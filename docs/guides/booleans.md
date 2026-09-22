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

## The workbench command (Phase 44)

The user-level surface rides the EXISTING feature kinds — `union`,
`subtract`, `intersect` have been bridge vocabulary since Phase 8; Phase
44 gives them the workbench's Boolean dialog (operation selector, target
body, one tool checkbox per feature-produced body, and a KEEP-TOOL
toggle) and the worker scene the session dispatches. The operands are
never deleted (history keeps every feature); "keep tools" therefore
rides the Phase 44 body VISIBILITY flags: ON (the default) leaves every
operand rendering, OFF consumes the tools — each tool body's
`body.update visible:false` lands in the same atomic transaction as the
boolean, so undo restores the display state with the feature.

```ts
doc = addFeature(doc, {
  id: F_CUT,
  kind: "subtract",
  inputs: [
    { kind: "feature", id: F_PLATE }, // the target
    { kind: "feature", id: F_TOOL }, // 1+ tools
  ],
  outputs: [B_PLATE_WITH_HOLE],
}).value.document;
```

The scene guards the composed semantics' degenerate corners: a union
that added nothing (coincident operands), a subtract that removed
nothing (a disjoint tool), and an intersect of disjoint operands each
reject the computation — the hole guard's discipline, never a silent
no-op settle.
