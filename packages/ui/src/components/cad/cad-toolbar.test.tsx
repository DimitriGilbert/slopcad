/**
 * Component tests for `CadToolbar` (Phase 15.2). The toolbar composes the
 * existing Button primitive over the cad-react tools concern, so
 * these tests exercise exactly the component's own decisions: the button
 * list source, the live-tool pressing rule, the single activation path
 * shared by click and keyboard, the per-group prop precedence, the label
 * plumbing, and the documented inert behaviors without a provider.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  CadProvider,
  createCadStore,
  createDocument,
  createDocumentId,
  createSession,
  measureTool,
  MEASURE_TOOL_ID,
  registerTool,
  rotateTool,
  ROTATE_TOOL_ID,
  selectTool,
  SELECT_TOOL_ID,
  translateTool,
  TRANSLATE_TOOL_ID,
  type CadSession,
  type CadStore,
} from "@slopcad/cad-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CadToolbar,
  CAD_TOOLBAR_LABELS,
  type CadToolbarProps,
} from "./cad-toolbar";

/** A minimal deterministic session (document identity only). */
function sessionOf(): CadSession {
  return createSession(createDocument(createDocumentId("doc_toolbar_test")));
}

/** The default registry the toolbar's documented label defaults mirror. */
function fourToolStore(): CadStore {
  return createCadStore({
    session: sessionOf(),
    tools: [
      registerTool(selectTool),
      registerTool(measureTool),
      registerTool(translateTool),
      registerTool(rotateTool),
    ],
  });
}

function renderInProvider(store: CadStore, props: CadToolbarProps = {}): void {
  render(
    <CadProvider store={store}>
      <CadToolbar {...props} />
    </CadProvider>,
  );
}

