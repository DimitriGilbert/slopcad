# JSX models

`@slopcad/cad-jsx` delivers the PRD's declarative promise — §23's
"declarative model definitions where useful"
(`slopcad — Product & Technical Requirements.md:1044`) and §32's
`<Nema17Mount motorSize={17} …/>` component model
(`:1289-1294`). A model is an ordinary `.tsx` React element tree built
from this package's element tags; `compileModel` walks the tree as **pure
data** (`createElement`, no renderer, no hooks runtime) and lowers it onto
the `@slopcad/cad-core` command vocabulary. The JSX is sugar:
`applyCommand` (`packages/cad-core/src/command.ts`) stays the sole
interpreter, and the compiler obeys the same no-second-parametric-
representation law `packages/cad-react/src/model.ts` states — there is no
parallel model, graph, or evaluator here
(`packages/cad-jsx/src/compiler.ts:6-14`).

The package sits directly above `@slopcad/cad-core` and depends on
nothing else in the workspace (+ a `react` peer; `esbuild` for the
Node-only loader) — see [package boundaries](package-boundaries.md). For
the imperative half of the React story (store, provider, hooks), see
[React integration](react.md).

## The element vocabulary

43 element kinds ship (`CAD_ELEMENT_KINDS`,
`packages/cad-jsx/src/elements.ts:53-97`). Dimensional props accept three
forms: a plain number (the canonical unit — mm for lengths, rad for
angles, a bare count for dimensionless), an explicit quantity
(`length(2, "cm")`, `angle(90, "deg")`), or a `param_…` id of a
`<Parameter>` declared earlier in the tree. Every producing element
emits its implicit parameters, its `body.create`, and its
`feature.create` — the input order mirrors the kernel bridge exactly.

### Records and primitives

| Element       | Props                                 | Lowers to                                                         |
| ------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `<Parameter>` | `name`, `value`, `id?`                | `parameter.create` (a re-declaration compiles to `parameter.set`) |
| `<Body>`      | `name`, `id?`, `children?`            | `body.create`; at most one producing child may claim it as output |
| `<Box>`       | `width`, `depth`, `height`            | 3 params + body + `feature.create` kind `box`                     |
| `<Sphere>`    | `radius`                              | kind `sphere`                                                     |
| `<Cylinder>`  | `radius`, `height`                    | kind `cylinder`                                                   |
| `<Cone>`      | `bottomRadius`, `topRadius`, `height` | kind `cone`                                                       |
| `<Translate>` | `x?`, `y?`, `z?`, one child           | the child, then kind `translate` (child feature + x, y, z)        |

### Booleans and sharing

| Element       | Props     | Lowers to                                                             |
| ------------- | --------- | --------------------------------------------------------------------- |
| `<Union>`     | children  | kind `union` — every child feature, in order (≥ 2 producing children) |
| `<Subtract>`  | children  | kind `subtract` — the FIRST child is the base, the rest are the tools |
| `<Intersect>` | children  | kind `intersect` — every child feature, in order                      |
| `<Use>`       | `feature` | no commands — the reference a consumer turns into a feature input     |

`<Use feature="feat_…">` is the one sharing mechanism: an element used
more than once stays put (give it an explicit `id`) and each consumer
points at it; the referenced feature must be produced earlier in the tree
(`cadjsx/reference-unknown` otherwise).

### Local operations (exactly one target child)

| Element         | Props                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `<Fillet>`      | `radius`, `edges` (`ref_…` record ids)                                                               |
| `<Chamfer>`     | `distance`, `edges` (`ref_…`)                                                                        |
| `<Shell>`       | `thickness`, `faces` (`ref_…`)                                                                       |
| `<Thicken>`     | `thickness`                                                                                          |
| `<Split>`       | `plane` (`dtm_…`), `keep` (`1` or `-1`)                                                              |
| `<Hole>`        | the flat form: `diameter`, `depth`, `positionX`, `positionY`, `axis?` — or the structured form below |
| `<Rib>`         | `thickness`, `sketch`                                                                                |
| `<Thread>`      | `majorDiameter`, `pitch`, `length`, `mode?`, `handedness?`, `axis?`/`axisDatum?`                     |
| `<Scale>`       | `factor` (uniform only)                                                                              |
| `<MoveFace>`    | `face` (`ref_…`), `axis`, `distance`                                                                 |
| `<ReplaceFace>` | `face` (`ref_…`), `plane` (`dtm_…`)                                                                  |
| `<DeleteFace>`  | `face` (`ref_…`), `heal?`                                                                            |

`<Hole>`'s two forms dispatch on `type`: the flat layout above, or a
structured type (`"straight"`, `"counterbore"`, `"countersink"`,
`"taper"`, `"threaded"`) carrying the type's own role props
(`tipAngle`, `cboreDiameter`, `cboreDepth`, `csinkDiameter`,
`csinkAngle`, `taperAngle`, `threadMajor`, `threadPitch`), with
`positions?` (an in-scope `<Sketch>` whose point entities place the
holes) and `axisDatum?` as the sketch/datum alternatives.

