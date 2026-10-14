/**
 * Component tests for `CadParameterPanel` (Phase 15.4). The panel edits the
 * real document, so the tests build real domain values — parameter
 * collections through `addParameter`, documents through
 * `createDocument`/`addDocumentParameter`, and stores through
 * `createCadStore` + `CadProvider` — and exercise exactly the component's
 * own decisions: display of names, canonical quantities, and expressions;
 * the Formedible form surface (a real `<form>` whose submit is the only
 * apply trigger); the `parameter.set` command path asserted through the
 * real store's command log; domain-validated expression errors (exact code
 * and message, nothing issued); no-op filtering; the per-group prop
 * precedence; and the documented providerless behaviors.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDocumentParameter,
  addParameter,
  CadProvider,
  createCadStore,
  createDocument,
  createDocumentId,
  createParameterId,
  createSession,
  EMPTY_PARAMETER_COLLECTION,
  length,
  angle,
  parseExpression,
  printExpression,
  setParameterCommand,
  setParameterExpressionCommand,
  volume,
  type CadDocument,
  type CadStore,
  type ExpressionNode,
  type ParameterCollection,
} from "@slopcad/cad-react";

import {
  CAD_PARAMETER_PANEL_LABELS,
  CadParameterPanel,
  type CadParameterApply,
} from "./cad-parameter-panel";

// ---------------------------------------------------------------------------
// Domain fixtures: a real collection (prop-driven) and a real store
// ---------------------------------------------------------------------------

const WIDTH_ID = createParameterId("param_width");
const TILT_ID = createParameterId("param_tilt");
const REFERENCE_ID = createParameterId("param_reference");
const DISPLACEMENT_ID = createParameterId("param_displacement");
const DERIVED_ID = createParameterId("param_derived_depth");
const HEIGHT_ID = createParameterId("param_height");
const BRACE_ID = createParameterId("param_brace");

/** Unwraps a source-text parse the test fixture depends on. */
function requireExpression(source: string): ExpressionNode {
  const parsed = parseExpression(source);
  if (!parsed.ok) {
    throw new Error(`Test expression rejected: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** Unwraps a collection mutation the test fixture depends on. */
function requireAdded(
  result:
    | { readonly ok: true; readonly value: ParameterCollection }
    | { readonly ok: false; readonly error: { readonly message: string } },
): ParameterCollection {
  if (!result.ok) {
    throw new Error(`Test collection rejected input: ${result.error.message}`);
  }
  return result.value;
}

/**
 * The prop-driven display collection: literal lengths (one stored in a
 * NON-canonical unit), an angle, a volume, and one expression-driven
 * parameter whose cached value is 20 mm.
 */
function buildDisplayCollection(): ParameterCollection {
  let collection = requireAdded(
    addParameter(EMPTY_PARAMETER_COLLECTION, {
      id: WIDTH_ID,
      name: "width",
      value: length(8),
    }),
  );
  collection = requireAdded(
    addParameter(collection, {
      id: TILT_ID,
      name: "tilt",
      value: angle(0, "deg"),
    }),
  );
  collection = requireAdded(
    addParameter(collection, {
      id: REFERENCE_ID,
      name: "reference",
      value: length(1, "in"),
    }),
  );
  collection = requireAdded(
    addParameter(collection, {
      id: DISPLACEMENT_ID,
      name: "displacement",
      value: volume(2, "cm3"),
    }),
  );
  return requireAdded(
    addParameter(collection, {
      id: DERIVED_ID,
      name: "derivedDepth",
      value: length(20),
      expression: requireExpression("width * 2"),
    }),
  );
}

/** The provider-driven document: `width` (8 mm) driving `derivedDepth`. */
function buildProviderDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_panel_test"));
  document = requireDocumentParameter(
    addDocumentParameter(document, {
      id: WIDTH_ID,
      name: "width",
      value: length(8),
    }),
    "the width parameter",
  );
  return requireDocumentParameter(
    addDocumentParameter(document, {
      id: DERIVED_ID,
      name: "derivedDepth",
      value: length(20),
      expression: requireExpression("width * 2"),
    }),
    "the derivedDepth parameter",
  );
}

function requireDocumentParameter(
  result: {
    readonly ok: boolean;
    readonly value?: { readonly document: CadDocument };
    readonly error?: { readonly message: string };
  },
  what: string,
): CadDocument {
  if (!result.ok || result.value === undefined) {
    throw new Error(
      `Test document rejected ${what}: ${String(result.error?.message)}`,
    );
  }
  return result.value.document;
}

function buildProviderStore(): CadStore {
  return createCadStore({ session: createSession(buildProviderDocument()) });
}

/**
 * The batched-submit document: `height` (10 mm, literal) driving `brace`
 * (`height * 2`, cached 20 mm) — one submit changes both at once.
 */
function buildBatchDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_panel_batch_test"));
  document = requireDocumentParameter(
    addDocumentParameter(document, {
      id: HEIGHT_ID,
      name: "height",
      value: length(10),
    }),
    "the height parameter",
  );
  return requireDocumentParameter(
    addDocumentParameter(document, {
      id: BRACE_ID,
      name: "brace",
      value: length(20),
      expression: requireExpression("height * 2"),
    }),
    "the brace parameter",
  );
}

/** Reads a labelled field as an input (the panel's fields are all inputs). */
function requireInputField(label: string): HTMLInputElement {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`The "${label}" field must render an input.`);
  }
  return field;
}

function PanelInProvider({ store }: { readonly store: CadStore }) {
  return (
    <CadProvider store={store}>
      <CadParameterPanel />
    </CadProvider>
  );
}

/** One serialized command-log entry (the store's canonical transaction form). */
interface SerializedCommandLogEntry {
  readonly formatVersion: number;
  readonly commands: readonly {
    readonly type: string;
    readonly id: string;
    readonly value?: {
      readonly dimension: string;
      readonly unit: string;
      readonly value: number;
    };
    readonly expression?: unknown;
  }[];
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

describe("CadParameterPanel", () => {
  it("renders names, canonical quantities with units, and the defining expression", () => {
    render(
      <CadParameterPanel parameters={buildDisplayCollection().parameters} />,
    );

    // Panel title; a real Formedible form carries the fields (structural
    // evidence: the editable surface is a form, not decorated divs).
    expect(screen.getByText("Parameters")).toBeTruthy();
    const form = screen.getByRole("form", { name: "Parameters" });
    expect(form).toBeTruthy();

    // Literal values display canonically: the inch parameter reads 25.4 mm,
    // the degree parameter reads radians, the cm³ volume reads mm³ ("mm3" —
    // the domain's canonical token).
    expect(screen.getByText("Current value: 8 mm")).toBeTruthy();
    expect(screen.getByText("Current value: 0 rad")).toBeTruthy();
    expect(screen.getByText("Current value: 25.4 mm")).toBeTruthy();
    expect(screen.getByText("Current value: 2000 mm3")).toBeTruthy();

    // Labels ARE the parameter names; the value field holds the canonical
    // magnitude; the expression field displays the domain's own printing.
    const width = requireInputField("width");
    expect(width.value).toBe("8");
    expect(width.type).toBe("number");
    const derived = requireInputField("derivedDepth");
    expect(derived.value).toBe("width * 2");
    expect(derived.type).toBe("text");

    // The expression-driven parameter shows its current CACHED quantity.
    expect(screen.getByText("Current value: 20 mm")).toBeTruthy();
  });

  it("renders the titled empty state for an empty or absent collection", () => {
    render(<CadParameterPanel parameters={[]} />);
    expect(screen.getByText("No parameters.")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Provider-driven apply: the parameter.set command path
  // -------------------------------------------------------------------------

  it("commits an edited literal value as a parameter.set transaction through the store", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "6" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    // The DOCUMENT changed: exactly one transaction, one canonical
    // `parameter.set` command — the documented command path.
    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands).toHaveLength(1);
    expect(entry.commands[0]?.type).toBe("parameter.set");
    expect(entry.commands[0]?.id).toBe("param_width");
    expect(entry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 6,
    });

    // The mirror followed the commit: the new current quantity.
    expect(await screen.findByText("Current value: 6 mm")).toBeTruthy();
  });

  it("issues no command for unchanged fields while applying the changed one", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    // Only `width` moves; the expression-driven field still prints its
    // current expression, so exactly ONE command may issue.
    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "6" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands).toHaveLength(1);
    expect(entry.commands[0]?.id).toBe("param_width");
  });

  it("does not re-issue anything when an unchanged form resubmits", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "6" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));
    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    expect(await screen.findByText("Current value: 6 mm")).toBeTruthy();

    // Resubmit with the fields already at document state: the submit runs,
    // but the no-op filter issues nothing — flush the async submit with act.
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.commandLog).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Reseed: the fields follow the committed document
  // ---------------------------------------------------------------------------

  it("re-adopts a foreign revert while no edits are unsubmitted, and Apply does not resurrect the stale value", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    // The panel's own edit lands: width 8 → 6. The submit leaves the field
    // touched, the state that disables form-core's own defaults reseed.
    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "6" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));
    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    expect(await screen.findByText("Current value: 6 mm")).toBeTruthy();

    // A FOREIGN commit (an undo, a manage-mode edit) reverts width to 8
    // behind the form's back. It lands as the log's second transaction.
    act(() => {
      const applied = store.applyCommand(
        setParameterCommand(WIDTH_ID, length(8)),
      );
      if (!applied.ok) {
        throw new Error(`Test revert refused: ${applied.error.message}`);
      }
    });
    await waitFor(() => expect(store.commandLog).toHaveLength(2));
    const revertEntry = JSON.parse(
      JSON.stringify(store.commandLog[1]),
    ) as SerializedCommandLogEntry;
    expect(revertEntry.commands[0]?.id).toBe("param_width");
    expect(revertEntry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 8,
    });

    // The field shows the REVERTED document value, not the submitted 6 —
    // the form carried no unsubmitted edit, so the commit is adopted.
    await waitFor(() => expect(requireInputField("width").value).toBe("8"));

    // And Apply issues NOTHING: the fields hold document state, so the
    // stale submitted value cannot be re-committed over the foreign change.
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.commandLog).toHaveLength(2);
  });

  it("preserves in-progress typing on a foreign commit while clean fields adopt the committed values", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    // width is mid-edit (typed, unsubmitted) ...
    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "50" },
    });

    // ... when a foreign commit rewrites derivedDepth's defining
    // expression (width * 2 → width * 3).
    act(() => {
      const applied = store.applyCommand(
        setParameterExpressionCommand(
          DERIVED_ID,
          requireExpression("width * 3"),
        ),
      );
      if (!applied.ok) {
        throw new Error(`Test commit refused: ${applied.error.message}`);
      }
    });

    // The typed field keeps the in-progress input; the untouched field
    // re-adopts the committed printing of the new expression.
    expect(requireInputField("width").value).toBe("50");
    await waitFor(() =>
      expect(requireInputField("derivedDepth").value).toBe("width * 3"),
    );

    // And Apply commits the TYPED width over the foreign change — the
    // stale-document re-commit hazard this reseed rule exists for. The
    // foreign commit is the log's first transaction; the panel's submit
    // adds exactly one more: one `parameter.set` carrying 50 (the
    // re-adopted expression equals the committed printing, so it issues
    // nothing).
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));
    await waitFor(() => expect(store.commandLog).toHaveLength(2));
    const typedEntry = JSON.parse(
      JSON.stringify(store.commandLog[1]),
    ) as SerializedCommandLogEntry;
    expect(typedEntry.commands).toHaveLength(1);
    expect(typedEntry.commands[0]?.type).toBe("parameter.set");
    expect(typedEntry.commands[0]?.id).toBe("param_width");
    expect(typedEntry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 50,
    });

    // The mirror followed the commit: the typed magnitude, not the
    // document's pre-submit 8 (and derivedDepth re-evaluates: 50 * 3).
    expect(await screen.findByText("Current value: 50 mm")).toBeTruthy();
  });

  it("treats an identical-values foreign commit as a non-event: fields stay and Apply issues nothing", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    // A foreign commit that sets width to the value it already carries: the
    // fields already hold the seeded document state, so the reseed's merged
    // diff finds nothing to change — no reset churn, no visible change, no
    // error region.
    act(() => {
      const applied = store.applyCommand(
        setParameterCommand(WIDTH_ID, length(8)),
      );
      if (!applied.ok) {
        throw new Error(`Test commit refused: ${applied.error.message}`);
      }
    });

    expect(requireInputField("width").value).toBe("8");
    expect(requireInputField("derivedDepth").value).toBe("width * 2");
    expect(screen.queryByRole("alert")).toBeNull();

    // And Apply issues nothing: the form holds document state, so the
    // command log keeps only the foreign commit itself.
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.commandLog).toHaveLength(1);
  });

  it("commits an edited expression as a parameter.set expression payload", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    fireEvent.change(screen.getByLabelText("derivedDepth"), {
      target: { value: "width * 3" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    // Expression edits commit the EXPRESSION (the serialized AST, no value);
    // the domain's interpreter evaluates it in the same application — the
    // document's cached value reads width (8 mm) * 3 = 24 mm.
    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands[0]?.type).toBe("parameter.set");
    expect(entry.commands[0]?.id).toBe("param_derived_depth");
    expect(entry.commands[0]?.value).toBeUndefined();
    expect(entry.commands[0]?.expression).toEqual(
      requireExpression("width * 3"),
    );
    const stored = store
      .getDocument()
      .parameters.parameters.find(
        (parameter) => parameter.id === "param_derived_depth",
      );
    const storedExpression = stored?.expression ?? null;
    expect(
      storedExpression === null ? null : printExpression(storedExpression),
    ).toBe("width * 3");
    expect(stored?.value.value).toBe(24);
  });

  it("evaluates a batched expression edit against the literal committed earlier in the same submit", async () => {
    const store = createCadStore({
      session: createSession(buildBatchDocument()),
    });
    render(<PanelInProvider store={store} />);

    // One submit carries both edits: the literal height 10→20 and the
    // expression `height * 2`→`height * 3`. The literal is committed first,
    // so the domain evaluates the expression commit against the LIVE
    // document (height 20) and caches brace=60 — not 30, the product of the
    // pre-submit snapshot's height=10.
    fireEvent.change(screen.getByLabelText("height"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("brace"), {
      target: { value: "height * 3" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(2));
    const heightEntry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(heightEntry.commands[0]?.id).toBe("param_height");
    expect(heightEntry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 20,
    });
    const braceEntry = JSON.parse(
      JSON.stringify(store.commandLog[1]),
    ) as SerializedCommandLogEntry;
    expect(braceEntry.commands[0]?.id).toBe("param_brace");
    expect(braceEntry.commands[0]?.expression).toEqual(
      requireExpression("height * 3"),
    );
    const brace = store
      .getDocument()
      .parameters.parameters.find(
        (parameter) => parameter.id === "param_brace",
      );
    expect(brace?.value.value).toBe(60);
  });

  it("surfaces a cycle refusal verbatim in the panel error region and issues nothing", async () => {
    const store = createCadStore({
      session: createSession(buildBatchDocument()),
    });
    render(<PanelInProvider store={store} />);

    // The field evaluator only validates parse/evaluate — a self-reference
    // evaluates fine against the cached values — so the cycle arrives from
    // the apply surface's interpreter and surfaces in the error region,
    // verbatim, with the closing chain named.
    fireEvent.change(screen.getByLabelText("brace"), {
      target: { value: "brace + height" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    const region = await screen.findByRole("alert");
    expect(region.getAttribute("data-cad-param-panel-error")).toBe("");
    expect(region.textContent).toContain("parameter/cycle");
    expect(region.textContent).toContain("brace → brace");
    // The refused submit stops the loop: no command landed.
    expect(store.commandLog).toHaveLength(0);
  });

  it("surfaces the domain's structured expression error verbatim and issues nothing", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    fireEvent.change(screen.getByLabelText("derivedDepth"), {
      target: { value: "width *" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    // The exact parse failure — the domain's code AND message, unaltered.
    expect(
      await screen.findByText(
        "expression/unexpected-end-of-input: The expression ended where an operand was expected.",
      ),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // An evaluation failure reads the same way, still issuing nothing.
    fireEvent.change(screen.getByLabelText("derivedDepth"), {
      target: { value: "unknownName" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));
    expect(
      await screen.findByText(
        'expression/unknown-identifier: Unknown identifier "unknownName".',
      ),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);
  });

  it("surfaces an overflowing unit literal as the structured non-finite failure, not a crash", async () => {
    const store = buildProviderStore();
    render(<PanelInProvider store={store} />);

    // 1e308 m: finite in meters, but its conversion to the canonical mm
    // overflows. Evaluation returns the structured failure, which the
    // panel's field validation renders through formatDomainError — before
    // the evaluator's never-throw fix this escaped as an uncaught
    // DimensionalValueValidationError inside the validator.
    fireEvent.change(screen.getByLabelText("derivedDepth"), {
      target: { value: `1${"0".repeat(308)}.0m` },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    expect(
      await screen.findByText(
        "expression/non-finite-result: The length value 1e+308 m does not convert to a finite magnitude in the canonical unit mm of its dimension.",
      ),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Prop-driven precedence and providerless behavior
  // -------------------------------------------------------------------------

  it("captures edits through the onApply prop without a provider", async () => {
    const onApply = vi.fn<CadParameterApply>(() => ({ ok: true }));
    render(
      <CadParameterPanel
        parameters={buildDisplayCollection().parameters}
        onApply={onApply}
      />,
    );

    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "6" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const [parameter, edit] = onApply.mock.calls[0] ?? [];
    expect(parameter?.id).toBe("param_width");
    expect(edit).toEqual({ kind: "value", value: 6 });
  });

  it("surfaces an apply refusal in the panel error region", async () => {
    const onApply: CadParameterApply = () => ({
      ok: false,
      error: {
        code: "parameter/not-found",
        message: 'No parameter with id "param_width" exists.',
      },
    });
    render(
      <CadParameterPanel
        parameters={buildDisplayCollection().parameters}
        onApply={onApply}
      />,
    );

    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "6" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Parameters" }));

    const region = await screen.findByRole("alert");
    expect(region.getAttribute("data-cad-param-panel-error")).toBe("");
    expect(region.textContent).toBe(
      'parameter/not-found: No parameter with id "param_width" exists.',
    );
  });

  it("renders inert without any apply surface: disabled fields, no submit", () => {
    render(
      <CadParameterPanel parameters={buildDisplayCollection().parameters} />,
    );

    expect(screen.getByLabelText("width")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("derivedDepth")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  it("renders label overrides over the documented defaults", async () => {
    const onApply = vi.fn<CadParameterApply>(() => ({ ok: true }));
    render(
      <CadParameterPanel
        parameters={buildDisplayCollection().parameters}
        onApply={onApply}
        labels={{
          title: "Driver dimensions",
          submit: "Commit",
          currentValue: "Now",
          valueInvalid: "Numeric only.",
        }}
      />,
    );

    expect(screen.getByText("Driver dimensions")).toBeTruthy();
    expect(screen.getByText("Now: 8 mm")).toBeTruthy();
    const form = screen.getByRole("form", { name: "Driver dimensions" });

    // The externalized invalid-number message is the value field's refusal.
    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "" },
    });
    fireEvent.submit(form);
    expect(await screen.findByText("Numeric only.")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("width"), {
      target: { value: "6" },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy();
  });

  it("exposes the documented label defaults object", () => {
    expect(CAD_PARAMETER_PANEL_LABELS.title).toBe("Parameters");
    expect(CAD_PARAMETER_PANEL_LABELS.submit).toBe("Apply");
  });

  // -------------------------------------------------------------------------
  // Default display-source precedence: props win per group
  // -------------------------------------------------------------------------

  it("prefers the parameters prop for display while mirroring the provider", () => {
    const store = buildProviderStore();
    render(
      <CadProvider store={store}>
        <CadParameterPanel parameters={buildDisplayCollection().parameters} />
      </CadProvider>,
    );

    // The prop collection is displayed (its extra rows included) even though
    // a provider is mounted — per-group precedence, like the tree siblings.
    expect(screen.getByText("Current value: 2000 mm3")).toBeTruthy();
    // The groups are independent: the display prop does NOT detach the
    // provider's apply surface — edits still commit through the store.
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });
});
