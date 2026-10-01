# React integration

`@slopcad/cad-react` is the React integration layer over the kernel-neutral
core — the PRD's §23 surface (`CadProvider` and the `useCad*` hooks, plus
"declarative model definitions where useful", `slopcad — Product & Technical
Requirements.md:1031-1044`). The imperative half of that promise lives here;
the declarative half is [JSX models](cad-jsx.md). The layer's own law, from
`packages/cad-react/src/store.ts:7-20`: **the domain is canonical; React
only mirrors it.**

## The store: a mirror with scoped notifications

`createCadStore` composes the host's own domain instances — a
`CadSession`, a `SelectionState`, tool registry entries — into the
cad-core `ToolRuntime`/`ToolManager` reference host. It never invents
state: every read is a domain value, every mutation is a domain operation,
and there is no `setState` path into the domain. Hosts that replace the
whole session (document load, external undo) go through the one explicit
door, `replaceSession`, which refuses anything that is not session-shaped
with a `RangeError` — mirrored state never flows back in
(`packages/cad-react/src/store.ts:323-331`).

Consumers subscribe per **concern** and the store diffs domain identity
after every operation (`packages/cad-react/src/store.ts:80-90`):

| Concern      | Mirrors                             | Notifies on                           |
| ------------ | ----------------------------------- | ------------------------------------- |
| `document`   | the session's document              | commit, undo, redo, session replace   |
| `parameters` | the document's parameter collection | a subset of `document` changes        |
| `history`    | cursor/depth availability view      | cursor or entry-count change          |
| `selection`  | the selection state                 | picks, hovers, regeneration advances  |
| `tools`      | the tool manager surface            | phase, active id, tool state, failure |

Within one sync pass, `document` fires before `parameters` and `history`.
The hooks pair each concern with `useSyncExternalStore`, whose snapshot
identity check is a second, redundant net over the same immutability — a
selection change cannot re-render a document-only subscriber. The store
also keeps the `commandLog` (the canonical serialization of every issued
transaction, in issue order) for hosts to surface in tests and telemetry.

## The provider and the hooks

`CadProvider` mounts the host-composed store into context; it never
constructs domain state, and any CAD hook used without a provider ancestor
throws the structured `CadProviderError`
(`cad-react/provider-missing`, `packages/cad-react/src/provider.tsx`).

- `useCadDocument` — the document and session, plus
  `applyTransaction`/`applyCommand` (the transactional write paths).
- `useCadParameters` — the collection plus `setValue` (one `parameter.set`
  transaction) and the expression-aware pair `evaluate` /
  `setValueFromExpression`: a text expression is parsed with the domain's
  own parser and committed AS the defining expression (the vocabulary's
  serialized-AST payload — the document validates identifiers and cycles
  and recomputes the dependents); a parse failure or a domain refusal
  issues nothing.
- `useCadHistory` — `canUndo`/`canRedo`/`cursor`/`depth` plus the two
  history moves.
- `useCadSelection` — the state plus pick/hover/clear/regeneration
  operations, exactly the domain model's own.
- `useCadTools` — the manager surface plus the lifecycle ops: `activate`
  (only from `inactive`), `arm` (the cancel-if-active → reset → activate
  composition), the guarded idempotent `cancel`, `reset`, `dispatch`.
- `useCadModel` — the authoring surface. It subscribes to nothing: it is
  a pure mutation surface bound to the session commit.

## Command factories, not a second model

The composable model API (`packages/cad-react/src/model.ts:7-20`) is the
hard rule the JSX compiler also obeys: everything is a **command factory**.
`setParameterCommand`, `createFeatureCommand`, `updateFeatureCommand`,
`deleteFeatureCommand`, and the primitive transaction builders
(`createPrimitiveTransaction` and friends) emit plain `CadCommand` data —
the same serializable, replayable vocabulary the domain's single
interpreter (`applyCommand`, `packages/cad-core/src/command.ts`) executes.
A descriptor is consumed at build time and dies; it never becomes a
parallel model, graph, or evaluator. What you author is exactly what the
session commits and the history records — there is nothing else to keep in
sync.

## Mounting the viewport

`CadViewport` (`@slopcad/ui`) is the one-mount composition, with two
documented input modes (`packages/ui/src/components/cad/cad-viewport.tsx:12-32`):

- **Prop-driven** — pass `selection`, `regeneration`, and optionally the
  pick callbacks; pure display and event passthrough, no provider needed.
- **Provider-driven** — mount below a `<CadProvider>` and omit the props:
  selection mirrors through `useCadSelection`, and pointer/keyboard input
  dispatches to the active tool through the `tools` concern (with no tool
  active, picks and hovers apply directly to selection state).

Explicit props always win per group; supplying any pick callback switches
the whole interaction surface to prop-driven. The renderer underneath
(`@slopcad/cad-r3f`) is deliberately provider-free — it takes the
projection, selection, and pick callbacks as explicit props and knows
nothing of `CadProvider`/hooks
(`packages/cad-r3f/src/index.ts:11-19`), so the deterministic scene never
couples to one integration layer. The render pipeline itself is
[r3f.md](r3f.md).

## The workbench: a composed host

The app's workbench is this guide at full scale. The data plane is
`apps/web/src/cad-workbench/workbench-engine.tsx`: one store over the
workbench session (the select/measure/rotate tools registered), built in
`useWorkbenchStore` **above** the `CadProvider` so the composition owns
it exactly once. `complete-workbench.tsx` composes the eight workbench
surfaces — toolbar, command menu, viewport, model tree, property panel,
parameter panel, history timeline, status bar — around that one provider,
every interaction riding the public hooks and the command vocabulary.

## The runnable example

`packages/docs-examples/src/react/store.tsx` builds a store over a host
session (one body, one `holeDiameter` parameter), mounts it through
`CadProvider` in one lazy `useState` (a store built in the render body
would be replaced on every parent re-render, silently discarding the
document and its history), and edits the parameter through
`useCadParameters().setValue` — one `parameter.set` transaction. The
jsdom suite (`packages/docs-examples/src/react-example.test.tsx`) asserts
the edit lands, the component re-renders with the new value, and the
store survives parent re-renders; the `/docs` page mounts the same panel
live.
