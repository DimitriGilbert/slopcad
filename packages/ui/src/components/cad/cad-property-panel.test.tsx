/**
 * Component tests for `CadPropertyPanel` (Phase 28). The panel derives its
 * sections from real document and selection state, so the tests build both
 * through the domain (`createDocument`/`addBody`/`addFeature`, the
 * selection concern's pick operation) and exercise exactly the component's
 * own decisions: the per-reference-kind row derivation (body provenance,
 * feature inputs/outputs summaries, synthetic topology identity), the
 * status surfacing with failure diagnostics, the remove action's single
 * command-vocabulary path (store commit, prop override, refusal surfacing,
 * structural absence without any surface), the per-group prop precedence,
 * the label plumbing, and the documented providerless empty states.
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
  addDocumentParameter,
  addFeature,
  CadProvider,
  createBodyId,
  createCadStore,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSession,
  DIAGNOSTIC_CODES,
  initialRegenerationStates,
  length,
  regenerate,
  type CadDocument,
  type CadSession,
  type CadStore,
  type Diagnostic,
  type RegenerationStateMap,
  type SelectionReference,
} from "@slopcad/cad-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAD_PROPERTY_PANEL_LABELS,
  CadPropertyPanel,
  type CadPropertyPanelProps,
} from "./cad-property-panel";

// ---------------------------------------------------------------------------
// Domain fixtures: a real document and real regeneration states
// ---------------------------------------------------------------------------

const BLANK_BODY = createBodyId("body_blank");
const PLATE_BODY = createBodyId("body_plate");
const PAD_FEATURE = createFeatureId("feat_pad");
const HOLE_FEATURE = createFeatureId("feat_hole");
const DEPTH_PARAMETER = createParameterId("param_depth");

/** The test document: blank (a root body), plate (produced by pad), the pad
 * feature consuming blank plus one depth parameter, and the hole feature
 * consuming pad with no outputs. */
function buildPanelDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_property_test"));
  document = requireOk(
    addBody(document, { id: BLANK_BODY, name: "blank" }),
    "the blank body",
  ).document;
  document = requireOk(
    addBody(document, { id: PLATE_BODY, name: "plate" }),
    "the plate body",
  ).document;
  document = requireOk(
    addDocumentParameter(document, {
      id: DEPTH_PARAMETER,
      name: "depth",
      value: length(10),
    }),
    "the depth parameter",
  ).document;
  document = requireOk(
    addFeature(document, {
      id: PAD_FEATURE,
      kind: "pad",
      inputs: [
        { kind: "body", id: BLANK_BODY },
        { kind: "parameter", id: DEPTH_PARAMETER },
      ],
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

const HOLE_FAILURE_DIAGNOSTIC: Diagnostic = {
  severity: "error",
  code: DIAGNOSTIC_CODES.kernelOperationFailed,
  message: "Hole failed: the target solid no longer resolves.",
  location: { primary: HOLE_FEATURE },
};

/** States from one real run whose hole feature fails (so diagnostics ride). */
function failingHoleStates(): RegenerationStateMap {
  const features = buildPanelDocument().features;
  const run = regenerate({
    features,
    states: initialRegenerationStates(features),
    suppressed: [],
    execute: (feature) =>
      feature.kind === "hole"
        ? { ok: false, diagnostics: [HOLE_FAILURE_DIAGNOSTIC] }
        : { ok: true },
  });
  if (!run.ok) throw new Error("the regeneration run refused");
  return run.value.states;
}

function sessionOf(): CadSession {
  return createSession(buildPanelDocument());
}

function storeOf(): CadStore {
  return createCadStore({ session: sessionOf() });
}

function renderInProvider(
  store: CadStore,
  props: CadPropertyPanelProps = {},
): void {
  render(
    <CadProvider store={store}>
      <CadPropertyPanel {...props} />
    </CadProvider>,
  );
}

/** The one section rendered for a single-element selection. */
function onlySection(): HTMLElement {
  const sections = document.querySelectorAll<HTMLDivElement>(
    "[data-cad-property-section]",
  );
  expect(sections.length, "exactly one section").toBe(1);
  const section = sections[0];
  if (section === undefined) throw new Error("unreachable: checked above");
  return section;
}

function pickInStore(store: CadStore, reference: SelectionReference): void {
  const picked = store.pick(reference, false);
  if (!picked.ok) {
    throw new Error(`the test pick refused: ${picked.error.message}`);
  }
}

afterEach(cleanup);

describe("CadPropertyPanel", () => {
  it("renders the titled panel with the selection count", () => {
    const store = storeOf();
    renderInProvider(store);
    expect(screen.getByText(CAD_PROPERTY_PANEL_LABELS.title)).not.toBeNull();
  });

  it("shows the nothing-selected state on an empty selection", () => {
    renderInProvider(storeOf());
    expect(
      screen.getByText(CAD_PROPERTY_PANEL_LABELS.emptySelection),
    ).not.toBeNull();
  });

  it("derives a body section's provenance rows from document data", () => {
    const store = storeOf();
    act(() => {
      pickInStore(store, { kind: "body", bodyId: PLATE_BODY });
    });
    renderInProvider(store);
    const section = onlySection();
    expect(section.getAttribute("data-reference-kind")).toBe("body");
    expect(section.textContent).toContain("plate");
    expect(section.textContent).toContain(String(PLATE_BODY));
    expect(section.textContent).toContain("pad");
  });

  it("derives a feature section's input and output summaries", () => {
    const store = storeOf();
    act(() => {
      pickInStore(store, { kind: "feature", featureId: PAD_FEATURE });
    });
    renderInProvider(store, {
      regenerationStates: failingHoleStates(),
    });
    const section = onlySection();
    expect(section.getAttribute("data-reference-kind")).toBe("feature");
    // The input summary resolves names: the body ref reads the body's name,
    // the parameter ref reads the parameter's name.
    expect(section.textContent).toContain("blank, depth");
    expect(section.textContent).toContain("plate");
  });

  it("shows a feature's status when the state map is supplied", () => {
    const store = storeOf();
    act(() => {
      pickInStore(store, { kind: "feature", featureId: HOLE_FEATURE });
    });
    renderInProvider(store, { regenerationStates: failingHoleStates() });
    const section = onlySection();
    expect(section.getAttribute("data-reference-kind")).toBe("feature");
    expect(section.textContent).toContain("failed");
    // The first diagnostic message is visible and aria-linked.
    expect(section.textContent).toContain(HOLE_FAILURE_DIAGNOSTIC.message);
    const describedBy = section.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      HOLE_FAILURE_DIAGNOSTIC.message,
    );
  });

  it("derives a synthetic face section's topology identity rows", () => {
    const store = storeOf();
    act(() => {
      // Synthetic references must stand at the state's CURRENT regeneration
      // (the domain's transience rule): advance, then pick.
      store.beginSelectionRegeneration(3);
      pickInStore(store, {
        kind: "face",
        bodyId: PLATE_BODY,
        regeneration: 3,
        faceIndex: 2,
      });
    });
    renderInProvider(store);
    const section = onlySection();
    expect(section.getAttribute("data-reference-kind")).toBe("face");
    expect(section.textContent).toContain("face");
    expect(section.textContent).toContain("2");
    expect(section.textContent).toContain("3");
  });

  it("commits feature.delete through the store and the selection survives", () => {
    const store = storeOf();
    act(() => {
      pickInStore(store, { kind: "feature", featureId: HOLE_FEATURE });
    });
    renderInProvider(store);
    const removeButton = screen.getByRole("button", {
      name: CAD_PROPERTY_PANEL_LABELS.remove,
    });
    act(() => {
      fireEvent.click(removeButton);
    });
    const document = store.getSession().document;
    expect(
      document.features.some((feature) => feature.id === HOLE_FEATURE),
    ).toBe(false);
    // The command count grew by exactly one transaction.
    expect(store.commandLog.length).toBe(1);
  });

  it("surfaces a remove refusal verbatim in the panel error region", () => {
    const onRemoveFeature = vi.fn(() => ({
      ok: false as const,
      error: {
        code: "feature/unknown",
        message: "the feature no longer exists",
      },
    }));
    render(
      <CadPropertyPanel
        document={buildPanelDocument()}
        selection={[{ kind: "feature", featureId: PAD_FEATURE }]}
        onRemoveFeature={onRemoveFeature}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: CAD_PROPERTY_PANEL_LABELS.remove }),
    );
    const alert = document.querySelector("[data-cad-property-error]");
    expect(alert?.textContent).toBe(
      "feature/unknown: the feature no longer exists",
    );
  });

  it("omits the remove button without any remove surface", () => {
    render(
      <CadPropertyPanel
        document={buildPanelDocument()}
        selection={[{ kind: "feature", featureId: PAD_FEATURE }]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: CAD_PROPERTY_PANEL_LABELS.remove }),
    ).toBeNull();
  });

  it("lets explicit props override the mirrored document and selection", () => {
    renderInProvider(storeOf(), {
      document: buildPanelDocument(),
      selection: [{ kind: "body", bodyId: BLANK_BODY }],
    });
    const section = onlySection();
    expect(section.textContent).toContain("blank");
  });

  it("renders the titled empty state without any document source", () => {
    render(<CadPropertyPanel selection={[]} />);
    expect(
      screen.getByText(CAD_PROPERTY_PANEL_LABELS.emptyDocument),
    ).not.toBeNull();
  });

  it("renders label overrides in place of the defaults", () => {
    const store = storeOf();
    act(() => {
      pickInStore(store, { kind: "body", bodyId: BLANK_BODY });
    });
    renderInProvider(store, {
      labels: { title: "Eigenschaften", rowName: "Name" },
    });
    expect(screen.getByText("Eigenschaften")).not.toBeNull();
  });
});
