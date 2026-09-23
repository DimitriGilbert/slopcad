# STEP / IGES

The OpenCascade backend owns the BREP exchange paths. All of them are
geometry-only: **no STEP, BREP, or IGES file preserves parametric
history**, and the code refuses to fabricate any — imported solids carry
a provenance literal so the data itself says so.

## STEP export (deterministic Part 21)

```ts
import {
  OCCT_KERNEL_CAPABILITIES,
  STEP_EXPORT_SCHEMAS,
  STEP_EXPORT_UNITS,
} from "@slopcad/cad-kernel-occt";

const kernel = occtKernelFromRuntime(await createOcctRuntime());
const exported = kernel.exportStep([solid]); // → Uint8Array
const withOptions = kernel.exportStep([solid], {
  unit: "MM",
  schema: "AP214IS",
});
```

- Schemas: `AP214IS` (default — the mechanical BREP AP), `AP203`,
  `AP242DIS`. Units: `MM CM M KM INCH FT MI MIL UM UIN`.
- Determinism is enforced, not hoped for: the writer's timestamp is
  neutralized to `STEP_EXPORT_EPOCH_STAMP` and product names renumbered
  — and if the header is not where the probes found it, export refuses
  with `step-export/nondeterministic` rather than emit bytes it cannot
  vouch for. Same solids in, same bytes out, across fresh runtimes.

## STEP import

```ts
const imported = kernel.importStep(bytes);
imported.value.solids[0]?.origin; // "imported-step" — the no-history marker, in data
```

Each `TopAbs_SOLID` becomes a real BREP solid in canonical millimetres
(a file written in INCH imports at the same mm volume as its mm twin —
verified behaviorally, ~1e-12 relative). What import does NOT preserve:
product NAME and COLOR — reading those needs the XCAF document layer,
whose `STEPCAFControl_*` classes are not bound in this build (probed;
see `docs/architecture/occt-prespike-findings.md` §5). Over the worker
protocol the same paths are `step.export` / `step.import`.

## BREP

`kernel.importBrep(bytes)` / `kernel.exportBrep(solids)` — the STEP twin
over OCCT's native ASCII BREP form, provenance `"imported-brep"`, mm by
construction.

## IGES (import-only, meshes)

The primary binding ships zero callable IGES classes, so IGES rides the
plan-sanctioned fallback: `occt-import-js@0.0.23` (a separate
7,604,031-byte / 7.6 MB emscripten wasm — 7.25 MiB, which the source
comment rounds to 7.3 — ~37 ms init). The honest scope: it reads CAD
files to **tessellations, not solids** — an IGES import yields mesh
bodies, the same class an STL import produces, never a kernel solid:

```ts
import { createIgesEngine, importIgesMeshes } from "@slopcad/cad-kernel-occt";

const engine = await createIgesEngine(); // memoized per JS context
const model = importIgesMeshes(engine, bytes); // default linearUnit: millimeter
if (model.ok) model.value.meshes[0]?.tessellation; // + name + brepFaces count
```

**IGES export is a documented decline (Phase 56 probe).** The fallback
wasm is import-only (zero callable IGES writer classes — probed), and the
primary binding ships none either; no IGES writer exists on any surface.
Callers needing an interchange BREP export have STEP (deterministic,
above); this page stays the source of truth until a binding grows the
writer.

## STEP names/colors/assembly structure (the Phase 56 block)

Reading product NAME and COLOR needs the XCAF document layer, whose
`STEPCAFControl_*` classes are not bound in this build (probed;
`docs/architecture/occt-prespike-findings.md` §5) — the same probe gates
writing them: export carries geometry only, no names beyond the
renumbered translator literals and no colour/style entities at all. The
decline is pinned in bytes by `occt-step-export.test.ts` (the Phase 56
documented-decline test); no metadata is fabricated. The path to richness
is an upstream binding request (replicad-opencascadejs is actively
maintained; the `GTransform` fork precedent), not an in-repo writer.

## The runnable example

`packages/docs-examples/src/kernel/occt.ts` runs the whole chain on a
real OCCT worker thread — box → topology → fillet → STEP export →
re-import (provenance `"imported-step"`, volume agreement < 1e-9
relative) — plus the IGES fixture import (`fixtures/cube-10mm.igs`, a
mesh of ~10 mm extents).
