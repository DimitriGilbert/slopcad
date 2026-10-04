# The element vocabulary — all 43 kinds

The complete prop reference for `@slopcad/cad-jsx`, copied from
`packages/cad-jsx/src/elements.ts` (the shipped truth — the interfaces
`ParameterProps` … `SplineProps` and the `defineCadElement` tags). Every
prop is required unless marked `?`. Copy discipline: prop names,
optionalities, and types below are exactly as shipped; when this file and
`elements.ts` disagree, `elements.ts` wins — fix this file.

## Prop value types used below

- **Dimensional** (`DimensionalProp`): a plain number in the prop's
  canonical unit — millimetres for lengths, radians for angles, a bare
  count for dimensionless values (`count`, `turns`, `factor`) — or an
  explicit quantity (`length(2, "cm")`, `angle(90, "deg")`,
  `dimensionless(4)`, re-exported from `@slopcad/cad-jsx`), or the id of
  a `<Parameter>` declared earlier in the tree (`"param_width"` — a bare
  string is always read as a parameter id).
- **Selectors** (compile-time constants, never parameter references):
  `WorldAxis` = `"x" | "y" | "z"`; `Handedness` = `"right" | "left"`;
  `ThreadMode` = `"external" | "internal" | "cosmetic"`;
  `HoleType` = `"straight" | "counterbore" | "countersink" | "taper" |
"threaded"`; `PatternOrientation` = `"fixed" | "tangent"`;
  `PolygonFit` = `"inscribed" | "circumscribed"`;
  `SplineFlavor` = `"control" | "interpolated"`;
  `SlotVariant` = `"straight" | "arc3"`.
- **Record references**: `ref_…` = a persistent-reference record id
  (edges/faces), `dtm_…` = a datum record id, `crv_…` = a curve record id,
  `feat_…` = a feature id, `skd_…` = a sketch record id (an in-scope
  `<Sketch id=…>` sibling declared earlier). The `ref_…`/`dtm_…`/`crv_…`
  families address records the **target document already carries** — a
  static JSX tree cannot mint them (see SKILL.md).
- **Plain objects**: `Vec3Prop` = `{ x, y, z }` (finite mm);
  `SplinePointProp` = `{ x, y }` (workplane mm);
  `LoftSectionProp` = `{ sketch: "skd_…", z: Dimensional }`.
- **Angles** are radians as plain numbers. `keep` and `direction` are
  `1 | -1`. `children` is a React child (element, fragment, array,
  `null`/`false` for conditional authoring).

## Records and primitives

| Element       | Props                                        | Notes                                                                                                                                                                        |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Parameter>` | `name`, `value`, `id?`                       | `parameter.create`; a re-declaration of the same id and name compiles to `parameter.set`. `name` must be a valid expression identifier. Default id `param_<name>`.           |
| `<Body>`      | `name`, `id?`, `children?`                   | `body.create`; when it wraps exactly one producing child, that child's feature outputs this body (the child creates no body of its own). Default id `body_<sanitized-name>`. |
| `<Box>`       | `width`, `depth`, `height`, `id?`            | 3 × `parameter.create` + `body.create` + `feature.create` kind `box`.                                                                                                        |
| `<Sphere>`    | `radius`, `id?`                              | kind `sphere`.                                                                                                                                                               |
| `<Cylinder>`  | `radius`, `height`, `id?`                    | kind `cylinder`.                                                                                                                                                             |
| `<Cone>`      | `bottomRadius`, `topRadius`, `height`, `id?` | kind `cone`.                                                                                                                                                                 |
| `<Translate>` | `x?`, `y?`, `z?`, `id?`, `children?`         | kind `translate` over its exactly-one producing child (the child keeps its own body). Offsets default to 0 mm.                                                               |

## Booleans and sharing

| Element       | Props              | Notes                                                                                                                                                                                              |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Union>`     | `id?`, `children?` | kind `union`; needs ≥ 2 producing children (nested solids or `<Use>`), fused in declaration order.                                                                                                 |
| `<Subtract>`  | `id?`, `children?` | kind `subtract`; the FIRST child is the base, every child after it is a tool (`kernel.subtract(target, tools)` order). ≥ 2 producing children.                                                     |
| `<Intersect>` | `id?`, `children?` | kind `intersect`; keeps the common volume; ≥ 2 producing children.                                                                                                                                 |
| `<Use>`       | `feature`          | emits no commands — the reference a consuming parent turns into a `{ kind: "feature" }` input. The referenced feature must be produced EARLIER in the tree (`cadjsx/reference-unknown` otherwise). |

