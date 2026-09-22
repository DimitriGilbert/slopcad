# slopcad documentation

A browser-native parametric CAD stack: a kernel-neutral document model
(`@slopcad/cad-core`), pluggable geometry kernels (Manifold, OpenCascade,
JSCAD, a deterministic fake), a worker protocol, an R3F renderer, a
parametric sketch domain, reusable components, and a shadcn-style registry
that installs all of it into any Vite + React app.

This directory is the documentation home. Two rules govern it:

1. **Every guide is grounded in the code on this branch.** API names,
   signatures, numbers, and behaviors come from the source. When a guide
   and the code disagree, the guide is wrong — fix the guide.
2. **Every primary public API gets a runnable example where applicable.**
   The examples live in `packages/docs-examples`, `pnpm verify`
   typechecks, builds, and runs them, and the `/docs` page of the web app
   executes the browser-safe ones live.

## The topic map

| Group                   | Topics                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundations             | [installation](guides/installation.md) · [CAD core](guides/cad-core.md) · [parameters](guides/parameters.md) · [expressions](guides/expressions.md) · [units](guides/units.md) |
| Geometry                | [primitives](guides/primitives.md) · [booleans](guides/booleans.md) · [features](guides/features.md) · [kernels](guides/kernels.md) · [workers](guides/workers.md)             |
| Assemblies              | [assemblies](guides/assemblies.md)                                                                                                                                             |
| Rendering & interaction | [R3F](guides/r3f.md) · [selection](guides/selection.md) · [tools](guides/tools.md) · [UI components](guides/ui.md)                                                             |
| Data exchange           | [native files](guides/native-files.md) · [STL/3MF/GLB](guides/mesh-exchange.md) · [STEP/IGES](guides/step-iges.md)                                                             |
| Sketching               | [sketches](guides/sketches.md) · [constraints](guides/constraints.md)                                                                                                          |
| Distribution            | [registry](guides/registry.md) · [reusable components](guides/components.md) · [custom tools](guides/custom-tools.md) · [custom kernel adapters](guides/custom-kernels.md)     |
| Engineering             | [testing](guides/testing.md) · [package boundaries](guides/package-boundaries.md)                                                                                              |

The `/docs` route of `apps/web` renders this map with the live examples
(gate: `pnpm test:docs`). The architecture record lives in
[architecture/](architecture/) — the dependency map, ADRs, baselines,
spike findings, and the Phase 35
[public API audit](architecture/api-audit.md).

## How the examples are gated

`packages/docs-examples` is a workspace package. `pnpm verify` runs, for
every workspace package: `check-types` (`tsc --noEmit`), `lint`, `test`
(vitest — the docs suite _executes_ each example and asserts the outcomes
the guides state), and `build`. The browser examples are additionally
driven by the Playwright suite `e2e-docs/` against the production build.

## The three-minute tour

```ts
import {
  createDocument,
  createDocumentId,
  addBody,
  addDocumentParameter,
  addFeature,
  length,
  createBodyId,
  createParameterId,
} from "@slopcad/cad-core";

let doc = createDocument(createDocumentId("doc_demo"));
doc = addBody(doc, { id: createBodyId("body_plate"), name: "plate" }).value
  .document;
doc = addDocumentParameter(doc, {
  id: createParameterId("param_hole"),
  name: "holeDiameter",
  value: length(8),
}).value.document;
```

Hand that document's features to a kernel through
`createKernelFeatureExecutor` (`@slopcad/cad-kernel`), project the result
with `projectTessellation` (`@slopcad/cad-core`), render it with
`CadViewport` (`@slopcad/ui`), and save the whole parametric session with
`serializeNativeCadDocument` (`@slopcad/cad-core`). Each step is a guide;
each guide has a running example.
