/**
 * Component tests for `CadModelTree` (Phase 15.3). The tree derives its
 * rows from real document state and synchronizes with the real selection
 * concern, so the tests build documents and regeneration states through
 * the domain (`createDocument`/`addBody`/`addFeature`, `regenerate` with
 * an executor that fails a feature with diagnostics) and exercise exactly
 * the component's own decisions: the derivation rule (first producer owns
 * the row, unclaimed bodies at the root, leaf features never collapsible),
 * the two-way selection sync (including the owning-body rule for synthetic
 * face references), the status surfacing per state (with failure
 * diagnostics linked by `aria-describedby`), the collapse/expand UI state,
 * the per-group prop precedence, the keyboard tree pattern, the label
 * plumbing, and the documented providerless behaviors.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  addBody,
  addFeature,
  CadProvider,
  createBodyId,
  createCadStore,
  createDocument,
  createDocumentId,
  createFeatureId,
  createSession,
  DIAGNOSTIC_CODES,
  initialRegenerationStates,
  regenerate,
  type CadDocument,
  type CadStore,
  type Diagnostic,
  type FeatureId,
  type RegenerationStateMap,
  type SelectionReference,
} from "@slopcad/cad-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAD_MODEL_TREE_LABELS,
  CadModelTree,
  type CadModelTreeProps,
} from "./cad-model-tree";

// ---------------------------------------------------------------------------
// Domain fixtures: a real document, real regeneration states
// ---------------------------------------------------------------------------

const BLANK_BODY = createBodyId("body_blank");
const PLATE_BODY = createBodyId("body_plate");
const SPARE_BODY = createBodyId("body_spare");
const PAD_FEATURE = createFeatureId("feat_pad");
const HOLE_FEATURE = createFeatureId("feat_hole");

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

/**
 * The test document: `blank` (a body no feature outputs — a root row),
 * `plate` (produced by the pad feature), and `spare` (another root row);
 * the hole feature consumes the pad feature and has no outputs (a leaf).
 */
function buildTreeDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_tree_test"));
  document = requireOk(
    addBody(document, { id: BLANK_BODY, name: "blank" }),
    "the blank body",
  ).document;
  document = requireOk(
    addBody(document, { id: PLATE_BODY, name: "plate" }),
    "the plate body",
  ).document;
  document = requireOk(
    addBody(document, { id: SPARE_BODY, name: "spare" }),
    "the spare body",
  ).document;
  document = requireOk(
    addFeature(document, {
      id: PAD_FEATURE,
      kind: "pad",
      inputs: [{ kind: "body", id: BLANK_BODY }],
      outputs: [PLATE_BODY],
    }),
    "the pad feature",
  ).document;
  document = requireOk(
    addFeature(document, {
      id: HOLE_FEATURE,
      kind: "hole",
      inputs: [{ kind: "feature", id: PAD_FEATURE }],
      outputs: [],
    }),
    "the hole feature",
  ).document;
  return document;
}

const HOLE_FAILURE_DIAGNOSTIC: Diagnostic = {
  severity: "error",
  code: DIAGNOSTIC_CODES.kernelOperationFailed,
  message: "Hole failed: the diameter 0 mm is below the minimum 0.1 mm.",
  location: { primary: HOLE_FEATURE },
};

function executorFor(failing: "none" | "hole"): (feature: {
  readonly kind: string;
}) =>
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
    } {
  return (feature) => {
    if (failing === "hole" && feature.kind === "hole") {
      return { ok: false, diagnostics: [HOLE_FAILURE_DIAGNOSTIC] };
    }
    return { ok: true };
  };
}