## Local operations (exactly one producing target child)

| Element         | Props                                                                                                                                                                                                                                             | Notes                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Fillet>`      | `radius`, `edges`, `id?`, `children?`                                                                                                                                                                                                             | kind `fillet`; `edges` is an ordered list of `ref_…` edge reference record ids the target document already carries.                          |
| `<Chamfer>`     | `distance`, `edges`, `id?`, `children?`                                                                                                                                                                                                           | kind `chamfer`; one symmetric distance, ordered `ref_…` edges.                                                                               |
| `<Shell>`       | `thickness`, `faces`, `id?`, `children?`                                                                                                                                                                                                          | kind `shell`; hollows the target opening the ordered `ref_…` faces at a uniform wall thickness.                                              |
| `<Thicken>`     | `thickness`, `id?`, `children?`                                                                                                                                                                                                                   | kind `thicken`; offsets the target's faces into a closed hollow.                                                                             |
| `<Split>`       | `plane`, `keep`, `id?`, `children?`                                                                                                                                                                                                               | kind `split`; `plane` is a `dtm_…` datum plane record; `keep` is `1` (the side the normal points to) or `-1`.                                |
| `<Hole>`        | `type?`, `diameter?`, `depth?`, `tipAngle?`, `cboreDiameter?`, `cboreDepth?`, `csinkDiameter?`, `csinkAngle?`, `taperAngle?`, `threadMajor?`, `threadPitch?`, `positionX?`, `positionY?`, `positions?`, `axis?`, `axisDatum?`, `id?`, `children?` | kind `hole`. Two forms dispatch on `type` — see the hole forms table below.                                                                  |
| `<Rib>`         | `thickness`, `sketch`, `id?`, `children?`                                                                                                                                                                                                         | kind `rib`; unions a symmetric double extrusion of the cross-section sketch (half the thickness each way) with the target.                   |
| `<Thread>`      | `majorDiameter`, `pitch`, `length`, `mode?`, `handedness?`, `axis?`, `axisDatum?`, `id?`, `children?`                                                                                                                                             | kind `thread`; ISO thread cut on (`external`) or in (`internal`) the target; `mode` defaults `external`, `handedness` `right`, `axis` `"z"`. |
| `<Scale>`       | `factor`, `id?`, `children?`                                                                                                                                                                                                                      | kind `scale`; one uniform dimensionless factor (the contract carries uniform scaling only).                                                  |
| `<MoveFace>`    | `face`, `axis`, `distance`, `id?`, `children?`                                                                                                                                                                                                    | kind `moveFace`; translates the `ref_…` face along a world axis by a signed distance.                                                        |
| `<ReplaceFace>` | `face`, `plane`, `id?`, `children?`                                                                                                                                                                                                               | kind `replaceFace`; re-closes the `ref_…` face onto a `dtm_…` datum plane.                                                                   |
| `<DeleteFace>`  | `face`, `heal?`, `id?`, `children?`                                                                                                                                                                                                               | kind `deleteFace`; removes the `ref_…` face; `heal` (default `true`) extends the neighbours to close the gap.                                |

### `<Hole>`'s two forms (dispatch on `type`)

- **Flat** (`type` absent): requires `diameter`, `depth`, `positionX`,
  `positionY`; `axis` defaults `"z"`, or `axisDatum` (`dtm_…`) replaces
  the axis. The structured-only props (`tipAngle`, `cbore*`, `csink*`,
  `taperAngle`, `thread*`, `positions`) are rejected here
  (`cadjsx/prop-conflict`).
- **Structured** (`type` given): requires every dimension of the chosen
  type, in `structuredHoleRoles` order — `straight`: `diameter`, `depth`,
  `tipAngle`; `counterbore`: `diameter`, `depth`, `tipAngle`,
  `cboreDiameter`, `cboreDepth`; `countersink`: `diameter`, `depth`,
  `tipAngle`, `csinkDiameter`, `csinkAngle`; `taper`: `diameter`, `depth`,
  `taperAngle`; `threaded`: `depth`, `tipAngle`, `threadMajor`,
  `threadPitch`. Then placement — `positionX`/`positionY`, or `positions`
  (an in-scope `<Sketch id=…>` whose `<Point>` entities place the holes:
  one feature, many holes) — and the axis (`axis` selector, default
  `"z"`, or `axisDatum`). Props outside the chosen type's roles are
  rejected with `cadjsx/prop-conflict`.

## Patterns and mirror (exactly one producing target child)

| Element             | Props                                                            | Notes                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<PatternLinear>`   | `count`, `spacing`, `direction?`, `id?`, `children?`             | kind `patternLinear`; repeats along `direction` (radians CCW from world +x in the XY plane, default 0). `count` is an integer ≥ 2 (the kernel's verdict).                                                                 |
| `<PatternCircular>` | `count`, `totalAngle`, `axis?`, `id?`, `children?`               | kind `patternCircular`; repeats about a world axis line through the origin (`axis` default `"z"`), `count` copies over `totalAngle` radians.                                                                              |
| `<PatternPath>`     | `count`, `spacing`, `orientation?`, `sketch`, `id?`, `children?` | kind `patternPath`; repeats at `spacing` arc-length steps along the path sketch; `orientation` `"fixed"` (default) translates only, `"tangent"` also rotates onto the path tangent.                                       |
| `<Mirror>`          | `plane`, `offset?`, `merge?`, `id?`, `children?`                 | kind `mirror`. `plane` = `"x"`/`"y"`/`"z"` (the plane normal's axis; with `offset`, default 0 mm) or a `dtm_…` datum record (with optional `merge` — union with the original). Mixing the two layouts' props is rejected. |

## Sketch-driven producers (no target child — they create bodies like primitives)

| Element       | Props                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Extrude>`   | `sketch`, `height`, `direction?`, `taper?`, `id?`                                            | kind `extrude`; prisms the closed profile along the sketch normal. ONE signed length parameter: `direction` (`1` default, `-1` against the normal) folds into the sign — so it may NOT be passed when `height` references a parameter (the parameter's own sign is the direction; `cadjsx/prop-conflict`). `taper` is radians; absent or 0 = plain prism. |
| `<Revolve>`   | `sketch`, `angle`, `axis?`, `axisDatum?`, `id?`                                              | kind `revolve`; sweeps about an axis in the sketch plane: `axis` is radians CCW from the workplane +x through the workplane origin (default 0), or `axisDatum` (`dtm_…`) replaces it. Kernel angle domain (0, 2π].                                                                                                                                        |
| `<Sweep>`     | `profile`, `path`, `id?`                                                                     | kind `sweep`; carries the closed profile loop along the path chain (both in-scope `<Sketch id=…>` siblings). No parameters — the path determines the extent.                                                                                                                                                                                              |
| `<SweepWire>` | `profile`, `spine`, `id?`                                                                    | kind `sweepWire`; carries the profile along a 3D wire spine — `spine` is a `crv_…` curve record the document already carries.                                                                                                                                                                                                                             |
| `<Loft>`      | `sections`, `id?`                                                                            | kind `loft`; skins ≥ 2 ordered `{ sketch, z }` sections — the order IS the loft direction; stations must be strictly increasing and every section must share the first section's workplane frame.                                                                                                                                                         |
| `<Helix>`     | `sketch`, `radius`, `pitch`, `turns`, `handedness?`, `startAngle?`, `taper?`, `axis?`, `id?` | kind `helix`; sweeps the sketch's meridian profile (its `(x, y)` becomes the `(radial, axial)` offset) along an analytic helical spine. `turns` is fractional-legal; `startAngle` default 0, `taper` default 0 mm; `axis` is a `dtm_…` datum axis record (default world +z through the origin).                                                           |

## Sketches and their entity children

`<Sketch>` compiles to one `sketch.create` whose payload is the
cad-sketch canonical serialized form (`{ formatVersion: 2, workplane,
entities, constraints: [] }`). The workplane frame must be orthonormal
and right-handed (validated like cad-sketch's `parseWorkplane`, within
1e-9) and is stored verbatim — never re-canonicalized. Entity geometry is
plain numbers in stored units (workplane mm and radians). Entity children
only; entity ids default `skent_<kind>-<n>` counted per kind across the
whole tree (a `<Rectangle>` derives its four lines' ids from its own
slug: `skent_rectangle-1-bottom/-right/-top/-left`). Sketch entity props
are plain numbers — never parameter references.

| Element       | Props                                                            | Notes                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<Sketch>`    | `id?`, `name?`, `origin?`, `normal?`, `xAxis?`, `children?`      | `origin`/`normal`/`xAxis` are `Vec3Prop`; defaults are the world origin, +z, +x (the XY plane). Default id `skd_sketch-<n>`.                                                                           |
| `<Point>`     | `x`, `y`, `id?`                                                  | a `point` entity.                                                                                                                                                                                      |
| `<Line>`      | `x1`, `y1`, `x2`, `y2`, `id?`                                    | a `line` entity.                                                                                                                                                                                       |
| `<Rectangle>` | `x1`, `y1`, `x2`, `y2`, `id?`                                    | four chained `line` entities (bottom, right, top, left) plus the `rectangle` entity referencing them in edge order.                                                                                    |
| `<Circle>`    | `cx`, `cy`, `radius`, `id?`                                      | a `circle` entity; radius positive.                                                                                                                                                                    |
| `<Arc>`       | `cx`, `cy`, `radius`, `startAngle`, `endAngle`, `id?`            | an `arc` entity; CCW sweep, angles canonicalized to [0, 2π); a zero or full-turn sweep is degenerate (rejected).                                                                                       |
| `<Ellipse>`   | `cx`, `cy`, `radiusX`, `radiusY`, `rotation?`, `id?`             | an `ellipse` entity; positive semi-axes; `rotation` of the radiusX axis from workplane +x, canonicalized to [0, 2π).                                                                                   |
| `<Slot>`      | `variant`, `x1`, `y1`, `x2`, `y2`, `x3?`, `y3?`, `radius`, `id?` | a `slot` entity. `straight`: two distinct cap centers + cap radius. `arc3`: the centerline arc through three distinct non-collinear points (x3/y3 required) whose circumradius exceeds the cap radius. |
| `<Polygon>`   | `cx`, `cy`, `radius`, `sides`, `rotation?`, `fit`, `id?`         | a `polygon` entity; `sides` 3–128; `fit` `inscribed` = radius is the circumradius, `circumscribed` = the inradius.                                                                                     |
| `<Spline>`    | `flavor`, `points`, `id?`                                        | a `spline` entity; `control` needs 4, 7, 10, … points (a cubic Bézier chain), `interpolated` needs ≥ 2 consecutive-distinct fit points.                                                                |

## Deterministic id scheme

Ids are assigned during the walk, in document order, one id space across
parameters, bodies, sketches, and features (mirroring the document — a
duplicate claim is rejected structurally):

- `<Parameter>`: `param_<name>`, or the explicit `id`.
- `<Body>`: the explicit `id`, or `body_<sanitized-name>` (each run of
  characters outside `A-Za-z0-9._-` collapses to one `-`).
- `<Sketch>`: the explicit `id` (`skd_…`), or `skd_sketch-<n>`.
- Primitives and operations: the `id` prop is the FEATURE id
  (`feat_…`); its payload (after `feat_`) is the slug, the output body is
  `body_<slug>`, and each literal dimensional prop's implicit parameter
  is `param_<slug>-<dimension>` (parameter name `<slug><Dimension>`,
  identifier-stripped — e.g. `box1Width`).
- Without an explicit id the slug is `<kind>-<occurrence>` counted per
  element kind across the whole tree (`box-1`, `union-1`), so
  `feat_union-1`, `body_union-1`, `param_union-1-spacing`, ….

Generated payloads are non-numeric, so they never collide with the
document's own generator space (`feat_000042`). `<Use>` claims nothing.
