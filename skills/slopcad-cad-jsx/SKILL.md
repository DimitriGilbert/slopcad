---
name: slopcad-cad-jsx
description: Author, compile, and round-trip CAD models as React/TSX files in slopcad with @slopcad/cad-jsx. Use whenever writing or editing a .tsx CAD model (any element like <Box>, <Sketch>, <Extrude>, <Subtract>, <Hole>), checking element props, running the compile CLI, importing or exporting TSX in the workbench, or generating TSX from a document — even if the user just says "model this part", "bracket", or "parametric model" in a CAD context.
---

# CAD models as JSX — @slopcad/cad-jsx

Author CAD models as ordinary `.tsx` React element trees; the compiler
walks the tree as **pure data** and lowers it onto the `@slopcad/cad-core`
command vocabulary — the same serializable, replayable commands the
workbench authors by hand.

Written against the shipped code on branch `agent-surface`
(`packages/cad-jsx/src/elements.ts` is the element truth); the worked
example's numbers come from a real CLI run.

## The model

- A model is a `.tsx` file whose **default export** is a React element or
  a component function (invoked once, no props — or export the element
  itself with props baked in). Function components only.
- The JSX is authoring sugar: it compiles deterministically to
  `parameter.create` / `parameter.set` / `body.create` / `sketch.create` /
  `feature.create` commands, and `applyCommand`
  (`packages/cad-core/src/command.ts`) is the **sole interpreter** —
  there is no second parametric representation (the law
  `packages/cad-react/src/model.ts` states): the tags carry no geometry,
  no graph, no evaluator.
- Nothing renders. The tags exist as branded functions only so JSX
  type-checks; invoking one throws. No hooks, no classes, no DOM — the
  compiler walks `createElement` output with no renderer attached.
- The walk consults no clock, randomness, or environment: the same tree
  compiles byte-identically every time.

## Authoring rules

1. **File shape**: default-export the element or a no-props component.
   Components may take props when you export the instantiated element
   (`export default <Bracket thickness={6} />`). The CLI transpiles with
   the automatic JSX runtime — no React import needed (`React.JSX.Element`
   as a return type works via `@types/react`).
