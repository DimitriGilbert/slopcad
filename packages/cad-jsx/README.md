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
`feature.create` commands — nothing else. The element tags carry no
geometry and no evaluator; they are authoring sugar over the command
vocabulary, and `applyCommand` (in `@slopcad/cad-core`, the sole
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
dimensional prop becomes a length parameter the feature consumes, in the
order the bridge reads them.

| Element       | Props                                              | Compiles to                                                                                                                                  |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Parameter>` | `name`, `value`, `id?`                             | `parameter.create` (a re-declaration of the same id and name compiles to `parameter.set`)                                                    |
| `<Body>`      | `name`, `id?`, `children?`                         | `body.create`; at most one producing child may declare this body as its feature's output                                                     |
| `<Box>`       | `width`, `depth`, `height`, `id?`                  | 3 × `parameter.create` + `body.create` + `feature.create` kind `box` (inputs: width, depth, height)                                          |
| `<Sphere>`    | `radius`, `id?`                                    | 1 × `parameter.create` + `body.create` + `feature.create` kind `sphere` (inputs: radius)                                                     |
| `<Cylinder>`  | `radius`, `height`, `id?`                          | 2 × `parameter.create` + `body.create` + `feature.create` kind `cylinder` (inputs: radius, height)                                           |
| `<Cone>`      | `bottomRadius`, `topRadius`, `height`, `id?`       | 3 × `parameter.create` + `body.create` + `feature.create` kind `cone` (inputs: bottomRadius, topRadius, height)                              |
| `<Translate>` | `x?`, `y?`, `z?` (default 0 mm), `id?`, `children` | its child's commands, then 3 × `parameter.create` + `body.create` + `feature.create` kind `translate` (inputs: the child's feature, x, y, z) |

Dimensional props accept three forms:

- a plain number — canonical millimetres (`width={30}`);
- a dimensional quantity from `@slopcad/cad-core` (`width={length(2, "cm")}`),
  which must be a **length** (the bridge reads length parameters);
- a parameter id string (`width="param_width"`) — the feature consumes that
  `<Parameter>` instead of creating its own; the parameter must be declared
  **before** this point in the tree (the transaction folds in order, so a
  forward reference could never apply).

`<Parameter name value>`: a plain number value is canonicalized as
millimetres; any dimension may be authored with an explicit quantity
(`angle(90, "deg")`). The name must be a valid expression identifier — it
is the document's identifier vocabulary.

`<Body>` wraps at most one producing element (`<Box>`, `<Sphere>`,
`<Cylinder>`, `<Cone>`, `<Translate>`); that child's feature outputs the
`<Body>`'s body instead of creating its own. A `<Body>` with no producer
is a bare body record. A `<Translate>` wraps exactly one producing child
(its child keeps its own body — the translate references the child's
feature).

The element tags are frozen, branded function values: callable only so
JSX and `createElement` accept them as tags. They must never be invoked;
calling one throws.

## Id assignment

Ids are assigned deterministically during the walk, in document order:

- `<Parameter>`: `param_<name>` (the name is identifier-safe by rule), or
  the explicit `id` prop (`param_…`).
- `<Body>`: the explicit `id` prop, or `body_<sanitized-name>` (each run
  of characters outside `A-Za-z0-9._-` collapses to one `-`).
- Primitives and `<Translate>`: the `id` prop is the **feature id**
  (`feat_…`). Its payload (the part after `feat_`) is the element's slug;
  the output body is `body_<slug>` and each dimensional prop's implicit
  parameter is `param_<slug>-<dimension>` (name `<slug><Dimension>` with
  the slug stripped to identifier characters, e.g. `box1Width`).
- Without an explicit id, the slug is `<kind>-<occurrence>` counted per
  element kind across the whole tree in document order (`box-1`, `box-2`,
  …), so `feat_box-1`, `body_box-1`, `param_box-1-width`, ….

All generated payloads are non-numeric, so they can never collide with the
document's own generator space (`feat_000042`). The compiler keeps one id
space across parameters, bodies, and features (as the document does) and
rejects a duplicate claim structurally.

## Determinism guarantees

`compileModel` consults no clock, no randomness, and no environment: the
same element tree compiles to a transaction whose
`JSON.stringify(serializeTransaction(…))` is byte-identical every time.
Registries inside the walk are keyed for lookup only — never iterated to
produce output — so no map iteration order leaks into the result.

## What is rejected, and why

Everything below is rejected with a structured `CadJsxCompileError`
(`code` like `cadjsx/class-component-rejected`, a message, the rejected
`input`, and the tree `path`) — the compiler never throws for domain
errors:

- **Class components** — a model must be pure data; there is no render
  lifecycle here.
- **String (HTML) tags** — no DOM exists in a CAD model.
- **Functions, promises, symbols, class instances, NaN/Infinity in
  props** — props must be plain serializable data; only the element type
  itself may be a function. (A component that calls a hook throws when
  invoked outside a renderer; the throw is caught and reported as
  `cadjsx/component-threw`, naming the component.)
- **Components returning text or raw values** — a component must return
  an element, an array, or `null`.
- **Unknown element kinds** — `defineCadElement` is the extension point,
  but this compiler version lowers only the seven kinds above.
- **Unknown props on elements, unexpected children on childless
  elements.**
- **Duplicate ids** (one id space, mirroring the document) and **duplicate
  parameter names under different ids.**
- **References to parameters not declared before use.**
- **`<Body>` with two producers, `<Translate>` without exactly one
  producer, nested `<Body>` containers.**
- **Text or number children** — `null`/`undefined`/`true`/`false`
  children are the supported conditional-authoring forms.
- **Trees deeper than 100 levels** (a component returning itself
  forever) — `cadjsx/tree-too-deep`.

Accepted transparent nodes: React Fragments (children pass through),
arrays of children (flattened in order), and user function components
(invoked once, with serializable props, and their return walked).

## Boundaries

This package sits directly above `@slopcad/cad-core` and depends on
nothing else in the workspace (`docs/guides/package-boundaries.md`) — no
cad-kernel, no cad-react, no three. React is a peer dependency: the
compiler consumes React elements as plain data and never renders.

## API

- `compileModel(root: ReactElement<unknown>): ParseResult<CadTransaction, CadJsxCompileError>` —
  compile a model to its command transaction.
- `defineCadElement<P>(kind: string): CadElementTag<P>` — the element
  factory (the extension point for later phases).
- `CAD_JSX_ERROR_CODES` / `CadJsxCompileError` — the stable failure codes
  and structured error shape.
- The element tags and their prop types (`Box`, `BoxProps`, …) from
  `./elements`.
