/**
 * Phase 14 hook tests (jsdom): the React side of the CAD boundary, driven
 * through real React commits. Covered here:
 *
 * - provider-less usage throws the structured CadProviderError (every hook);
 * - document, parameter, selection, tool, and history changes are each
 *   OBSERVED by the hook that mirrors them;
 * - re-renders are SCOPED: a selection change does not re-render a
 *   document-only subscriber and vice versa (render counts);
 * - the no-mutation-path rule: feeding raw domain state back is impossible
 *   by types (pinned with @ts-expect-error) and the exposed domain values
 *   are frozen;
 * - the composable model API commits primitives as single Phase 7
 *   transactions through useCadModel.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBodyId,
  createFeatureId,
  length,
  MEASURE_TOOL_ID,
  SELECT_TOOL_ID,
  serializeTransaction,
  type CadDocument,
  type CadSession,
  type SelectionState,
} from "@slopcad/cad-core";
import type { CadStore } from "./store";

import { CadProvider, CadProviderError } from "./provider";
import {
  createTestStore,
  TEST_BODY_ID,
  TEST_WIDTH_PARAMETER,
} from "./test-support";
import { useCadDocument } from "./use-cad-document";
import { useCadHistory } from "./use-cad-history";
import { useCadModel } from "./use-cad-model";
import { useCadParameters } from "./use-cad-parameters";
import { useCadSelection } from "./use-cad-selection";
import { useCadTools } from "./use-cad-tools";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface ProbeProps {
  readonly renders: { count: number };
}

/** Renders the document hook's observations and counts its renders. */
function DocumentProbe({ renders }: ProbeProps): ReactNode {
  const api = useCadDocument();
  renders.count += 1;
  return (
    <div
      data-testid="document-probe"
      data-feature-count={String(api.document.features.length)}
    />
  );
}

/** Renders the parameters hook's observations and counts its renders. */
function ParametersProbe({ renders }: ProbeProps): ReactNode {
  const api = useCadParameters();
  renders.count += 1;
  const width = api.getByName("width");
  return (
    <div
      data-testid="parameters-probe"
      data-width-mm={width === undefined ? "" : String(width.value.value)}
    />
  );
}

/** Renders the selection hook's observations and counts its renders. */
function SelectionProbe({ renders }: ProbeProps): ReactNode {
  const api = useCadSelection();
  renders.count += 1;
  return (
    <div
      data-testid="selection-probe"
      data-selected={String(api.selected.length)}
      data-regeneration={String(api.regeneration)}
    />
  );
}

/** Renders the tools hook's observations and counts its renders. */
function ToolsProbe({ renders }: ProbeProps): ReactNode {
  const api = useCadTools();
  renders.count += 1;
  return (
    <div
      data-testid="tools-probe"
      data-phase={api.phase}
      data-tool-id={api.activeToolId ?? ""}
      data-stage={api.toolState?.stage ?? ""}
    />
  );
}

/** Renders the history hook's observations and counts its renders. */
function HistoryProbe({ renders }: ProbeProps): ReactNode {
  const api = useCadHistory();
  renders.count += 1;
  return (
    <div
      data-testid="history-probe"
      data-can-undo={String(api.canUndo)}
      data-can-redo={String(api.canRedo)}
      data-depth={String(api.depth)}
    />
  );
}

interface BoundaryState {
  readonly error: unknown;
}

