# Tools

The headless CAD tool system (cad-core's `tool-context.ts` +
`tool-manager.ts` + the built-in tools) drives interactive modeling
without any DOM — the same tool runs in a headless test, the React
workbench, and the app shell.

## The shape of a tool

A `CadTool<S>` is an id, an `initialState`, and a pure reducer over
normalized events (`ToolInputEvent`: pointer down/move/up with world
point + pick + modifiers, key down/up). Tools never touch domain state
directly — everything goes through the `ToolContext`:

- `issue(transaction)` — the ONLY document path; atomic through the
  session commit.
- `applySelection(operation)` — pick/clear/hover as serializable data.
- `session`, `selection`, `projection` — read-only views.

`registerTool(tool)` wraps it as a sound, type-erased registry entry;
`createToolManager({ tools, context })` owns the lifecycle:
`inactive → active → completed | cancelled`, with misuse (double
activation, dispatch while inactive) throwing a `RangeError` that names
the phase. Completions carry structured details (`commands`,
`measurement`, …).

## The built-ins

`selectTool`, `translateTool`, `rotateTool` (cad-core), and the
workbench's registered inspection/feature tools — the same tools the
registry distributes as installable items (`bounds-inspection-tool`,
`distance-inspection-tool`, `mass-properties-inspection-tool`,
`radius-inspection-tool`, `extrude-tool`, `revolve-tool`, `hole-tool`;
see [registry.md](registry.md)).

## The reference host

`createToolRuntime({ session, selection, projection?, onTransaction? })`
is the entire harness a headless test needs — a mutable holder of
immutable states, with `onTransaction` surfacing the machine-readable
command log.

## React

`@slopcad/cad-react`'s `useCadTools` mirrors the manager's surface
(active tool, phase, completion, failure, dispatch) behind the store.

## The runnable example

`packages/docs-examples/src/core/custom-tool.ts` is a complete custom
tool driven end to end — the natural next stop is
[custom-tools.md](custom-tools.md).