function statesAfterRun(
  document: CadDocument,
  options: {
    readonly failing?: "none" | "hole";
    readonly stale?: boolean;
    readonly suppressed?: readonly FeatureId[];
  } = {},
): RegenerationStateMap {
  const initial = initialRegenerationStates(document.features);
  if (options.stale === true) return initial;
  const run = regenerate({
    features: document.features,
    states: initial,
    suppressed: options.suppressed ?? [],
    execute: executorFor(options.failing ?? "none"),
  });
  return requireOk(run, "the regeneration run").states;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderInProvider(
  store: CadStore,
  props: CadModelTreeProps = {},
): void {
  render(
    <CadProvider store={store}>
      <CadModelTree {...props} />
    </CadProvider>,
  );
}

/**
 * The row element for a reference key (e.g. `body|body_plate`), addressed
 * by the component's stable data attribute.
 */
function row(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-node-key="${key}"]`,
  );
  expect(element, `the "${key}" row`).not.toBeNull();
  if (element === null) throw new Error("unreachable: row checked above");
  return element;
}

/** The expansion twisty of a feature row (asserted present before use). */
function toggleOf(key: string): HTMLElement {
  const element = row(key).querySelector<HTMLElement>("[data-cad-tree-toggle]");
  expect(element, `the "${key}" toggle`).not.toBeNull();
  if (element === null) throw new Error("unreachable: toggle checked above");
  return element;
}

afterEach(cleanup);

describe("CadModelTree", () => {
  it("renders the derived hierarchy from a real document", () => {
    renderInProvider(
      createCadStore({ session: createSession(buildTreeDocument()) }),
    );
    expect(
      screen.getByRole("tree", { name: CAD_MODEL_TREE_LABELS.treeLabel }),
    ).not.toBeNull();

    // Features in insertion order with their output bodies nested inside
    // the feature's treeitem (the ARIA ownership structure).
    const pad = row("feature|feat_pad");
    expect(pad.getAttribute("aria-level")).toBe("1");
    expect(pad.textContent).toContain("pad");
    expect(
      pad.querySelector('[data-node-key="body|body_plate"]'),
    ).not.toBeNull();
    const plate = row("body|body_plate");
    expect(plate.getAttribute("aria-level")).toBe("2");
    expect(plate.textContent).toContain("plate");

    // Bodies no feature outputs render as root rows AFTER the features.
    const spare = row("body|body_spare");
    expect(spare.getAttribute("aria-level")).toBe("1");
    expect(spare.parentElement?.getAttribute("role")).toBe("tree");
  });

  it("groups a multiply-claimed body under the first producer only and never collapses a leaf feature", () => {
    let cadDocument = createDocument(createDocumentId("doc_tree_tie"));
    cadDocument = requireOk(
      addBody(cadDocument, { id: PLATE_BODY, name: "plate" }),
      "the plate body",
    ).document;
    cadDocument = requireOk(
      addFeature(cadDocument, {
        id: PAD_FEATURE,
        kind: "pad",
        inputs: [],
        outputs: [PLATE_BODY],
      }),
      "the first feature",
    ).document;
    cadDocument = requireOk(
      addFeature(cadDocument, {
        id: HOLE_FEATURE,
        kind: "hole",
        inputs: [{ kind: "feature", id: PAD_FEATURE }],
        outputs: [PLATE_BODY],
      }),
      "the second feature",
    ).document;
    render(<CadModelTree document={cadDocument} />);

    // First producer (document order) owns the single body row…
    expect(
      row("feature|feat_pad").querySelector(
        '[data-node-key="body|body_plate"]',
      ),
    ).not.toBeNull();
    // …the later claimer does not duplicate it…
    expect(
      document.querySelectorAll('[data-node-key="body|body_plate"]'),
    ).toHaveLength(1);
    // …and a feature without outputs is a leaf: no twisty, no aria-expanded.
    const hole = row("feature|feat_hole");
    expect(hole.getAttribute("aria-expanded")).toBeNull();
    expect(hole.querySelector("[data-cad-tree-toggle]")).toBeNull();
  });

  it("displays each regeneration state with its status label", () => {
    const document = buildTreeDocument();
    const validView = render(
      <CadModelTree
        document={document}
        regenerationStates={statesAfterRun(document)}
      />,
    );
    expect(row("feature|feat_pad").getAttribute("data-status")).toBe("valid");
    expect(row("feature|feat_pad").textContent).toContain(
      CAD_MODEL_TREE_LABELS.statusValid,
    );
    validView.unmount();

    const staleView = render(
      <CadModelTree
        document={document}
        regenerationStates={statesAfterRun(document, { stale: true })}
      />,
    );
    expect(row("feature|feat_pad").getAttribute("data-status")).toBe("stale");
    expect(row("feature|feat_pad").textContent).toContain(
      CAD_MODEL_TREE_LABELS.statusStale,
    );
    staleView.unmount();

    const suppressedView = render(
      <CadModelTree
        document={document}
        regenerationStates={statesAfterRun(document, {
          suppressed: [HOLE_FEATURE],
        })}
      />,
    );
    expect(row("feature|feat_hole").getAttribute("data-status")).toBe(
      "suppressed",
    );
    expect(row("feature|feat_hole").textContent).toContain(
      CAD_MODEL_TREE_LABELS.statusSuppressed,
    );
    suppressedView.unmount();
  });

  it("surfaces a failed feature's diagnostics accessibly", () => {
    const cadDocument = buildTreeDocument();
    render(
      <CadModelTree
        document={cadDocument}
        regenerationStates={statesAfterRun(cadDocument, { failing: "hole" })}
      />,
    );

    const hole = row("feature|feat_hole");
    expect(hole.getAttribute("data-status")).toBe("failed");
    expect(hole.textContent).toContain(CAD_MODEL_TREE_LABELS.statusFailed);

    // The diagnostic message is domain data, visibly rendered and linked
    // from the row (aria-describedby), plus a title carrying every message.
    const describedBy = hole.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const message = document.getElementById(describedBy ?? "");
    expect(message?.textContent).toContain(HOLE_FAILURE_DIAGNOSTIC.message);
    const chip = hole.querySelector<HTMLElement>("[data-cad-tree-status]");
    expect(chip?.getAttribute("title")).toContain(
      HOLE_FAILURE_DIAGNOSTIC.message,
    );

    // The upstream feature kept the state it earned: failure isolation.
    expect(row("feature|feat_pad").getAttribute("data-status")).toBe("valid");
    // Bodies have no regeneration state — no status anywhere.
    expect(row("body|body_plate").getAttribute("data-status")).toBeNull();
  });

  it("shows no status without a regeneration state map", () => {
    render(<CadModelTree document={buildTreeDocument()} />);
    expect(document.querySelector("[data-cad-tree-status]")).toBeNull();
    expect(document.querySelectorAll("[data-status]")).toHaveLength(0);
  });

  it("picks the row's stable reference through the store on click, shift for additive", () => {
    const store = createCadStore({
      session: createSession(buildTreeDocument()),
    });
    renderInProvider(store);

    // A plain click picks the body reference in single mode (replaces).
    fireEvent.click(row("body|body_plate"));
    expect(store.getSelection().selected).toEqual([
      { kind: "body", bodyId: PLATE_BODY },
    ]);

    // Another plain click replaces the selection with the feature reference.
    fireEvent.click(row("feature|feat_pad"));
    expect(store.getSelection().selected).toEqual([
      { kind: "feature", featureId: PAD_FEATURE },
    ]);

    // Shift-click toggles additively (multi mode), insertion order kept.
    fireEvent.click(row("body|body_spare"), { shiftKey: true });
    expect(store.getSelection().selected).toEqual([
      { kind: "feature", featureId: PAD_FEATURE },
      { kind: "body", bodyId: SPARE_BODY },
    ]);
  });

  it("highlights rows from externally applied selection, faces light the owning body", () => {
    const store = createCadStore({
      session: createSession(buildTreeDocument()),
    });
    renderInProvider(store);

    // A synthetic face reference arrives from the viewport: the OWNING
    // body row highlights, no feature row does.
    act(() => {
      store.pick(
        { kind: "face", bodyId: PLATE_BODY, regeneration: 0, faceIndex: 1 },
        false,
      );
    });
    expect(row("body|body_plate").getAttribute("data-selected")).toBe("true");
    expect(row("feature|feat_pad").getAttribute("data-selected")).toBe("false");
    expect(row("feature|feat_hole").getAttribute("data-selected")).toBe(
      "false",
    );

    // A feature reference highlights exactly its own row.
    act(() => {
      store.pick({ kind: "feature", featureId: PAD_FEATURE }, false);
    });
    expect(row("feature|feat_pad").getAttribute("data-selected")).toBe("true");
    expect(row("body|body_plate").getAttribute("data-selected")).toBe("false");
  });

  it("lets the selection and onPick props override the mirrored provider state per group", () => {
    const store = createCadStore({
      session: createSession(buildTreeDocument()),
    });
    const onPick =
      vi.fn<(reference: SelectionReference, additive: boolean) => void>();
    renderInProvider(store, {
      selection: [{ kind: "body", bodyId: SPARE_BODY }],
      onPick,
    });
    // The explicit selection prop won over the (empty) mirrored state…
    expect(row("body|body_spare").getAttribute("data-selected")).toBe("true");
    // …and the explicit pick surface won over the store's.
    fireEvent.click(row("body|body_plate"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(
      { kind: "body", bodyId: PLATE_BODY },
      false,
    );
    expect(store.getSelection().selected).toHaveLength(0);
  });

  it("renders inert rows with a document but no pick surface", () => {
    render(<CadModelTree document={buildTreeDocument()} />);
    for (const key of [
      "feature|feat_pad",
      "body|body_plate",
      "body|body_spare",
    ]) {
      expect(row(key).getAttribute("aria-disabled")).toBe("true");
    }
    // Activation is refused structurally: clicking changes nothing.
    expect(() => {
      fireEvent.click(row("body|body_plate"));
    }).not.toThrow();
  });

  it("renders the titled empty state without a document or rows", () => {
    render(<CadModelTree />);
    expect(
      screen.getByText(CAD_MODEL_TREE_LABELS.emptyDocument),
    ).not.toBeNull();
    expect(document.querySelector("[role='tree']")).toBeNull();
    expect(document.querySelectorAll("[data-cad-tree-node]")).toHaveLength(0);
  });

  it("renders the empty-document text for a real but empty document", () => {
    render(
      <CadModelTree
        document={createDocument(createDocumentId("doc_tree_empty"))}
      />,
    );
    expect(
      screen.getByText(CAD_MODEL_TREE_LABELS.emptyDocument),
    ).not.toBeNull();
  });

  it("collapses and expands groups as component-local UI state", () => {
    const view = render(<CadModelTree document={buildTreeDocument()} />);
    const pad = row("feature|feat_pad");
    expect(pad.getAttribute("aria-expanded")).toBe("true");
    expect(row("body|body_plate")).not.toBeNull();

    fireEvent.click(toggleOf("feature|feat_pad"));
    expect(pad.getAttribute("aria-expanded")).toBe("false");
    expect(
      document.querySelector('[data-node-key="body|body_plate"]'),
    ).toBeNull();

    // The collapsed set is UI state: a NEW document identity (same shape)
    // does not reset it within the mount.
    view.rerender(<CadModelTree document={buildTreeDocument()} />);
    expect(pad.getAttribute("aria-expanded")).toBe("false");
    expect(
      document.querySelector('[data-node-key="body|body_plate"]'),
    ).toBeNull();

    fireEvent.click(toggleOf("feature|feat_pad"));
    expect(pad.getAttribute("aria-expanded")).toBe("true");
    expect(row("body|body_plate")).not.toBeNull();
  });

  it("drives the tree pattern from the keyboard: arrows, Home/End, Enter/Space", () => {
    const onPick =
      vi.fn<(reference: SelectionReference, additive: boolean) => void>();
    render(<CadModelTree document={buildTreeDocument()} onPick={onPick} />);
    const pad = row("feature|feat_pad");
    pad.focus();
    expect(document.activeElement).toBe(pad);

    // ArrowDown moves focus to the (visible) child body row.
    fireEvent.keyDown(pad, { key: "ArrowDown" });
    const plate = row("body|body_plate");
    expect(document.activeElement).toBe(plate);

    // ArrowLeft from the child moves focus to the parent row.
    fireEvent.keyDown(plate, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(pad);

    // ArrowLeft on the expanded group collapses it; ArrowRight expands it.
    fireEvent.keyDown(pad, { key: "ArrowLeft" });
    expect(pad.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(pad, { key: "ArrowRight" });
    expect(pad.getAttribute("aria-expanded")).toBe("true");

    // Home/End jump to the first/last visible row.
    fireEvent.keyDown(pad, { key: "End" });
    expect(document.activeElement).toBe(row("body|body_spare"));
    fireEvent.keyDown(row("body|body_spare"), { key: "Home" });
    expect(document.activeElement).toBe(pad);

    // Enter activates with the row's reference; Shift enters multi mode;
    // Space activates too. All through the one pick surface.
    fireEvent.keyDown(pad, { key: "Enter" });
    fireEvent.keyDown(pad, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(pad, { key: " " });
    expect(onPick).toHaveBeenCalledTimes(3);
    expect(onPick.mock.calls.map((call) => call[1])).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("renders label overrides, falling back to raw feature kinds", () => {
    const document = buildTreeDocument();
    render(
      <CadModelTree
        document={document}
        regenerationStates={statesAfterRun(document)}
        labels={{
          treeLabel: "Struktur",
          statusValid: "OK",
          featureKinds: { pad: "Grundkörper" },
        }}
      />,
    );
    expect(screen.getByRole("tree", { name: "Struktur" })).not.toBeNull();
    expect(row("feature|feat_pad").textContent).toContain("Grundkörper");
    expect(row("feature|feat_pad").textContent).toContain("OK");
    // The override replaced the whole feature-kind map: unlisted kinds fall
    // back to their raw kind (the documented extension point).
    expect(row("feature|feat_hole").textContent).toContain("hole");
  });
});

describe("CadModelTree body management affordances (Phase 44)", () => {
  it("renders no affordances without the display and action props", () => {
    renderInProvider(
      createCadStore({ session: createSession(buildTreeDocument()) }),
    );
    expect(document.querySelector("[data-cad-tree-body-actions]")).toBeNull();
  });

  it("renders the eye, crosshair, and pencil on body rows only, carrying the flags", () => {
    renderInProvider(
      createCadStore({ session: createSession(buildTreeDocument()) }),
      {
        bodyDisplay: (bodyId) =>
          bodyId === PLATE_BODY
            ? { visible: false, isolated: true }
            : { visible: true, isolated: false },
        onBodyAction: () => {},
      },
    );
    const plateRow = row("body|body_plate");
    const spareRow = row("body|body_spare");
    const featureRow = row("feature|feat_pad");
    for (const scope of [plateRow, spareRow]) {
      expect(
        scope.querySelector("[data-cad-tree-body-actions]"),
      ).not.toBeNull();
    }
    // Exactly the THREE body rows carry affordances (the plate, the spare,
    // and the unproduced blank); the feature row's own content line — its
    // first child, before the nested group — carries none.
    expect(
      document.querySelectorAll("[data-cad-tree-body-actions]").length,
    ).toBe(3);
    expect(
      featureRow.firstElementChild?.querySelector(
        "[data-cad-tree-body-actions]",
      ),
    ).toBeNull();
    expect(
      plateRow.querySelector('[data-cad-tree-body-visibility="hidden"]'),
    ).not.toBeNull();
    expect(
      plateRow.querySelector('[data-cad-tree-body-isolate="isolated"]'),
    ).not.toBeNull();
    expect(
      spareRow.querySelector('[data-cad-tree-body-visibility="visible"]'),
    ).not.toBeNull();
    expect(
      spareRow.querySelector('[data-cad-tree-body-isolate="normal"]'),
    ).not.toBeNull();
  });

  it("emits the visibility, isolation, and rename actions from the affordances", () => {
    const actions: string[] = [];
    renderInProvider(
      createCadStore({ session: createSession(buildTreeDocument()) }),
      {
        bodyDisplay: () => ({ visible: true, isolated: false }),
        onBodyAction: (action) => {
          actions.push(action.type);
        },
      },
    );
    const spareRow = row("body|body_spare");
    fireClick(
      spareRow.querySelector<HTMLElement>(
        '[data-cad-tree-body-visibility="visible"]',
      ),
    );
    fireClick(
      spareRow.querySelector<HTMLElement>(
        '[data-cad-tree-body-isolate="normal"]',
      ),
    );
    fireClick(
      spareRow.querySelector<HTMLElement>("[data-cad-tree-body-rename]"),
    );
    expect(actions).toEqual(["toggle-visibility", "toggle-isolate", "rename"]);
  });
});

/** Fires a click on an asserted-present element. */
function fireClick(element: HTMLElement | null): void {
  expect(element).not.toBeNull();
  if (element === null) return;
  element.click();
}

describe("CadModelTree assembly section (Phase 50)", () => {
  it("renders host-derived occurrence rows with source, BOM, and stale chips", () => {
    let cadDocument = createDocument(createDocumentId("doc_tree_asm"));
    cadDocument = requireOk(
      addBody(cadDocument, { id: PLATE_BODY, name: "plate" }),
      "the plate body",
    ).document;
    cleanup();
    render(
      <CadModelTree
        document={cadDocument}
        assembly={{
          nodes: [
            {
              key: "occ_000001",
              label: "Bolt pattern",
              source: "body",
              sourceName: "plate",
              children: [
                {
                  key: "occ_000001/occ_000002",
                  label: "Motor",
                  source: "component",
                  sourceName: "nema17-mount",
                  bomFlag: "purchased",
                  stale: true,
                },
              ],
            },
            {
              key: "occ_000003",
              label: "Kit",
              source: "document",
              sourceName: "bracket",
              bomFlag: "phantom",
            },
          ],
        }}
      />,
    );
    const bolt = row("occ_000001");
    expect(bolt.getAttribute("aria-level")).toBe("1");
    expect(bolt.getAttribute("data-cad-tree-occurrence")).toBe("body");
    // Inert: no selection surface exists for occurrences (Phase 51).
    expect(bolt.getAttribute("aria-selected")).toBe("false");
    // The nested sub-assembly occurrence renders one level deeper with its
    // BOM and staleness chips.
    const motor = row("occ_000001/occ_000002");
    expect(motor.getAttribute("aria-level")).toBe("2");
    expect(motor.getAttribute("data-cad-tree-occurrence")).toBe("component");
    expect(
      motor.querySelector('[data-cad-tree-bom="purchased"]'),
    ).not.toBeNull();
    expect(motor.querySelector('[data-cad-tree-stale="true"]')).not.toBeNull();
    const kit = row("occ_000003");
    expect(kit.querySelector('[data-cad-tree-bom="phantom"]')).not.toBeNull();
    expect(kit.querySelector('[data-cad-tree-stale="true"]')).toBeNull();
  });

  it("collapses and expands a sub-assembly occurrence through its twisty", () => {
    let cadDocument = createDocument(createDocumentId("doc_tree_asm2"));
    cadDocument = requireOk(
      addBody(cadDocument, { id: PLATE_BODY, name: "plate" }),
      "the plate body",
    ).document;
    cleanup();
    render(
      <CadModelTree
        document={cadDocument}
        assembly={{
          nodes: [
            {
              key: "occ_000001",
              label: "Kit",
              source: "document",
              sourceName: "kit",
              children: [
                {
                  key: "occ_000001/occ_000002",
                  label: "Washer",
                  source: "body",
                  sourceName: "plate",
                },
              ],
            },
          ],
        }}
      />,
    );
    const kit = row("occ_000001");
    expect(
      kit.querySelector('[data-node-key="occ_000001/occ_000002"]'),
    ).not.toBeNull();
    const toggle = kit.querySelector("[data-cad-tree-toggle]");
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      kit.querySelector('[data-node-key="occ_000001/occ_000002"]'),
    ).toBeNull();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      kit.querySelector('[data-node-key="occ_000001/occ_000002"]'),
    ).not.toBeNull();
  });

  it("renders no assembly rows when the prop is absent", () => {
    let cadDocument = createDocument(createDocumentId("doc_tree_asm3"));
    cadDocument = requireOk(
      addBody(cadDocument, { id: PLATE_BODY, name: "plate" }),
      "the plate body",
    ).document;
    cleanup();
    render(<CadModelTree document={cadDocument} />);
    expect(
      document.querySelectorAll("[data-cad-tree-occurrence]"),
    ).toHaveLength(0);
  });
});