/** Captures render errors so provider-less usage can be asserted structurally. */
class Boundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  render(): ReactNode {
    const error = this.state.error;
    if (error !== undefined) {
      const code = error instanceof CadProviderError ? error.code : "other";
      return <div data-testid="boundary-error" data-code={code} />;
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Provider-less usage
// ---------------------------------------------------------------------------

describe("CAD hooks without a provider", () => {
  it("every hook throws the structured provider error", () => {
    const probes = [
      <DocumentProbe key="document" renders={{ count: 0 }} />,
      <ParametersProbe key="parameters" renders={{ count: 0 }} />,
      <SelectionProbe key="selection" renders={{ count: 0 }} />,
      <ToolsProbe key="tools" renders={{ count: 0 }} />,
      <HistoryProbe key="history" renders={{ count: 0 }} />,
    ];
    for (const probe of probes) {
      const view = render(<Boundary>{probe}</Boundary>);
      const reported = view.container.querySelector(
        '[data-testid="boundary-error"]',
      );
      expect(reported?.getAttribute("data-code")).toBe(
        "cad-react/provider-missing",
      );
      cleanup();
    }
  });

  it("the model hook throws the structured provider error", () => {
    function ModelProbe(): ReactNode {
      const api = useCadModel();
      return (
        <div data-testid="model-probe" data-apply={String(typeof api.apply)} />
      );
    }
    const view = render(
      <Boundary>
        <ModelProbe />
      </Boundary>,
    );
    const reported = view.container.querySelector(
      '[data-testid="boundary-error"]',
    );
    expect(reported?.getAttribute("data-code")).toBe(
      "cad-react/provider-missing",
    );
  });
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

describe("useCadDocument", () => {
  it("observes committed transactions", () => {
    const store = createTestStore();
    const view = render(
      <CadProvider store={store}>
        <DocumentProbe renders={{ count: 0 }} />
      </CadProvider>,
    );
    const featureCount = () =>
      view.container
        .querySelector('[data-testid="document-probe"]')
        ?.getAttribute("data-feature-count");
    expect(featureCount()).toBe("0");

    act(() => {
      store.applyCommand({
        type: "feature.create",
        id: createFeatureId("feat_plate"),
        kind: "plate",
        inputs: [],
        outputs: [TEST_BODY_ID],
      });
    });
    expect(featureCount()).toBe("1");
  });
});

describe("useCadParameters", () => {
  it("observes value commits", () => {
    const store = createTestStore();
    const renders = { count: 0 };
    const view = render(
      <CadProvider store={store}>
        <ParametersProbe renders={renders} />
      </CadProvider>,
    );
    const widthMm = () =>
      view.container
        .querySelector('[data-testid="parameters-probe"]')
        ?.getAttribute("data-width-mm");
    expect(widthMm()).toBe("10");

    act(() => {
      store.applyCommand({
        type: "parameter.set",
        id: TEST_WIDTH_PARAMETER,
        value: length(12),
      });
    });
    expect(widthMm()).toBe("12");
    expect(renders.count).toBe(2);
  });

  it("evaluates text expressions against the document and commits the canonical value", () => {
    const store = createTestStore();
    function ExpressionProbe(): ReactNode {
      const api = useCadParameters();
      return (
        <button
          type="button"
          onClick={() => {
            api.setValueFromExpression(TEST_WIDTH_PARAMETER, "width * 2");
          }}
        >
          double
        </button>
      );
    }
    const view = render(
      <CadProvider store={store}>
        <ParametersProbe renders={{ count: 0 }} />
        <ExpressionProbe />
      </CadProvider>,
    );
    fireEvent.click(view.getByText("double"));
    expect(
      view.container
        .querySelector('[data-testid="parameters-probe"]')
        ?.getAttribute("data-width-mm"),
    ).toBe("20");
    expect(store.commandLog).toHaveLength(1);
    expect(store.commandLog[0]).toEqual(
      serializeTransaction({
        commands: [
          {
            type: "parameter.set",
            id: TEST_WIDTH_PARAMETER,
            value: length(20),
          },
        ],
      }),
    );
  });

  it("rejects malformed expressions structurally and issues nothing", () => {
    const store = createTestStore();
    function FailureProbe(): ReactNode {
      const api = useCadParameters();
      const outcome = api.setValueFromExpression(
        TEST_WIDTH_PARAMETER,
        "width *",
      );
      return (
        <div
          data-testid="failure-probe"
          data-ok={String(outcome.ok)}
          data-code={outcome.ok ? "" : outcome.error.code}
        />
      );
    }
    const view = render(
      <CadProvider store={store}>
        <FailureProbe />
      </CadProvider>,
    );
    const reported = view.container.querySelector(
      '[data-testid="failure-probe"]',
    );
    expect(reported?.getAttribute("data-ok")).toBe("false");
    expect(reported?.getAttribute("data-code")).toBe(
      "expression/unexpected-end-of-input",
    );
    expect(store.commandLog).toHaveLength(0);
    expect(store.getDocument().parameters.parameters[0]?.value.value).toBe(10);
  });
});

describe("useCadSelection", () => {
  it("observes picks, additive toggles, and regeneration advances", () => {
    const store = createTestStore();
    const view = render(
      <CadProvider store={store}>
        <SelectionProbe renders={{ count: 0 }} />
      </CadProvider>,
    );
    const read = (attribute: string): string | null | undefined =>
      view.container
        .querySelector('[data-testid="selection-probe"]')
        ?.getAttribute(attribute);

    expect(read("data-selected")).toBe("0");
    act(() => {
      expect(store.pick({ kind: "body", bodyId: TEST_BODY_ID }, false).ok).toBe(
        true,
      );
    });
    expect(read("data-selected")).toBe("1");

    // Multi mode toggles off.
    act(() => {
      expect(store.pick({ kind: "body", bodyId: TEST_BODY_ID }, true).ok).toBe(
        true,
      );
    });
    expect(read("data-selected")).toBe("0");

    // Stable references survive a regeneration advance.
    act(() => {
      expect(store.beginSelectionRegeneration(3).ok).toBe(true);
    });
    expect(read("data-regeneration")).toBe("3");
  });
});

describe("useCadTools", () => {
  it("observes activation, gesture state, completion, and reset", () => {
    const store = createTestStore();
    const view = render(
      <CadProvider store={store}>
        <ToolsProbe renders={{ count: 0 }} />
      </CadProvider>,
    );
    const read = (attribute: string): string | null | undefined =>
      view.container
        .querySelector('[data-testid="tools-probe"]')
        ?.getAttribute(attribute);

    expect(read("data-phase")).toBe("inactive");

    act(() => {
      store.activateTool(MEASURE_TOOL_ID);
    });
    expect(read("data-phase")).toBe("active");
    expect(read("data-tool-id")).toBe("measure");
    expect(read("data-stage")).toBe("awaiting-first");

    act(() => {
      store.dispatchToolEvent({
        type: "pointer-up",
        point: [0, 0, 0],
        pick: {
          reference: { kind: "body", bodyId: TEST_BODY_ID },
          renderObjectId: "rend_plate",
        },
        modifiers: { shift: false, alt: false, ctrl: false, meta: false },
      });
    });
    expect(read("data-stage")).toBe("awaiting-second");

    act(() => {
      store.dispatchToolEvent({
        type: "pointer-up",
        point: [3, 4, 0],
        pick: {
          reference: { kind: "body", bodyId: TEST_BODY_ID },
          renderObjectId: "rend_plate",
        },
        modifiers: { shift: false, alt: false, ctrl: false, meta: false },
      });
    });
    expect(read("data-phase")).toBe("completed");
    const surface = store.getToolSurface();
    expect(surface.completion?.detail.kind).toBe("measurement");

    act(() => {
      store.resetTool();
    });
    expect(read("data-phase")).toBe("inactive");
  });

  it("surfaces the domain contract when activating an unregistered tool", () => {
    const store = createTestStore();
    expect(() => store.activateTool("nope")).toThrow(RangeError);
  });
});

describe("useCadHistory", () => {
  it("observes undo/redo availability and the moves revert and re-apply the document", () => {
    const store = createTestStore();
    const view = render(
      <CadProvider store={store}>
        <HistoryProbe renders={{ count: 0 }} />
      </CadProvider>,
    );
    const read = (attribute: string): string | null | undefined =>
      view.container
        .querySelector('[data-testid="history-probe"]')
        ?.getAttribute(attribute);

    expect(read("data-can-undo")).toBe("false");

    act(() => {
      expect(
        store.applyCommand({
          type: "parameter.set",
          id: TEST_WIDTH_PARAMETER,
          value: length(12),
        }).ok,
      ).toBe(true);
    });
    expect(read("data-can-undo")).toBe("true");
    expect(read("data-depth")).toBe("1");

    act(() => {
      expect(store.undo().ok).toBe(true);
    });
    expect(store.getDocument().parameters.parameters[0]?.value.value).toBe(10);
    expect(read("data-can-redo")).toBe("true");

    act(() => {
      expect(store.redo().ok).toBe(true);
    });
    expect(store.getDocument().parameters.parameters[0]?.value.value).toBe(12);

    const refused = store.redo();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("history/nothing-to-redo");
    }
  });
});

// ---------------------------------------------------------------------------
// Scoped re-renders
// ---------------------------------------------------------------------------

describe("scoped re-renders", () => {
  it("a selection change does not re-render document or parameter subscribers", () => {
    const store = createTestStore();
    const documentRenders = { count: 0 };
    const parametersRenders = { count: 0 };
    const selectionRenders = { count: 0 };
    const view = render(
      <CadProvider store={store}>
        <DocumentProbe renders={documentRenders} />
        <ParametersProbe renders={parametersRenders} />
        <SelectionProbe renders={selectionRenders} />
      </CadProvider>,
    );
    expect(documentRenders.count).toBe(1);
    expect(parametersRenders.count).toBe(1);
    expect(selectionRenders.count).toBe(1);

    act(() => {
      expect(store.pick({ kind: "body", bodyId: TEST_BODY_ID }, false).ok).toBe(
        true,
      );
    });
    expect(selectionRenders.count).toBe(2);
    expect(documentRenders.count).toBe(1);
    expect(parametersRenders.count).toBe(1);

    // A feature-only commit moves the document but NOT the parameters.
    act(() => {
      expect(
        store.applyCommand({
          type: "feature.create",
          id: createFeatureId("feat_plate"),
          kind: "plate",
          inputs: [],
          outputs: [TEST_BODY_ID],
        }).ok,
      ).toBe(true);
    });
    expect(documentRenders.count).toBe(2);
    expect(parametersRenders.count).toBe(1);
    expect(selectionRenders.count).toBe(2);

    // A parameter commit moves document AND parameters, still not selection.
    act(() => {
      expect(
        store.applyCommand({
          type: "parameter.set",
          id: TEST_WIDTH_PARAMETER,
          value: length(12),
        }).ok,
      ).toBe(true);
    });
    expect(documentRenders.count).toBe(3);
    expect(parametersRenders.count).toBe(2);
    expect(selectionRenders.count).toBe(2);
    expect(
      view.container
        .querySelector('[data-testid="parameters-probe"]')
        ?.getAttribute("data-width-mm"),
    ).toBe("12");
  });

  it("tool lifecycle changes do not re-render document subscribers", () => {
    const store = createTestStore();
    const documentRenders = { count: 0 };
    const toolsRenders = { count: 0 };
    render(
      <CadProvider store={store}>
        <DocumentProbe renders={documentRenders} />
        <ToolsProbe renders={toolsRenders} />
      </CadProvider>,
    );
    expect(documentRenders.count).toBe(1);
    expect(toolsRenders.count).toBe(1);

    act(() => {
      store.activateTool(SELECT_TOOL_ID);
    });
    expect(toolsRenders.count).toBe(2);
    expect(documentRenders.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No-mutation-path rule
// ---------------------------------------------------------------------------

describe("no-mutation-path rule", () => {
  it("exposes only frozen domain values; in-place mutation attempts throw", () => {
    const store = createTestStore();
    const document: CadDocument = store.getDocument();
    const selection: SelectionState = store.getSelection();
    const session: CadSession = store.getSession();
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(document.parameters)).toBe(true);

    // ESM runs in strict mode: writing to a frozen domain value throws.
    expect(() => {
      (document as { id: string }).id = "doc_forged";
    }).toThrow(TypeError);
    // The store still holds the untouched domain document.
    expect(store.getDocument().id).toBe(document.id);
  });

  it("the mutation surface accepts only command/operation data (pinned by types)", () => {
    const store = createTestStore();
    const document = store.getDocument();

    // A document is not a transaction: refused by the types and, when
    // smuggled past them, refused structurally by the domain interpreter.
    const smuggled = store.applyTransaction(
      // @ts-expect-error a document carries no command list.
      document,
    );
    expect(smuggled.ok).toBe(false);

    // A selection state is not a session: refused by the types AND by the
    // store's guarded whole-session door at runtime.
    expect(() =>
      store.replaceSession(
        // @ts-expect-error raw mirrored state is not a session.
        store.getSelection(),
      ),
    ).toThrow(RangeError);

    // Compile-time-only pin (never executed): a document is not a selection
    // reference either — the pick path accepts reference data only.
    expect(typeof pickTypePin).toBe("function");

    expect(store.getSession().history.cursor).toBe(0);
  });
});

/**
 * Compile-time-only pin for the pick path. Never called: its entire purpose
 * is that this file must keep typechecking with the call REJECTED — feeding
 * raw document state back as a selection reference must stay impossible by
 * types.
 */
function pickTypePin(store: CadStore, document: CadDocument): void {
  store.pick(
    // @ts-expect-error a document is not a selection reference.
    document,
    false,
  );
}

// ---------------------------------------------------------------------------
// Model API through the hook
// ---------------------------------------------------------------------------

describe("useCadModel", () => {
  it("commits a primitive as one atomic Phase 7 transaction", () => {
    const store = createTestStore();
    function ModelProbe(): ReactNode {
      const model = useCadModel();
      return (
        <button
          type="button"
          onClick={() =>
            model.createPrimitive({
              parameters: [{ id: TEST_WIDTH_PARAMETER, value: length(20) }],
              feature: {
                id: createFeatureId("feat_plate"),
                kind: "plate",
                inputs: [{ kind: "parameter", id: TEST_WIDTH_PARAMETER }],
                outputs: [createBodyId("body_plate")],
              },
            })
          }
        >
          author
        </button>
      );
    }
    const view = render(
      <CadProvider store={store}>
        <ModelProbe />
      </CadProvider>,
    );
    fireEvent.click(view.getByText("author"));

    // ONE history entry, TWO commands, parameters first, then the create.
    expect(store.getHistoryView().depth).toBe(1);
    expect(store.commandLog).toHaveLength(1);
    const entry = store.commandLog[0];
    expect(entry?.commands.map((command) => command.type)).toEqual([
      "parameter.set",
      "feature.create",
    ]);
    expect(store.getDocument().features).toHaveLength(1);
    expect(store.getDocument().parameters.parameters[0]?.value.value).toBe(20);
  });

  it("removeFeature and updatePrimitive issue the matching vocabulary", () => {
    const store = createTestStore();
    const featureId = createFeatureId("feat_plate");
    expect(
      store.applyTransaction({
        commands: [
          {
            type: "feature.create",
            id: featureId,
            kind: "plate",
            inputs: [],
            outputs: [TEST_BODY_ID],
          },
        ],
      }).ok,
    ).toBe(true);

    function ModelProbe(): ReactNode {
      const model = useCadModel();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              model.updatePrimitive({
                feature: {
                  id: featureId,
                  kind: "bracket",
                  inputs: [],
                  outputs: [TEST_BODY_ID],
                },
              })
            }
          >
            update
          </button>
          <button type="button" onClick={() => model.removeFeature(featureId)}>
            remove
          </button>
        </>
      );
    }
    const view = render(
      <CadProvider store={store}>
        <ModelProbe />
      </CadProvider>,
    );
    fireEvent.click(view.getByText("update"));
    expect(store.getDocument().features[0]?.kind).toBe("bracket");
    fireEvent.click(view.getByText("remove"));
    expect(store.getDocument().features).toHaveLength(0);
    expect(store.getHistoryView().depth).toBe(3);
  });
});
