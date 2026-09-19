# Custom tools

A tool is the smallest honest unit of CAD interaction: a pure reducer
over normalized events that issues transactions through a context. The
whole surface is four pieces from `@slopcad/cad-core` —
`tool-events.ts`, `tool-context.ts`, `tool-manager.ts`, and your tool.

## 1. State and events

```ts
import type { CadTool, ToolStateBase, ToolInputEvent } from "@slopcad/cad-core";

interface StampState extends ToolStateBase {
  readonly clicks: number;
}

export const stampTool: CadTool<StampState> = {
  id: "guide.stamp", // 1-64 chars, letter first, [A-Za-z0-9._-]
  initialState: { stage: "await-anchor", clicks: 0 },
  onEvent(state, event, context) {
    /* pure reducer */
  },
};
```

Events are data: `pointer-down`/`move`/`up` with `point` (world mm or
null), `pick` (a `ToolPick`: selection reference + render object id),
and `modifiers`; `key-down`/`up` with `key` + modifiers. The R3F layer
normalizes native events into this vocabulary
(`toolPointerEvent`, `toolModifiersFromNative` in `@slopcad/cad-r3f`).

## 2. The reducer

Given the same (state, event, context state), the reducer is
deterministic. It returns a `ToolTransition` — next state, phase
(`active` | `completed`), and on completion a structured
`ToolCompletionDetail` (`commands` with the issued transaction,
`measurement`, …) or a `failure` report (the tool stays active):

```ts
if (event.type !== "pointer-down") return { state, phase: "active" };
const clicks = state.clicks + 1;
if (clicks === 1) {
  if (event.pick !== null) {
    const picked = context.applySelection({
      type: "pick",
      reference: event.pick.reference,
      additive: false,
    });
    if (!picked.ok)
      return {
        state: { stage: "failed", clicks },
        phase: "active",
        failure: { code: "guide/stamp-pick", message: picked.error.message },
      };
  }
  return { state: { stage: "await-target", clicks }, phase: "active" };
}
const stamped = context.issue({
  commands: [/* body.create + parameter.create */],
});
if (!stamped.ok)
  return {
    state: { stage: "failed", clicks },
    phase: "active",
    failure: { code: "guide/stamp-commit", message: stamped.error.message },
  };
return {
  state: { stage: "done", clicks },
  phase: "completed",
  detail: { kind: "commands", transaction, summary: "…" },
};
```

There is no other document path: a tool cannot touch a body, feature, or
parameter except by issuing commands, and selection ops ride the same
discipline as data.

## 3. Registration and lifecycle

```ts
import {
  createToolManager,
  createToolRuntime,
  registerTool,
} from "@slopcad/cad-core";

const runtime = createToolRuntime({
  session,
  selection: createSelectionState(0),
});
const manager = createToolManager({
  tools: [registerTool(stampTool)],
  context: runtime,
});
manager.activate("guide.stamp"); // inactive → active
manager.dispatch(event); // routed to the active tool
manager.cancel();
manager.reset(); // host-controlled teardown
```

Lifecycle misuse is a caller bug: activating an active tool throws a
`RangeError` naming the phase.

## The runnable example

`packages/docs-examples/src/core/custom-tool.ts` is the complete stamp
tool driven through a real manager — phases `active → active →
completed`, one body + one parameter committed, the `commands`
completion captured. The suite pins every step.