`ref_…` persistent-reference records are minted by the picking layer
against live topology — a static tree cannot mint them, so those props
address records the target document already carries (same for `dtm_…`
datums and the `crv_…` curve spine of `<SweepWire>`); the ids are
validated by shape at compile time, and existence is the document's and
kernel's structured verdict at apply/regeneration time.

### Patterns and mirror (one target child)

| Element             | Props                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| `<PatternLinear>`   | `count`, `spacing`, `direction?` (rad from +x, default 0)               |
| `<PatternCircular>` | `count`, `totalAngle`, `axis?` (default `"z"`)                          |
| `<PatternPath>`     | `count`, `spacing`, `orientation?` (`"fixed"`/`"tangent"`), `sketch`    |
| `<Mirror>`          | `plane` (`"x"`/`"y"`/`"z"` selector + `offset?`, or `dtm_…` + `merge?`) |

### Sketch-driven producers and sketch entities

| Element       | Props                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `<Extrude>`   | `sketch`, `height`, `direction?` (1/−1), `taper?`                                                                                 |
| `<Revolve>`   | `sketch`, `angle`, `axis?` (in-plane rad) / `axisDatum?`                                                                          |
| `<Sweep>`     | `profile`, `path` (two `<Sketch>` siblings)                                                                                       |
| `<SweepWire>` | `profile`, `spine` (`crv_…` curve record)                                                                                         |
| `<Loft>`      | `sections` — ≥ 2 `{ sketch, z }` records, order is direction                                                                      |
| `<Helix>`     | `sketch` (meridian), `radius`, `pitch`, `turns`, `handedness?`, `startAngle?`, `taper?`, `axis?` (`dtm_…`) — a producer, no child |

`<Sketch id? name? origin? normal? xAxis?>` compiles to one
`sketch.create` whose payload is the cad-sketch canonical serialized form
(`{ formatVersion: 2, workplane, entities, constraints: [] }`), built
from its entity children: `<Point x y>`, `<Line x1 y1 x2 y2>`,
`<Rectangle x1 y1 x2 y2>` (four chained lines + the rectangle entity),
`<Circle cx cy radius>`, `<Arc cx cy radius startAngle endAngle>`,
`<Ellipse cx cy radiusX radiusY rotation?>`,
`<Slot variant x1..y2 (x3 y3) radius>`, `<Polygon cx cy radius sides
rotation? fit>`, and `<Spline flavor points>` — each with an optional
`id`. Sketch-consuming elements name an in-scope `<Sketch id=…>`
sibling declared earlier in the tree.

`<Thicken>` is re-exported from the package root with every other kind,
so the sandboxed workbench import path (below) reaches the whole
vocabulary.

## A worked model, compiled for real

The runnable example is
`packages/docs-examples/src/cadjsx/hub-mount.tsx` — a hub mount: a
rectangle sketch extruded by a `plateHeight` parameter, a circle meridian
revolved into a ring, a two-section lofted boss, then
`<Subtract>`/`<Union>` booleans over `<Use>` references, captured in a
`<Body>`. Compiling it through the CLI:

```bash
pnpm --filter @slopcad/cad-jsx compile \
  ../docs-examples/src/cadjsx/hub-mount.tsx
```

`pnpm --filter` runs the script from `packages/cad-jsx`, so relative
model paths resolve from there — the `../docs-examples` hop is what
makes the command work copied straight from the repo root.

The stdout is the native `slopcad` document format's canonical JSON
(`--out <path>` additionally writes it; `--help` prints the contract).
The real emission on this branch carries one committed transaction of
**19 commands** — 5 × `parameter.create`, 4 × `sketch.create`,
5 × `body.create`, 5 × `feature.create`, interleaved in walk order:

```text
parameter.create param_plateHeight      (the <Parameter>, value 6 mm)
sketch.create     skd_plate             (the rectangle profile)
body.create       body_plate
feature.create    feat_plate   extrude  (height ← param_plateHeight)
sketch.create     skd_ring
parameter.create  param_ring-angle      (revolve angle, 2π rad)
parameter.create  param_ring-axis       (revolve axis, π/2 rad)
body.create       body_ring
feature.create    feat_ring    revolve
sketch.create     skd_boss-base
sketch.create     skd_boss-top
parameter.create  param_boss-stationZ1  (loft station, 6 mm)
parameter.create  param_boss-stationZ2  (loft station, 12 mm)
body.create       body_boss
feature.create    feat_boss    loft
body.create       body_cleared
feature.create    feat_cleared subtract (plate − ring, via <Use>)
body.create       body_mount
feature.create    feat_mount   union    (cleared + boss, via <Use>)
```