/** The button for a tool id, addressed by its stable data attribute. */
function toolButton(toolId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-tool-id="${toolId}"]`,
  );
  expect(button, `the "${toolId}" tool button`).not.toBeNull();
  if (button === null) throw new Error("unreachable: button checked above");
  return button;
}

afterEach(cleanup);

describe("CadToolbar", () => {
  it("renders a button per registered provider tool with the default labels", () => {
    renderInProvider(fourToolStore());
    expect(
      screen.getByRole("group", { name: CAD_TOOLBAR_LABELS.toolbarLabel }),
    ).not.toBeNull();
    for (const toolId of [
      SELECT_TOOL_ID,
      MEASURE_TOOL_ID,
      TRANSLATE_TOOL_ID,
      ROTATE_TOOL_ID,
    ]) {
      expect(toolButton(toolId).textContent).toContain(
        CAD_TOOLBAR_LABELS.tools[toolId]?.label,
      );
    }
  });

  it("presses exactly the live provider tool with a distinct variant", () => {
    const store = fourToolStore();
    store.armTool(MEASURE_TOOL_ID);
    renderInProvider(store);
    const active = toolButton(MEASURE_TOOL_ID);
    expect(active.getAttribute("aria-pressed")).toBe("true");
    // The pressed variant rides the data-active attribute over the
    // strip's shared data-[active=true]:bg-accent class.
    expect(active.getAttribute("data-active")).toBe("true");
    const inactive = toolButton(SELECT_TOOL_ID);
    expect(inactive.getAttribute("aria-pressed")).toBe("false");
    expect(inactive.hasAttribute("data-active")).toBe(false);
  });

  it("un-presses every button once no tool is live", () => {
    const store = fourToolStore();
    store.armTool(MEASURE_TOOL_ID);
    renderInProvider(store);
    expect(toolButton(MEASURE_TOOL_ID).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // A cancellation ends the live activation: the strip reflects live
    // tools, not last-used ones. The mutation is a domain operation, so
    // the hook re-render flushes inside act.
    act(() => {
      store.cancelTool();
    });
    expect(toolButton(MEASURE_TOOL_ID).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("activates through the store arm on click, from any phase", () => {
    const store = fourToolStore();
    store.armTool(SELECT_TOOL_ID);
    renderInProvider(store);
    fireEvent.click(toolButton(ROTATE_TOOL_ID));
    expect(store.getToolSurface().activeToolId).toBe(ROTATE_TOOL_ID);
    expect(store.getToolSurface().phase).toBe("active");
  });

  it("activates through the same store arm on a digit key inside the toolbar", () => {
    const store = fourToolStore();
    store.armTool(SELECT_TOOL_ID);
    renderInProvider(store);
    const group = screen.getByRole("group", {
      name: CAD_TOOLBAR_LABELS.toolbarLabel,
    });
    // "3" is the third registry entry — translate — pressed while focus
    // sits on a DIFFERENT button: the key handler lives on the container.
    fireEvent.keyDown(toolButton(SELECT_TOOL_ID), { key: "3" });
    expect(store.getToolSurface().activeToolId).toBe(TRANSLATE_TOOL_ID);
    expect(store.getToolSurface().phase).toBe("active");
    expect(group).not.toBeNull();
  });

  it("serves click and keyboard through one activation path (prop-driven)", () => {
    const onActivate = vi.fn<(toolId: string) => void>();
    render(
      <CadToolbar
        onActivate={onActivate}
        toolIds={[SELECT_TOOL_ID, MEASURE_TOOL_ID]}
      />,
    );
    fireEvent.click(toolButton(MEASURE_TOOL_ID));
    fireEvent.keyDown(
      screen.getByRole("group", { name: CAD_TOOLBAR_LABELS.toolbarLabel }),
      { key: "2" },
    );
    // Identical calls, in order: the digit key and the click on the same
    // tool are indistinguishable at the activation surface.
    expect(onActivate.mock.calls).toEqual([
      [MEASURE_TOOL_ID],
      [MEASURE_TOOL_ID],
    ]);
  });

  it("ignores modified digit presses and digits beyond the registry", () => {
    const onActivate = vi.fn<(toolId: string) => void>();
    render(
      <CadToolbar
        onActivate={onActivate}
        toolIds={[SELECT_TOOL_ID, MEASURE_TOOL_ID]}
      />,
    );
    const group = screen.getByRole("group", {
      name: CAD_TOOLBAR_LABELS.toolbarLabel,
    });
    fireEvent.keyDown(group, { key: "9" });
    fireEvent.keyDown(group, { key: "2", ctrlKey: true });
    fireEvent.keyDown(group, { key: "2", metaKey: true });
    fireEvent.keyDown(group, { key: "2", altKey: true });
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("renders label overrides in place of the defaults, falling back to raw ids", () => {
    renderInProvider(fourToolStore(), {
      labels: {
        toolbarLabel: "Werkzeuge",
        tools: { measure: { label: "Messen", tooltip: "Distanz messen" } },
      },
    });
    expect(screen.getByRole("group", { name: "Werkzeuge" })).not.toBeNull();
    expect(toolButton(MEASURE_TOOL_ID).textContent).toContain("Messen");
    // The override replaced the whole per-tool map: unlisted tools fall
    // back to their raw id (the documented extension point).
    expect(toolButton(SELECT_TOOL_ID).textContent).toContain("select");
  });

  it("renders a labeled, buttonless group without a provider and without props", () => {
    render(<CadToolbar />);
    expect(
      screen.getByRole("group", { name: CAD_TOOLBAR_LABELS.toolbarLabel }),
    ).not.toBeNull();
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders disabled, inert buttons with tool ids but no activation surface", () => {
    render(<CadToolbar toolIds={[SELECT_TOOL_ID, MEASURE_TOOL_ID]} />);
    for (const toolId of [SELECT_TOOL_ID, MEASURE_TOOL_ID]) {
      const button = toolButton(toolId);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
    // Activation is refused structurally: no handler is attached at all.
    expect(() => {
      fireEvent.click(toolButton(MEASURE_TOOL_ID));
    }).not.toThrow();
  });

  it("lets toolIds and activeToolId props override the mirrored provider state", () => {
    const store = fourToolStore();
    store.armTool(SELECT_TOOL_ID);
    renderInProvider(store, {
      toolIds: [MEASURE_TOOL_ID],
      activeToolId: MEASURE_TOOL_ID,
    });
    // The registry list was replaced…
    expect(document.querySelectorAll("[data-tool-id]")).toHaveLength(1);
    // …and the mirrored active id (select) lost to the explicit prop.
    expect(toolButton(MEASURE_TOOL_ID).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("lets onActivate override the store arm while the provider state still mirrors", () => {
    const store = fourToolStore();
    store.armTool(SELECT_TOOL_ID);
    const onActivate = vi.fn<(toolId: string) => void>();
    renderInProvider(store, { onActivate });
    fireEvent.click(toolButton(MEASURE_TOOL_ID));
    expect(onActivate).toHaveBeenCalledWith(MEASURE_TOOL_ID);
    // The store surface never moved: the prop took over activation only.
    expect(store.getToolSurface().activeToolId).toBe(SELECT_TOOL_ID);
  });
});