2. **Dimensional values** take three forms: a plain number in the prop's
   canonical unit (mm for lengths, radians for angles, bare count for
   dimensionless); an explicit quantity — `length(2, "cm")`,
   `angle(90, "deg")`, `dimensionless(4)`, re-exported from
   `@slopcad/cad-jsx`; or the id of a `<Parameter>` declared EARLIER in
   the tree (`height="param_thickness"` — a bare string is always a
   parameter id). A referenced parameter's dimension is NOT compile-checked
   (the kernel's regeneration diagnostic owns that).
3. **Selector props** (`axis`, `plane`, `mode`, `type`, `handedness`,
   `orientation`, `variant`, `fit`, `flavor`, `keep`, `heal`, `merge`,
   `direction`) are compile-time constants — never parameter references.
4. **Ids**: give explicit ids (`param_…`, `body_…`, `skd_…`, `feat_…`,
   `skent_…`) to everything referenced by id. Unreferenced elements may
   rely on the deterministic scheme (`<kind>-<occurrence>` slugs — see
   elements.md) — but explicit ids make the feature tree readable and the
   ids stable when the tree grows.
5. **`<Use feature="feat_…">` is the one sharing mechanism**: an element
   consumed more than once stays put (give it an explicit `id`), and each
   consumer points at it with `<Use>`. The referenced feature must be
   produced EARLIER in the tree (`cadjsx/reference-unknown` otherwise).
6. **Boolean child order matters**: `<Subtract>`'s FIRST child is the
   base, the rest are tools. Booleans need ≥ 2 producing children;
   operations and `<Translate>` need exactly one producing child.
7. **Sketches are records**: `<Sketch>` is a top-level sibling whose
   children are entity elements only (`<Line>`, `<Circle>`, …). A
   sketch-consuming element (`<Extrude>`, `<Hole positions>`, …)
   references an in-scope `<Sketch id=…>` declared earlier. Entity props
   are plain numbers (workplane mm, radians) — never parameter references.
8. **Rejections that will bite** (structured `cadjsx/…` errors, never
   throws): hooks (a hook-throwing component surfaces as
   `cadjsx/component-threw`), class components, string/HTML tags,
   functions/promises/NaN in props, unknown props or kinds, duplicate ids,
   forward parameter references, wrong producer counts, mixed
   layout props (`cadjsx/prop-conflict`), trees deeper than 100 levels.
   Transparent: fragments, arrays, `null`/`false` children, and user
   function components (invoked once).

## Element quick-reference

The full 43-kind vocabulary with per-kind props and notes lives in
**`elements.md`** next to this file — read it before authoring any
element not listed here. The everyday core:

| Element       | Props                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| `<Parameter>` | `name`, `value`, `id?`                                                                       |
| `<Body>`      | `name`, `id?`, `children?`                                                                   |
| `<Box>`       | `width`, `depth`, `height`, `id?`                                                            |
| `<Cylinder>`  | `radius`, `height`, `id?`                                                                    |
| `<Translate>` | `x?`, `y?`, `z?`, `id?`, `children?`                                                         |
| `<Union>`     | `id?`, `children?`                                                                           |
| `<Subtract>`  | `id?`, `children?`                                                                           |
| `<Intersect>` | `id?`, `children?`                                                                           |
| `<Use>`       | `feature`                                                                                    |
| `<Sketch>`    | `id?`, `name?`, `origin?`, `normal?`, `xAxis?`, `children?`                                  |
| `<Point>`     | `x`, `y`, `id?`                                                                              |
| `<Line>`      | `x1`, `y1`, `x2`, `y2`, `id?`                                                                |
| `<Rectangle>` | `x1`, `y1`, `x2`, `y2`, `id?`                                                                |
| `<Circle>`    | `cx`, `cy`, `radius`, `id?`                                                                  |
| `<Extrude>`   | `sketch`, `height`, `direction?`, `taper?`, `id?`                                            |
| `<Revolve>`   | `sketch`, `angle`, `axis?`, `axisDatum?`, `id?`                                              |
| `<Hole>`      | `type?`, `diameter?`, `depth?`, `tipAngle?`, … (18 props across two forms — see elements.md) |
| `<Fillet>`    | `radius`, `edges`, `id?`, `children?`                                                        |

## Records the tree cannot mint

Three prop families address document records a static tree cannot
create, so they carry ids of records the **target document already
carries**: `ref_…` persistent references (the `edges`/`faces`/`face`
props of `<Fillet>`, `<Chamfer>`, `<Shell>`, `<MoveFace>`,
`<ReplaceFace>`, `<DeleteFace>` — minted only by the picking layer
against live topology), `dtm_…` datums (`<Split>`, `<Mirror>`'s datum
form, datum-axis alternatives), and `crv_…` curves (`<SweepWire>`'s
spine). Ids are validated by shape at compile time; existence is the
document's verdict at apply time.

Consequence for the CLI: a standalone model containing such an element
compiles but fails the fold over a fresh document. Real output for a
`<Fillet edges={["ref_edge-1"]}>` over a box (exit code 1):

```text
cadjsx compile: cadjsx/native-command-failed: The compiled transaction
does not apply to a fresh document (command 7 failed): The command at
index 7 of the transaction failed: Feature input (reference "ref_edge-1")
does not resolve to an entity in document "doc_fillet-check".
```

Author fillets/chamfers in the workbench (where picking mints the
references), not in a standalone `.tsx`.

## Workflows

### Compile a `.tsx` through the CLI

```bash
pnpm --filter @slopcad/cad-jsx compile \
  ../docs-examples/src/cadjsx/hub-mount.tsx [--out <path>]
```

- **cwd caveat**: `pnpm --filter` runs the script from
  `packages/cad-jsx`, so relative model paths resolve from THERE — the
  `../` hop is what makes the command work copied from the repo root.
  Put model files where `@slopcad/cad-jsx` resolves (a workspace package
  directory, e.g. `packages/docs-examples/src/cadjsx/`): the CLI loads
  the model by transpiling to a sibling `.mjs`, so the model's own
  imports resolve against the model's directory.
- stdout always carries the native `slopcad` document JSON — but pnpm's
  script banner precedes it when piped; use `--out <path>` for clean
  bytes (an extensionless path gains `.native.json`; the path resolves
  relative to `packages/cad-jsx`). The output is exactly what the
  documents API stores as `nativeContent` and the workbench opens.
- The emitted document id derives from the model file's basename
  (`hub-mount.tsx` → `doc_hub-mount`). Exit codes: `0` success, `1`
  compile/validation error (stderr, structured `cadjsx…` code), `2`
  usage error. `--help` prints the contract.

### Import and export in the workbench

- **Import**: the Import dialog's TSX row (`.tsx`, "model / server")
  posts the file to `POST /api/io/import-tsx`
  (`apps/web/src/io-fixture/import-tsx-endpoint.ts`), which runs the
  canonical loader (`@slopcad/cad-jsx/loader`): esbuild classic JSX
  transform, evaluated in a fresh `node:vm` whose globals are exactly
  React's `createElement`/`Fragment` and the element runtime; a
  `require` resolving only `"react"` and `"@slopcad/cad-jsx"` (anything
  else is `cadjsx-load/forbidden-import`); a 1 MiB source cap and a
  250 ms evaluation budget. The endpoint is session-gated (401), with a
  64 MiB body cap (413) and structured refusals (422).
- **Export**: the Export dialog's TSX row ("model / source") runs
  `generateTsx` client-side; the result reports either "full document
  round-trip" or its honest decline count.

### Document → TSX generation: honest declines

`generateTsx` (the compiler's inverse) reproduces a document
byte-stably, and **declines, never drops**: records the vocabulary
cannot declare come back as structured notes (kind, id, reason) in the
return data AND the generated file's header, and declines cascade to
consumers. The declined families: datum, curve, and
persistent-reference records; sections, occurrences, mates, joints,
configurations; suppressed/display-flagged/appearance-carrying bodies;
expression- or metadata-carrying parameters; features whose input
layouts are not the compiler's (unknown kinds, foreign shapes). When a
document's creation order is not reproducible in the canonical form
(parameters first, sketches at first consumer, features in timeline
order), generation refuses outright with `cadjsx-generate/…-order` —
never a silent diff.

### Verify a model

1. Compile twice, compare: two runs must be byte-identical (the walk is
   deterministic — any difference means the tree sneaks in
   nondeterminism).
2. Compile with `--out`, then open/import the native JSON in the
   workbench and check the feature tree: the bodies and feature kinds in
   timeline order, parameters carrying the authored values.
3. For round-trip work: export TSX from the imported document and
   re-import — declines must be zero or explained.

## Worked example: a mounting bracket

A parameterized plate, a four-hole corner pattern placed by a sketch of
points, a center counterbore — captured in a `<Body>` (verified against
the CLI; save as `bracket.tsx` in a workspace package directory):

```tsx
import {
  angle,
  Body,
  Extrude,
  Hole,
  Parameter,
  Point,
  Rectangle,
  Sketch,
} from "@slopcad/cad-jsx";

/** The bracket model: `thickness` and `cornerOffset` drive everything. */
export function Bracket(props: {
  thickness: number;
  cornerOffset: number;
}): React.JSX.Element {
  return (
    <>
      <Parameter
        id="param_thickness"
        name="thickness"
        value={props.thickness}
      />
      <Sketch id="skd_profile" name="bracket profile">
        <Rectangle x1={-40} y1={-24} x2={40} y2={24} />
      </Sketch>
      <Sketch id="skd_holes" name="hole pattern">
        <Point x={-props.cornerOffset} y={14} />
        <Point x={props.cornerOffset} y={14} />
        <Point x={-props.cornerOffset} y={-14} />
        <Point x={props.cornerOffset} y={-14} />
      </Sketch>
      <Body id="body_bracket" name="bracket">
        <Hole
          id="feat_cbore"
          type="counterbore"
          diameter={9}
          depth={6}
          tipAngle={angle(118, "deg")}
          cboreDiameter={14}
          cboreDepth={2}
          positionX={0}
          positionY={0}
        >
          <Hole
            id="feat_corner-holes"
            type="straight"
            diameter={5}
            depth="param_thickness"
            tipAngle={angle(118, "deg")}
            positions="skd_holes"
          >
            <Extrude
              id="feat_plate"
              sketch="skd_profile"
              height="param_thickness"
            />
          </Hole>
        </Hole>
      </Body>
    </>
  );
}

export default <Bracket thickness={6} cornerOffset={30} />;
```

Compiling it (`pnpm --filter @slopcad/cad-jsx compile <path>/bracket.tsx`)
emits document `doc_bracket` (derived from the file's basename) — one
transaction at cursor 1, **22 commands** (14 × `parameter.create`, 2 ×
`sketch.create`, 3 × `body.create`, 3 × `feature.create`), no
regeneration states. The feature tree:

```text
parameter.create  param_thickness                    (6 mm)
sketch.create     skd_profile, skd_holes
body.create       body_bracket, body_plate, body_corner-holes
feature.create    feat_plate          kind extrude (height ← param_thickness)
feature.create    feat_corner-holes   kind hole    (positions ← skd_holes)
feature.create    feat_cbore          kind hole    (counterbore, at 0,0)
```

The counterbore's dimensions are literals (implicit params
`param_cbore-*`); the corner holes' `depth` and the plate's `height`
consume `param_thickness`, so one `parameter.set` re-drives them all.

## Deeper docs

- `docs/guides/cad-jsx.md` — the user-facing guide (the hub-mount
  walkthrough with the emitted command list).
- `packages/cad-jsx/README.md` — the full authoring reference: every
  element's compiled form, the id scheme, determinism, native emission,
  the loader, the generator, and the complete rejection catalogue.
- `packages/docs-examples/src/cadjsx/hub-mount.tsx` — the runnable
  worked model (`<Use>` sharing, revolve, loft; 19 commands).
- `packages/cad-jsx/src/elements.ts` — the shipped element truth.

## Verification bar

Every element and prop above exists in `packages/cad-jsx/src/elements.ts`
with the same name and optionality; every command is copy-paste runnable
from the repo root (mind the cwd caveat); the worked example's numbers
come from a real CLI run on this branch. When the package changes,
re-derive `elements.md` from `elements.ts` — a mismatch is a defect.