The document id derives from the file's basename (`doc_hub-mount`); the
emitted history holds that one transaction at cursor 1 with no
regeneration states (nothing has executed), so opening it in the
workbench replays the model exactly. The docs suite pins these outcomes
(`packages/docs-examples/src/docs-examples.test.ts`): the reopened
document carries the authored feature kinds in timeline order, the
structural validator is clean, and a resave is byte-identical.

## Determinism, ids, and what is rejected

The walk consults no clock, randomness, or environment: the same tree
compiles to a transaction whose serialized form is byte-identical every
time, and `compileToNative` inherits the discipline
(`packages/cad-jsx/src/compiler.ts:16-23`). Ids are derived, in document
order: `<Parameter name>` → `param_<name>`; a feature's explicit `id`
(`feat_…`) also derives its body (`body_<slug>`) and each implicit
parameter (`param_<slug>-<dimension>`); without an explicit id the slug
is `<kind>-<occurrence>` (`box-1`, `union-1`). Generated payloads are
non-numeric, so they never collide with the document's own generator
space (`feat_000042`).

Rejected, structurally (a `CadJsxCompileError` with the tree `path`; the
compiler never throws for domain errors): class components (no render
lifecycle here), string/HTML tags (no DOM), symbol/memo/forwardRef
element types, non-serializable props (functions, promises, NaN), a
component that calls a hook (the throw is caught and reported as
`cadjsx/component-threw`), unknown kinds and props, duplicate ids and
parameter names, `<Use>`/sketch references to things not produced earlier,
wrong producer counts (`cadjsx/boolean-inputs-invalid`,
`cadjsx/operation-target-invalid`), mixed-layout prop conflicts
(`cadjsx/prop-conflict`), malformed `ref_…`/`dtm_…`/`crv_…` ids, sketch
structure violations, and trees deeper than 100 levels. Transparent
nodes: fragments, arrays, and user function components (invoked once,
props walked).

## The generator: declines, never drops

`generateTsx` is the compiler's inverse: a pure walk over a document's
records emitting TSX that reproduces it byte-stably (normalizing exactly
the document id and metadata block, which belong to the emitting
options). The canonical form is explicit parameters first, each sketch
immediately before its first consumer, the feature DAG in timeline order
— nesting single-consumer features as children, standing multi-consumer
features behind `<Use>`; the generator validates its own emission order
against the document's sequences and refuses
(`cadjsx-generate/parameter-order` … `feature-order`) when a document's
creation order is not reproducible — never a silent diff.

Records the vocabulary cannot declare — datum, curve, and
persistent-reference records; sections, occurrences, mates, joints,
configurations; display-flagged bodies; expression- or metadata-carrying
parameters; features whose input layouts are not the compiler's — are
declined with a structured note (kind, id, reason) returned as data and
listed in the generated file's header; declines cascade to consumers
(`packages/cad-jsx/src/generate.ts:42-52`).

## Import and export in the workbench

The workbench's IO dialogs carry TSX rows
(`apps/web/src/cad-workbench/CompleteWorkbenchPage.tsx:111-143`): export
"model / source" — `generateTsx` runs client-side (the generator is
browser-safe: cad-core records and string building) and the held entry
reports either "full document round-trip" or its honest decline count;
import ".tsx, model / server" — the file posts to `POST
/api/io/import-tsx` (`apps/web/src/routes/api/io/import-tsx.ts`), whose
handling (`apps/web/src/io-fixture/import-tsx-endpoint.ts`) runs the
canonical loader and returns the native text, which then enters the
session through the same apply path an opened document takes.

The loader (`@slopcad/cad-jsx/loader`) is the one transpile → evaluate →
compile pipeline: esbuild with the classic JSX transform, the module body
evaluated in a fresh `node:vm` context whose globals are exactly React's
`createElement`/`Fragment`, the element runtime, and a `require`
resolving only `"react"` and `"@slopcad/cad-jsx"` — plus a 1 MiB source
cap and a 250 ms evaluation budget. Its threat model is stated in the
source: the vm "isolates honest models from accidents and vocabulary
drift; it is a containment boundary, not a hardened sandbox against
hostile code — the endpoint layer's session gate owns who may submit
source at all" (`packages/cad-jsx/src/loader.ts:21-24`). The endpoint's
gates: a signed-in session (401), a 64 MiB body cap (413), and the
loader's structured refusals passed through verbatim (422). The session
e2e stage `s26c` proves the round-trip through the real UI — import a
`.tsx`, export TSX, re-import the held bytes
(`apps/web/e2e-session/session.spec.ts:3345`).

## The runnable example

`packages/docs-examples/src/cadjsx/hub-mount.tsx` is the model above: it
compiles to native text through `compileToNative`, reopens that text
through the format's own parser (which replays the transaction log and
refuses any state/log disagreement), and reports the numbers the suite
asserts — command count, validator issues (zero), and a byte-identical
resave. The CLI renders its default export:

```bash
pnpm --filter @slopcad/cad-jsx compile \
  ../docs-examples/src/cadjsx/hub-mount.tsx --out hub-mount
```
