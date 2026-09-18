/**
 * Component tests for `CadStatusBar` (Phase 28). The bar mirrors the
 * store's live concerns and renders host-owned session spans, so the tests
 * exercise exactly the component's own decisions: the mirrored
 * tool/selection/command readouts, the per-group prop precedence, the
 * labeled host surface spans (the ids a session writer owns), and the
 * documented providerless degradation to the host spans alone.
 */

import { act, cleanup, render } from "@testing-library/react";
import {
  addDocumentParameter,
  CadProvider,
  createCadStore,
  createDocument,
  createDocumentId,
  createParameterId,
  createSession,
  length,
  SELECT_TOOL_ID,
  selectTool,
  registerTool,
  setParameterCommand,
  type CadStore,
} from "@slopcad/cad-react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CAD_STATUS_BAR_LABELS,
  CadStatusBar,
  type CadStatusBarProps,
} from "./cad-status-bar";

const DEPTH_PARAMETER = createParameterId("param_depth");

/** A document with one parameter, so a `parameter.set` commit succeeds. */
function documentOf() {
  let document = createDocument(createDocumentId("doc_status_bar_test"));
  document = requireOk(
    addDocumentParameter(document, {
      id: DEPTH_PARAMETER,
      name: "depth",
      value: length(10),
    }),
    "the depth parameter",
  ).document;
  return document;
}

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`Test document rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

function storeOf(): CadStore {
  return createCadStore({
    session: createSession(documentOf()),
    tools: [registerTool(selectTool)],
  });
}

function renderInProvider(
  store: CadStore,
  props: CadStatusBarProps = {},
): void {
  render(
    <CadProvider store={store}>
      <CadStatusBar {...props} />
    </CadProvider>,
  );
}

/** The bar's whole text content (fields break across text nodes). */
function barText(): string {
  const bar = document.querySelector('[data-slot="cad-status-bar"]');
  expect(bar, "the status bar").not.toBeNull();
  return bar?.textContent ?? "";
}

afterEach(cleanup);

describe("CadStatusBar", () => {
  it("mirrors the live tool, the selection count, and the command count", () => {
    const store = storeOf();
    act(() => {
      store.armTool(SELECT_TOOL_ID);
      store.applyCommand(setParameterCommand(DEPTH_PARAMETER, length(1)));
    });
    renderInProvider(store);
    const text = barText();
    expect(text).toContain(`tool = ${SELECT_TOOL_ID} (active)`);
    expect(text).toContain("selection = 0");
    expect(text).toContain("commands = 1");
  });

  it("renders the labeled host surface spans with their ids intact", () => {
    renderInProvider(storeOf(), {
      surfaceIds: {
        statusId: "sb-status",
        volumeId: "sb-volume",
        errorId: "sb-error",
      },
    });
    const text = barText();
    // The labels render; the spans exist for the session writer to own.
    expect(text).toContain(`${CAD_STATUS_BAR_LABELS.status} =`);
    expect(document.getElementById("sb-status")).not.toBeNull();
    expect(document.getElementById("sb-volume")).not.toBeNull();
    expect(document.getElementById("sb-error")).not.toBeNull();
    // The canonical unit rides the volume label.
    expect(text).toContain(CAD_STATUS_BAR_LABELS.volumeUnit);
  });

  it("lets explicit props override every mirrored value", () => {
    renderInProvider(storeOf(), {
      toolId: "measure",
      toolPhase: "completed",
      selectionCount: 2,
      commandCount: 7,
    });
    const text = barText();
    expect(text).toContain("tool = measure (completed)");
    expect(text).toContain("selection = 2");
    expect(text).toContain("commands = 7");
  });

  it("degrades to the host spans alone without a provider and without props", () => {
    render(<CadStatusBar />);
    const text = barText();
    expect(text).toBe("");
  });

  it("renders label overrides in place of the defaults", () => {
    renderInProvider(storeOf(), {
      labels: { tool: "Werkzeug", commands: "Befehle" },
    });
    const text = barText();
    expect(text).toContain("Werkzeug =");
    expect(text).toContain("Befehle =");
  });
});
