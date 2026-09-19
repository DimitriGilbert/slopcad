# Parameters

Parameters are the document's named dimensions. A `Parameter` pairs a
branded `ParameterId`, a unique name, and a **dimensional value**
(length, angle, area, volume, or dimensionless — see [units.md](units.md)),
plus optional metadata and an optional expression that computes it.

## The collection surface

`@slopcad/cad-core`'s `parameter.ts` owns the operations; the document
wraps them (`addDocumentParameter`, `getDocumentParameter`,
`removeDocumentParameter`):

```ts
import {
  addDocumentParameter,
  length,
  angle,
  parseExpression,
} from "@slopcad/cad-core";

const expr = parseExpression("holeDiameter * 2"); // see expressions.md
doc = addDocumentParameter(doc, {
  id: HOLE_PARAMETER,
  name: "holeDiameter",
  value: length(10),
  metadata: { label: "Through-bore diameter" }, // JSON-safe scalars
}).value.document;
doc = addDocumentParameter(doc, {
  id: HINT_PARAMETER,
  name: "volumeHint",
  value: length(20),
  expression: expr.value, // derived, recomputed on edit
}).value.document;
```

- `updateParameterValue` / `updateParameterExpression` /
  `updateParameterMetadata` return the next collection; both are
  validated (a wrong-dimension value fails `parameter/*` structured).
- `parameterEnvironment(collection)` is the resolver the expression
  evaluator consumes — parameters see each other by name.
- `findParameterCycle` and `parameterDependencyEdges` are the graph
  checks: expressions may reference other parameters, cycles are
  rejected structurally.
- `serializeParameterCollection` / `parseParameterCollection` round-trip
  the canonical JSON form (fixed key order — same collection, same
  bytes).

## Edits are commands

Inside a live session, a value edit is one `parameter.set` command in a
transaction — that is what the parameter panel issues, what the history
records, and what the native format persists:

```ts
import { applySessionCommand } from "@slopcad/cad-core";
const next = applySessionCommand(session, {
  type: "parameter.set",
  id: HOLE_PARAMETER,
  value: length(12.5),
});
```

## The runnable example

`packages/docs-examples/src/core/document.ts` creates four parameters
(including the expression-driven `volumeHint`), edits `holeDiameter`
through `parameter.set`, and reports both magnitudes before and after —
the suite pins `holeDiameterMm: 10 → 12.5` and `volumeHintMm: 20 → 25`.
The React counterpart (`src/react/store.tsx`) drives the same edit
through the `useCadParameters().setValue` hook; the `/docs` page mounts
it live.
