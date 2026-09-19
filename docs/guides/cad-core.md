# CAD core

`@slopcad/cad-core` is the kernel-neutral document model plus the
renderer-neutral render projection. It has zero dependencies — no React,
no Three.js, no DOM, no geometry kernel — and everything above it
(kernels, renderers, workers, UI) builds on the API exported from
`packages/cad-core/src/index.ts`.

## The document

A `CadDocument` is immutable data: named bodies, a parameter collection,
feature records with declared inputs and outputs, sketches, and
references. You never mutate it — every operation is a function that
returns the next document inside a `ParseResult`:

```ts
import {
  addBody,
  addDocumentParameter,
  addFeature,
  createDocument,
  createDocumentId,
  createBodyId,
  createParameterId,
  createFeatureId,
  length,
  type ParseResult,
} from "@slopcad/cad-core";

let doc = createDocument(createDocumentId("doc_demo"));
const body = addBody(doc, { id: createBodyId("body_plate"), name: "plate" });
if (!body.ok) throw new Error(body.error.message);
doc = body.value.document; // { document, body } — the added record rides along
```

The same unwrap discipline applies to `addDocumentParameter` (returns
`{ document, parameter }`), `addFeature` (`{ document, feature }`),
`addDocumentSketch`, and `addDocumentReference`. Removal and reorder
(`removeBody`, `removeFeature`, `reorderFeature`) and lookups
(`getBody`, `getFeature`, `getDocumentParameter`, …) mirror them.

## Ids

Every entity id is a branded string with a prefix: `body_*`, `param_*`,
`feat_*`, `skd_*`, `ref_*`, `doc_*`. Build them with the `create*Id`
functions, parse untrusted ones with the matching `parse*Id` — a
malformed id fails structured, it never becomes a string you accidentally
compare. `createIdGenerator` gives deterministic sequential ids for tests
and fixtures.

## Diagnostics

Failures carry `Diagnostic` values (code, severity, message, optional
location and data), not thrown strings — `DIAGNOSTIC_CODES` and
`DIAGNOSTIC_SEVERITIES` are the vocabularies, `compareSeverities` orders
them. The `ParseResult<T, E>` discipline (`ok`/`fail`) is universal: the
core is total over untrusted input; a malformed payload never throws.

## The projection

`projectTessellation(bodyId, tessellation, featureId?)` turns a kernel
tessellation into a `RenderObject`; `createRenderProjection(objects,
camera)` validates and freezes the renderable document. This is the ONLY
shape the renderer consumes — see [r3f.md](r3f.md).

## The runnable example

`packages/docs-examples/src/core/document.ts` builds a real document —
plate body, `holeDiameter` parameter, an expression-driven `volumeHint`,
a translate feature — and reads back the feature timeline:

```ts
import { runDocumentExample } from "@slopcad/docs-examples";
const summary = runDocumentExample();
// { parameterCount: 4, holeDiameterMm: 10, volumeHintMm: 20,
//   featureCount: 1, timelineKinds: ["translate"],
//   editedHoleDiameterMm: 12.5, editedVolumeHintMm: 25 }
```

The suite (`packages/docs-examples/src/docs-examples.test.ts`) asserts
every field; the `/docs` page runs it in the browser (`pnpm test:docs`).
