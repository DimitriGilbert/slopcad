# @slopcad/cad-jsx

Author CAD models as `.tsx` React files. A model is an ordinary React
element tree built from this package's element tags; `compileModel` walks
the tree as **pure data** and lowers it onto the `@slopcad/cad-core`
command vocabulary — the same serializable, replayable commands the
workbench authors by hand.

## The no-second-representation law

`packages/cad-react/src/model.ts` states the hard rule, and this package
obeys it: **there is no second parametric representation here.** A JSX
model compiles to `parameter.create` / `parameter.set` / `body.create` /
`sketch.create` / `feature.create` commands — nothing else. The element
tags carry no geometry and no evaluator; they are authoring sugar over the
command vocabulary, and `applyCommand` (in `@slopcad/cad-core`, the sole
interpreter) remains the only write path. Every emitted command is built
in the canonical serialized wire form and re-parsed through
`parseCommand`, so what you author is exactly what the document executes.

## A minimal model

```tsx
import {
  Body,
  Box,
  compileModel,
  Cylinder,
  Parameter,
  Translate,
} from "@slopcad/cad-jsx";

const Plate = (props: { boreRadius: number }) => (
  <>
    <Parameter name="boreRadius" value={props.boreRadius} />
    <Body name="plate">
      <Box width={30} depth={20} height={10} />
    </Body>
    <Translate x={15} y={10} z={5}>
      <Cylinder radius="param_boreRadius" height={10} />
    </Translate>
  </>
);

const result = compileModel(<Plate boreRadius={4} />);
// result.ok → result.value is a CadTransaction (applyTransaction it onto a document)
// result.ok === false → result.error is a structured CadJsxCompileError with the tree path
```

Models are compiled with plain `createElement` under the hood — no
renderer, no DOM, no hooks runtime. In plain TypeScript (no JSX), write
`createElement(Box, { width: 30, depth: 20, height: 10 })`.

## Elements

