# Drawings

Phase 54 lays the drawings family' annotation layer: dimension and
annotation entities, the parametric-source dimension recovery, sheet
furniture (title block, revision table, templates), and a
byte-deterministic SVG export preview. The drawing document model itself —
sheet records, projected views, HLR — is the neighboring drawings phase;
every entity here addresses its host view by `viewId`, so it merges into
that host additively.

## Dimension and annotation entities

`@slopcad/cad-core`'s `drawing-annotations` module carries the data model:

- **Dimensions** — `linear` (aligned/horizontal/vertical), `radial`,
  `diameter`, and `angular`, each with sheet-space geometry (millimetres,
  radians) and a `DrawingDimensionOrigin`: either a MODEL origin naming the
  feature parameter or sketch constraint the value came from, or the
  `reference` origin for dimensions authored on-view (presented in
  parentheses).
- **Annotations** — `note`, `leader`, `holeCallout` (diameter + depth),
  `threadCallout` (ISO designation + depth), and `featureControlFrame`
  (the pinned ISO 1101 characteristic subset — 14 characteristics, symbol
  map in `GDNT_SYMBOLS`).

Parse/serialize round-trips exactly (`parseDrawingDimension` /
`serializeDrawingDimension` and the annotation pair, stable
`drawing-annotations/*` failure codes, fixed key order — identical
drawings serialize byte-identically). Entity ids are branded
`drdim_<payload>` / `drann_<payload>` strings.

## Parametric-source recovery

Dimensions are RECOVERED, never re-typed:

- `cad-core`'s `recoverFeatureDimensions` reads the documented parameter
  layouts — an `extrude` feature's first length parameter is the depth, a
  `fillet`'s is the radius — and derives each dimension's value from that
  parameter through `valueIn(value, "mm")`. A depth authored as `2 cm`
  recovers as a 20 mm dimension: the value is unit-converted from the same
  parameter the geometry regenerates from.
- `cad-sketch`'s `recoverSketchDimensions` parses each document sketch's
  embedded payload and turns the Phase 36 dimensional constraints
  (`distance`, `distanceX`, `distanceY`, `radius`, `diameter`, `angle`)
  into drawing dimensions, one row per constraint, stacked above the view
  frame.
- The workbench's `drawing-sources.ts` composes both plus hole/thread
  callouts read through the hole scene's own structured reader and the
  thread layout, with designations from the kernel's pinned ISO metric
  table (`M8`, `M8x0.75`, ...).

Recovery is total and additive: a feature whose layout does not resolve is
skipped — never fabricated.

## Sheet furniture and templates

`drawing-sheet.ts` pins the ISO 216 A-series table (A4–A0, portrait
millimetres), the sheet setup (size, orientation, scale), the six-field
title block, revision rows, and three pinned templates
(`DRAWING_SHEET_TEMPLATES` — the template picker persists the id, never a
copied record).

`drawing-presentation.ts` presents everything as pure primitives (lines,
rects, arcs, arrowheads, text) with fixed constants — the same
`composeSheetPresentation` output feeds the live canvas and the exporter,
so what the author sees is byte-for-byte what exports.

## The export preview

`drawing-svg.ts` serializes primitives to SVG deterministically: no clock,
no randomness, no locale-sensitive formatting, fixed attribute order,
numbers through `formatSvgNumber` (four decimals, trailing zeros trimmed).
Re-exporting an unchanged sheet is byte-identical, and the workbench's
machine surface (`#drawing-root` → `data-drawing-svg`) publishes the exact
bytes for tests to assert against.

## The unified surface

`/drawings` is the ONE drawing route (Phase 55 round 2 unified the two
surfaces). The first sheet's creation boots the deterministic seed
document (rectangle sketch, 2 cm-deep extrude, 4 mm fillet, threaded M8
structured hole) and recovers its dimensions onto the sheet; reference
dimensions, title block fields, revision rows, and templates author
through Formedible dialogs (each mounts only when open — the route's SSR
stays clean). No kernel session runs: recovery reads records, not
geometry.

## One presentation, one route

`presentDrawingSheet` (in `drawing-output.ts`) walks the drawing document
once into sheet pictures — `DrawingPrimitive` groups in the same y-up
sheet-millimetre vocabulary and flip discipline the Phase 54 presentation
owns. The SVG/PDF exporters, the DXF writer, and the unified workbench
canvas all consume that ONE walk: the canvas composes the Phase 54
furniture groups over the document groups, so dimensions, title block,
views, BOM tables, balloons, and print all read from a single picture.
Phase 55 round 2 also fixed `polygonArea` to measure the AREA VECTOR's
magnitude — a scalar sum of the projected cross products overstated
oblique cuts by up to √3 (the cube's x+y+z=15 hexagon read 225, not
75·sqrt(3) ≈ 129.9).