The element kinds and their input order mirror the kernel bridge
(`@slopcad/cad-kernel`'s `BRIDGE_FEATURE_KINDS` readers) exactly: every
dimensional prop becomes a parameter the feature consumes, in the order
the bridge reads them; every sketch, datum, and persistent-reference
input rides the same `{ kind, id }` feature input the bridge resolves.

### Primitives, parameters, bodies (Phase 1)

| Element       | Props                                              | Compiles to                                                                                                                                  |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Parameter>` | `name`, `value`, `id?`                             | `parameter.create` (a re-declaration of the same id and name compiles to `parameter.set`)                                                    |
| `<Body>`      | `name`, `id?`, `children?`                         | `body.create`; at most one producing child may declare this body as its feature's output                                                     |
| `<Box>`       | `width`, `depth`, `height`, `id?`                  | 3 × `parameter.create` + `body.create` + `feature.create` kind `box` (inputs: width, depth, height)                                          |
| `<Sphere>`    | `radius`, `id?`                                    | 1 × `parameter.create` + `body.create` + `feature.create` kind `sphere` (inputs: radius)                                                     |
| `<Cylinder>`  | `radius`, `height`, `id?`                          | 2 × `parameter.create` + `body.create` + `feature.create` kind `cylinder` (inputs: radius, height)                                           |
| `<Cone>`      | `bottomRadius`, `topRadius`, `height`, `id?`       | 3 × `parameter.create` + `body.create` + `feature.create` kind `cone` (inputs: bottomRadius, topRadius, height)                              |
| `<Translate>` | `x?`, `y?`, `z?` (default 0 mm), `id?`, `children` | its child's commands, then 3 × `parameter.create` + `body.create` + `feature.create` kind `translate` (inputs: the child's feature, x, y, z) |

### Booleans (children as inputs)

| Element       | Props             | Compiles to                                                                                                         |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `<Union>`     | `id?`, `children` | its children's commands, then `body.create` + `feature.create` kind `union` (inputs: every child feature, in order) |
| `<Subtract>`  | `id?`, `children` | kind `subtract` — the FIRST child is the base, the rest are the tools (the bridge's `subtract(target, tools)`)      |
| `<Intersect>` | `id?`, `children` | kind `intersect` (inputs: every child feature, in order)                                                            |

Each boolean needs **at least two producing children** (nested solids or
`<Use>` references); fewer is rejected with `cadjsx/boolean-inputs-invalid`.

### Local operations (exactly one target child)

| Element         | Props                                                                                                                           | Compiles to (feature inputs, in order)                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Fillet>`      | `radius`, `edges`, `id?`, `children`                                                                                            | kind `fillet`: target feature, one `{kind:"reference"}` input per edge, the radius parameter                                                               |
| `<Chamfer>`     | `distance`, `edges`, `id?`, `children`                                                                                          | kind `chamfer`: target feature, edge references, the distance parameter                                                                                    |
| `<Shell>`       | `thickness`, `faces`, `id?`, `children`                                                                                         | kind `shell`: target feature, face references, the thickness parameter                                                                                     |
| `<Thicken>`     | `thickness`, `id?`, `children`                                                                                                  | kind `thicken`: target feature, the thickness parameter                                                                                                    |
| `<Split>`       | `plane`, `keep`, `id?`, `children`                                                                                              | kind `split`: target feature, the datum plane input, the keep-side selector (`1` or `-1`)                                                                  |
| `<Hole>`        | flat: `diameter`, `depth`, `positionX`, `positionY`, `axis?`; structured: `type` + the type's roles, `positions?`, `axisDatum?` | kind `hole`: the flat five-parameter layout, or the structured `structuredHoleRoles` order with sketch/datum alternatives                                  |
| `<Rib>`         | `thickness`, `sketch`, `id?`, `children`                                                                                        | kind `rib`: target feature, the cross-section sketch input, the thickness parameter                                                                        |
| `<Thread>`      | `majorDiameter`, `pitch`, `length`, `mode?`, `handedness?`, `axis?`/`axisDatum?`, `id?`, `children`                             | kind `thread`: target feature, the five parameters (major diameter, pitch, length, mode, handedness), then the axis selector parameter or datum axis input |
| `<Helix>`       | `sketch`, `radius`, `pitch`, `turns`, `handedness?`, `startAngle?`, `taper?`, `axis?`, `id?` (no children — a producer)         | kind `helix`: the meridian sketch input, six parameters (radius, pitch, turns, handedness, start angle, taper), an optional datum axis input               |
| `<Scale>`       | `factor`, `id?`, `children`                                                                                                     | kind `scale`: target feature, one dimensionless factor (the contract carries uniform scaling only)                                                         |
| `<MoveFace>`    | `face`, `axis`, `distance`, `id?`, `children`                                                                                   | kind `moveFace`: target feature, the face reference, the axis selector, the distance parameter                                                             |
| `<ReplaceFace>` | `face`, `plane`, `id?`, `children`                                                                                              | kind `replaceFace`: target feature, the face reference, the datum plane input                                                                              |
| `<DeleteFace>`  | `face`, `heal?`, `id?`, `children`                                                                                              | kind `deleteFace`: target feature, the face reference, the heal flag parameter                                                                             |

`<Hole>`'s two forms dispatch on the presence of `type`:

- **flat** (`type` absent) — the bridge's five parameters in order:
  `diameter`, `depth`, `positionX`, `positionY` (lengths) and `axis`
  (default `"z"`); or `axisDatum` (`dtm_…`) in place of the axis selector.
- **structured** (`type` given: `"straight"`, `"counterbore"`,
  `"countersink"`, `"taper"`, `"threaded"`) — the type's role list in
  `structuredHoleRoles` order (`type` selector first, then the type's own
  dimensions), then `positionX`/`positionY` — or `positions` (an in-scope
  `<Sketch id>` whose point entities place the holes, one feature many
  holes) — and the `axis` selector (or `axisDatum`). Props outside the
  chosen type's roles are rejected with `cadjsx/prop-conflict`.

### Patterns and mirror (exactly one target child)

| Element             | Props                                                                               | Compiles to (feature inputs, in order)                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<PatternLinear>`   | `count`, `spacing`, `direction?` (default 0 rad), `id?`, `children`                 | kind `patternLinear`: target feature, count, spacing, direction                                                             |
| `<PatternCircular>` | `count`, `totalAngle`, `axis?` (default `"z"`), `id?`, `children`                   | kind `patternCircular`: target feature, count, totalAngle, axis selector                                                    |
| `<PatternPath>`     | `count`, `spacing`, `orientation?` (default `"fixed"`), `sketch`, `id?`, `children` | kind `patternPath`: target feature, the path sketch input, count, spacing, orientation                                      |
| `<Mirror>`          | `plane`, `offset?` (selector form), `merge?` (datum form), `id?`, `children`        | kind `mirror`: the world-axis form (plane selector, offset) or the datum form (datum plane input, optional merge parameter) |

`<Mirror>`'s `plane` selects the bridge form: `"x"`, `"y"`, or `"z"`
(the plane normal's axis) authors the two-parameter selector layout with
`offset` (default 0 mm); a datum record id (`dtm_…`) authors the
datum-plane layout with the optional `merge` (standalone copy, or one
union with the original). Mixing the two layouts' props is rejected.

### Sketches (Phase 2's fourth requirement)

| Element       | Props                                                                 | Compiles to                                                                                                                                 |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Sketch>`    | `id?`, `name?`, `origin?`, `normal?`, `xAxis?`, `children` (entities) | `sketch.create` whose payload is the **cad-sketch canonical serialized form**: `{ formatVersion: 2, workplane, entities, constraints: [] }` |
| `<Point>`     | `x`, `y`, `id?`                                                       | a `point` entity in the sketch payload                                                                                                      |
| `<Line>`      | `x1`, `y1`, `x2`, `y2`, `id?`                                         | a `line` entity                                                                                                                             |
| `<Rectangle>` | `x1`, `y1`, `x2`, `y2`, `id?`                                         | four chained `line` entities (bottom, right, top, left) plus the `rectangle` entity referencing them in edge order                          |
| `<Circle>`    | `cx`, `cy`, `radius`, `id?`                                           | a `circle` entity                                                                                                                           |
| `<Arc>`       | `cx`, `cy`, `radius`, `startAngle`, `endAngle`, `id?`                 | an `arc` entity (angles in radians, canonicalized to [0, 2π); a zero/full sweep is rejected)                                                |
| `<Ellipse>`   | `cx`, `cy`, `radiusX`, `radiusY`, `rotation?`, `id?`                  | an `ellipse` entity                                                                                                                         |
| `<Slot>`      | `variant`, `x1`..`y2`, (`x3`, `y3` for `arc3`), `radius`, `id?`       | a `slot` entity (straight or 3-point-arc)                                                                                                   |
| `<Polygon>`   | `cx`, `cy`, `radius`, `sides` (3–128), `rotation?`, `fit`, `id?`      | a `polygon` entity (`inscribed` = circumradius, `circumscribed` = inradius)                                                                 |
| `<Spline>`    | `flavor`, `points`, `id?`                                             | a `spline` entity (`control`: 4, 7, 10… points; `interpolated`: ≥ 2 distinct fit points)                                                    |

**Payload provenance.** This package sits directly above `@slopcad/cad-core`
and depends on nothing else in the workspace, so the sketch payload is
**reproduced from** `@slopcad/cad-sketch`'s canonical serialization
(`serializeSketch` / `serializeSketchEntity` key orders, the workplane
frame shape, `SKETCH_FORMAT_VERSION` 2, and the entity builders' own
validation rules: positive radii, canonicalized angles, positive arc
sweeps, polygon side bounds, spline point grammars, slot distinctness,
chained rectangle edges) — never invented. The workplane frame
(`origin`, `normal`, `xAxis`; defaults are the XY plane) is validated the
way cad-sketch's `parseWorkplane` validates a stored frame — unit,
perpendicular, right-handed within 1e-9 — and stored verbatim; it is never
silently re-canonicalized. Entity geometry is stored, not parameterized:
entity props are plain numbers in the stored units (workplane mm and
radians), exactly as the sketch domain persists them.

A `<Sketch>` is a top-level record (like `<Body>` and `<Parameter>`);
its children are entity elements only. Sketch-consuming elements (`<Rib>`,
`<Helix>`, `<PatternPath>`, and `<Hole positions>`) reference one through
a `sketch`/`positions` prop naming an **in-scope `<Sketch id=…>` sibling
declared earlier in the tree** — the same atomic-record discipline the
workbench's sketch → feature actions use.

### Shared subtrees: `<Use>`

| Element | Props                | Compiles to                                                                                         |
| ------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `<Use>` | `feature` (`feat_…`) | **no commands** — the producer reference the consuming parent turns into a `{kind:"feature"}` input |

`<Use>` is the ONE reference mechanism for shared features: an element
referenced more than once stays wherever it stands in the tree (give it an
explicit `id`), and each consumer points at it with
`<Use feature="feat_id"/>`. It resolves to the same feature input the
nested form would produce, participates in child order (a `<Subtract>`
whose first child is a `<Use>` makes that referenced feature the base),
and may feed any consumer (booleans, operations, `<Translate>`, other
`<Use>` chains). The referenced feature must be **produced earlier in the
tree** — a forward or unknown reference is rejected with
`cadjsx/reference-unknown`.

### Reference props for records the tree cannot declare

Some bridge inputs address document records a static JSX tree cannot
create:

- **Persistent references** (`edges`/`faces`/`face` props on
  `<Fillet>`, `<Chamfer>`, `<Shell>`, `<MoveFace>`, `<ReplaceFace>`,
  `<DeleteFace>`): the bridge resolves edge/face selection through Phase 22
  persistent-reference records **minted by the picking layer against a
  live topology snapshot** (identity payload + geometry descriptors). A
  static tree cannot mint them, so the props carry `ref_…` record ids of
  records the **target document already carries**; the emitted
  `{kind:"reference"}` inputs are byte-identical to the ones a
  picking-driven fillet declares. The transaction is then not
  self-contained: folding it requires the referenced records to exist
  (the tests mint one through cad-core's own `mintTopologyReference`,
  the same fixture discipline the kernel bridge's tests use).
- **Datums** (`plane`/`axis`/`axisDatum` props on `<Split>`, `<Mirror>`,
  `<ReplaceFace>`, `<Thread>`, `<Helix>`, `<Hole>`): datum records are
  document entities this vocabulary cannot declare yet (no `<Datum>`
  element), so the props carry `dtm_…` record ids of records the target
  document already carries.

Both prop families are validated by id shape at compile time; whether the
record exists — and whether its payload is the right datum kind or a live
topology entity — is the document's and the kernel's structured verdict
at apply/regeneration time, never guessed here.

## Dimensional props

Dimensional props accept three forms:

- a plain number — the **canonical unit of the prop's dimension**:
  millimetres for lengths, radians for angles (e.g. `direction`,
  `totalAngle`, `tipAngle`, `startAngle`), and a bare count for
  dimensionless values (`count`, `turns`, `factor`);
- a dimensional quantity from `@slopcad/cad-core`
  (`width={length(2, "cm")}`, `direction={angle(90, "deg")}`) — the
  quantity's dimension must match the prop's dimension (an angle where a
  length is required is rejected at compile time);
- a parameter id string (`width="param_width"`) — the feature consumes
  that `<Parameter>` instead of creating its own; the parameter must be
  declared **before** this point in the tree.

**Referenced-parameter dimension mismatches are NOT compile-checked.**
When a prop points at a `<Parameter>` (e.g. an angle parameter consumed
where a length is required), the compiler verifies only that the
parameter exists — never the dimension of its value. The kernel's
structured diagnostic at regeneration is the sole interpreter for that
class of mismatch; this package refuses to duplicate that judgement.

Selector props (`axis`, `plane`, `handedness`, `mode`, `type`,
`orientation`, `variant`, `fit`, `flavor`, `keep`, `heal`, `merge`) are
compile-time constants serialized as the bridge's dimensionless
parameters (or payload fields) — they do not accept parameter references.
Domain rules that belong to the kernel (a strictly positive radius, a
count ≥ 2, a finite scale factor) are the kernel's structured verdicts at
regeneration; the compiler checks structure, not domains — the
no-second-representation law.

`<Parameter name value>`: a plain number value is canonicalized as
millimetres; any dimension may be authored with an explicit quantity
(`angle(90, "deg")`, `dimensionless(4)`). The name must be a valid
expression identifier — it is the document's identifier vocabulary.

`<Body>` wraps at most one producing element (any primitive, operation,
or `<Translate>`); that child's feature outputs the `<Body>`'s body
instead of creating its own. A `<Body>` with no producer is a bare body
record. A `<Translate>` wraps exactly one producing child (its child
keeps its own body — the translate references the child's feature).

The element tags are frozen, branded function values: callable only so
JSX and `createElement` accept them as tags. They must never be invoked;
calling one throws.

## Id assignment

Ids are assigned deterministically during the walk, in document order:

- `<Parameter>`: `param_<name>` (the name is identifier-safe by rule), or
  the explicit `id` prop (`param_…`).
- `<Body>`: the explicit `id` prop, or `body_<sanitized-name>` (each run
  of characters outside `A-Za-z0-9._-` collapses to one `-`).
- `<Sketch>`: the explicit `id` prop (`skd_…`), or `skd_sketch-<n>`; the
  default name is the slug with dashes as spaces (`sketch 1`).
- Sketch entities: the explicit `id` prop (`skent_…`), or
  `skent_<kind>-<n>` counted per entity kind across the whole tree; a
  `<Rectangle>` derives its four lines' ids from its own slug
  (`skent_rectangle-1-bottom`, `-right`, `-top`, `-left`). Entity ids must
  be unique within their sketch (the sketch domain's own rule).
- Primitives and operations: the `id` prop is the **feature id**
  (`feat_…`). Its payload (the part after `feat_`) is the element's slug;
  the output body is `body_<slug>` and each dimensional prop's implicit
  parameter is `param_<slug>-<dimension>` (name `<slug><Dimension>` with
  the slug stripped to identifier characters, e.g. `box1Width`).
- Without an explicit id, the slug is `<kind>-<occurrence>` counted per
  element kind across the whole tree in document order (`box-1`, `box-2`,
  `union-1`, `fillet-1`, …), so `feat_union-1`, `body_union-1`, ….

All generated payloads are non-numeric, so they can never collide with the
document's own generator space (`feat_000042`). The compiler keeps one id
space across parameters, bodies, sketches, and features (as the document
does) and rejects a duplicate claim structurally. `<Use>` claims nothing —
it only verifies the feature was produced earlier in the walk.

## Determinism guarantees

`compileModel` consults no clock, no randomness, and no environment: the
same element tree compiles to a transaction whose
`JSON.stringify(serializeTransaction(…))` is byte-identical every time.
Registries inside the walk are keyed for lookup only — never iterated to
produce output — so no map iteration order leaks into the result.

## What is rejected, and why

Everything below is rejected with a structured `CadJsxCompileError`
(`code` like `cadjsx/boolean-inputs-invalid`, a message, the rejected
`input`, and the tree `path`) — the compiler never throws for domain
errors:

- **Class components** — a model must be pure data; there is no render
  lifecycle here.
- **String (HTML) tags** — no DOM exists in a CAD model.
- **Symbol/memo/forwardRef element types** — not walkable data
  (`cadjsx/element-type-unknown`).
- **Functions, promises, symbols, class instances, NaN/Infinity in
  props** — props must be plain serializable data; only the element type
  itself may be a function. (A component that calls a hook throws when
  invoked outside a renderer; the throw is caught and reported as
  `cadjsx/component-threw`, naming the component.)
- **Components returning text or raw values** — a component must return
  an element, an array, or `null`.
- **Unknown element kinds** — `defineCadElement` is the extension point,
  but this compiler lowers only the kinds in `CAD_ELEMENT_KINDS`.
- **Unknown props on elements, unexpected children on childless
  elements.**
- **Duplicate ids** (one id space, mirroring the document) and **duplicate
  parameter names under different ids**; **duplicate entity ids within a
  sketch**.
- **References to parameters not declared before use**, **`<Use>`
  references to features not produced earlier** (`cadjsx/reference-unknown`),
  and **sketch props not backed by an in-scope `<Sketch>`**
  (`cadjsx/sketch-unknown`).
- **Wrong producer counts**: booleans need ≥ 2 children
  (`cadjsx/boolean-inputs-invalid`); every operation needs exactly one
  (`cadjsx/operation-target-invalid`); `<Translate>` needs exactly one
  (`cadjsx/translate-target-invalid`); `<Body>` with two producers.
- **Mixed mirror layouts, both axis forms, structured-hole props on the
  wrong type** — `cadjsx/prop-conflict`.
- **Malformed `ref_…`/`dtm_…` reference props** —
  `cadjsx/reference-invalid`.
- **Sketch structure**: entities outside a sketch
  (`cadjsx/sketch-entity-outside`), non-entity children inside one
  (`cadjsx/sketch-child-invalid`), `<Sketch>` nested in a container
  (`cadjsx/sketch-nested`), non-orthonormal workplanes and entity
  geometry the cad-sketch builders refuse (`cadjsx/sketch-payload-invalid`).
- **`<Body>`/`<Sketch>` nested in containers.**
- **Text or number children** — `null`/`undefined`/`true`/`false`
  children are the supported conditional-authoring forms.
- **Trees deeper than 100 levels** (a component returning itself
  forever) — `cadjsx/tree-too-deep`.

Accepted transparent nodes: React Fragments (children pass through),
arrays of children (flattened in order), and user function components
(invoked once, with serializable props, and their return walked).

## Honest-decline limitations (what this vocabulary does not express)

- **No `<Extrude>`/`<Revolve>`/`<Sweep>`/`<Loft>` elements yet.** The
  bridge's extrude-style kinds are sketch + parameter layouts this
  vocabulary will grow in a later phase; composing solids from sketches
  today means `<Rib>` (whose cross-section is a sketch) or `<Helix>`.
  Silently approximating them with primitives would be a second
  representation, so they are simply absent until they can be faithful.
- **Edge/face addressing cannot be minted here.** Fillet, chamfer, shell,
  and the local-face operations consume persistent-reference records that
  only a picking layer against a live topology snapshot can mint; this
  vocabulary consumes such records by id and never fabricates them.
- **Datum records cannot be declared here.** Datum-plane/axis consumers
  (`<Split>`, `<Mirror>`'s datum form, `<ReplaceFace>`, `<Thread>`,
  `<Helix>`, `<Hole>`) address `dtm_…` records the document already
  carries.
- **Selector props are constants.** The bridge reads axis/plane/mode
  selectors as dimensionless parameters, which a shared `<Parameter>`
  could drive — this surface pins them as authored constants rather than
  guess at a naming convention for selector parameters.

## Boundaries

This package sits directly above `@slopcad/cad-core` and depends on
nothing else in the workspace (`docs/guides/package-boundaries.md`) — no
cad-kernel, no cad-sketch, no cad-react, no three. React is a peer
dependency: the compiler consumes React elements as plain data and never
renders.

## API

- `compileModel(root: ReactElement<unknown>): ParseResult<CadTransaction, CadJsxCompileError>` —
  compile a model to its command transaction.
- `defineCadElement<P>(kind: string): CadElementTag<P>` — the element
  factory (the extension point for later phases).
- `CAD_JSX_ERROR_CODES` / `CadJsxCompileError` — the stable failure codes
  and structured error shape.
- The element tags and their prop types (`Box`, `BoxProps`, `Union`,
  `UnionProps`, `Sketch`, `SketchProps`, …) from `./elements`.
