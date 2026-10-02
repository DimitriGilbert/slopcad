/**
 * Component tests for `CadParameterManager` (Phase 23), exercised through
 * the panel's manage toggle — the exact wiring production uses. The tests
 * build real domain values (documents through `createDocument`/
 * `addDocumentParameter`, stores through `createCadStore` + `CadProvider`)
 * and pin the manager's own decisions: the toggle's presence per apply
 * surface, the create form's validation and `parameter.create` commit, the
 * `$` autocomplete in the expression editor (open, filter, bare-name
 * insertion, self-exclusion), the live preview, the expression and
 * clear-null `parameter.set` commits, the rendered dependency graph, and a
 * refused self-cycle surfacing verbatim in the shared alert region with
 * nothing issued, cleared by the next successful commit.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  addDocumentParameter,
  CadProvider,
  createCadStore,
  createDocument,
  createDocumentId,
  createParameterId,
  createSession,
  length,
  parseExpression,
  printExpression,
  type CadDocument,
  type CadStore,
  type ExpressionNode,
} from "@slopcad/cad-react";

import { CAD_PARAMETER_MANAGER_LABELS } from "./cad-parameter-manager";
import { CadParameterPanel } from "./cad-parameter-panel";

// ---------------------------------------------------------------------------
// Domain fixtures: a real document (two literals driving one expression)
// ---------------------------------------------------------------------------

const WIDTH_ID = createParameterId("param_width");
const HEIGHT_ID = createParameterId("param_height");
const DERIVED_ID = createParameterId("param_derived_depth");

/** Unwraps a source-text parse the test fixture depends on. */
function requireExpression(source: string): ExpressionNode {
  const parsed = parseExpression(source);
  if (!parsed.ok) {
    throw new Error(`Test expression rejected: ${parsed.error.message}`);
  }
  return parsed.value;
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

/**
 * The managed document: `width` (8 mm) and `plateHeight` (10 mm) as
 * literals, `derivedDepth` expression-driven over `width` (16 mm) — the
 * graph the dependency and autocomplete tests read.
 */
function buildDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_manager_test"));
  document = requireDocumentParameter(
    addDocumentParameter(document, {
      id: WIDTH_ID,
      name: "width",
      value: length(8),
    }),
    "the width parameter",
  );
  document = requireDocumentParameter(
    addDocumentParameter(document, {
      id: HEIGHT_ID,
      name: "plateHeight",
      value: length(10),
    }),
    "the plateHeight parameter",
  );
  return requireDocumentParameter(
    addDocumentParameter(document, {
      id: DERIVED_ID,
      name: "derivedDepth",
      value: length(16),
      expression: requireExpression("width * 2"),
    }),
    "the derivedDepth parameter",
  );
}

function buildStore(): CadStore {
  return createCadStore({ session: createSession(buildDocument()) });
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
  readonly commands: readonly {
    readonly type: string;
    readonly id?: string;
    readonly name?: string;
    readonly value?: unknown;
    readonly expression?: unknown;
  }[];
}

/** Mounts the panel under a fresh provider store and opens the manager. */
function mountManager(): CadStore {
  const store = buildStore();
  render(<PanelInProvider store={store} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage variables" }));
  return store;
}

/** The management row of one variable, located by its name text. */
function rowOf(name: string): HTMLElement {
  const row = screen
    .getByText(name, { exact: true })
    .closest('[data-slot="cad-parameter-row"]');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`the "${name}" management row did not render`);
  }
  return row;
}

/** Opens the row's expression editor and returns the editor input. */
function openEditor(name: string): HTMLInputElement {
  const row = rowOf(name);
  const action = within(row).getByRole("button", {
    name: /expression/i,
  });
  fireEvent.click(action);
  const input = screen.getByLabelText(name);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`the "${name}" editor field must render an input.`);
  }
  return input;
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The manage toggle
// ---------------------------------------------------------------------------

describe("CadParameterPanel manage mode", () => {
  it("swaps the edit form for the manager and back", () => {
    const store = buildStore();
    render(<PanelInProvider store={store} />);

    // Default mode: the edit form's fields; no manager chrome.
    expect(screen.getByLabelText("width")).toBeTruthy();
    expect(screen.queryByText("New variable")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Manage variables" }));

    // Manage mode: the create section and the management rows; the edit
    // form is unmounted (its fields are gone).
    expect(screen.getByText("New variable")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.queryByLabelText("width")).toBeNull();
    expect(screen.getByText("derivedDepth")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // Back: the edit form, with the collection's current state.
    expect(screen.getByLabelText("width")).toBeTruthy();
    expect(screen.queryByText("New variable")).toBeNull();
  });

  it("renders no manage toggle without a store-backed apply surface", () => {
    // Prop mode: an onApply host keeps the edit form — the manager's verbs
    // (create / expression / clear) are store commands.
    render(
      <CadParameterPanel
        parameters={[
          {
            id: createParameterId("param_width"),
            name: "width",
            value: length(8),
            expression: null,
            metadata: {},
          },
        ]}
        onApply={() => ({ ok: true })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Manage variables" }),
    ).toBeNull();
    expect(screen.getByLabelText("width")).toBeTruthy();
  });

  it("hosts the manager for an empty collection", () => {
    const store = createCadStore({
      session: createSession(
        createDocument(createDocumentId("doc_manager_empty")),
      ),
    });
    render(<PanelInProvider store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage variables" }));
    expect(screen.getByText("New variable")).toBeTruthy();
    expect(screen.getByText(CAD_PARAMETER_MANAGER_LABELS.empty)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("CadParameterManager create", () => {
  it("commits parameter.create with the quantity and lists the row", async () => {
    const store = mountManager();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "caseHeight" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "10mm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands).toHaveLength(1);
    expect(entry.commands[0]?.type).toBe("parameter.create");
    expect(entry.commands[0]?.name).toBe("caseHeight");
    // The quantity evaluates canonically: 10mm lands as 10 mm.
    expect(entry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 10,
    });

    // The row appears (the live collection), and the form reset for the
    // next create.
    expect(screen.getByText("caseHeight")).toBeTruthy();
    expect(within(rowOf("caseHeight")).getByText("10 mm")).toBeTruthy();
    const nameField = screen.getByLabelText("Name");
    if (!(nameField instanceof HTMLInputElement)) {
      throw new Error("the create form's name field must render an input.");
    }
    expect(nameField.value).toBe("");
  });

  it("commits a converted quantity through the domain's unit grammar", async () => {
    const store = mountManager();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "stroke" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "2cm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    // 2 cm evaluates to the canonical 20 mm — the domain converted it.
    expect(entry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 20,
    });
  });

  it("commits a negative literal — the previously-refused input — verbatim", async () => {
    const store = mountManager();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "caseDepth" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "-29.6mm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    // The negated literal lands as the domain's quantity — sign included.
    expect(entry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: -29.6,
    });
    // The row reads the signed quantity.
    expect(within(rowOf("caseDepth")).getByText("-29.6 mm")).toBeTruthy();
  });

  it("commits a pure computation over constants — a literal seed computable without the document", async () => {
    const store = mountManager();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "plate" },
    });
    // No identifier nodes: the value is derivable from the text alone, so
    // the create form's literal-seed charter admits it.
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "2mm * 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 6,
    });
  });

  it("validates the name rules and the quantity gate as field errors, issuing nothing", async () => {
    const store = mountManager();
    const name = screen.getByLabelText("Name");
    const value = screen.getByLabelText("Value");
    const create = () =>
      fireEvent.click(screen.getByRole("button", { name: "Create variable" }));

    // Not an identifier: the domain's rule, surfaced client-side.
    fireEvent.change(name, { target: { value: "9bad" } });
    fireEvent.change(value, { target: { value: "10mm" } });
    create();
    expect(
      await screen.findByText(CAD_PARAMETER_MANAGER_LABELS.nameInvalid, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // Reserved by the expression function set.
    fireEvent.change(name, { target: { value: "sqrt" } });
    create();
    expect(
      await screen.findByText('The name "sqrt" is reserved', { exact: false }),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // Taken: uniqueness against the LIVE collection.
    fireEvent.change(name, { target: { value: "width" } });
    create();
    expect(
      await screen.findByText('A variable named "width" already exists.'),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // A valid name never carries a formula: quantities here, expressions in
    // the row editor. A negation over an identifier is still a formula —
    // the identifier check catches the unary's operand.
    fireEvent.change(name, { target: { value: "caseHeight" } });
    fireEvent.change(value, { target: { value: "width * 2" } });
    create();
    expect(
      await screen.findByText(CAD_PARAMETER_MANAGER_LABELS.valueFormula),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    fireEvent.change(value, { target: { value: "-width" } });
    create();
    expect(
      await screen.findByText(CAD_PARAMETER_MANAGER_LABELS.valueFormula),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // An unparseable quantity is the domain's structured failure.
    fireEvent.change(value, { target: { value: "10 + " } });
    create();
    expect(
      await screen.findByText(
        "expression/unexpected-end-of-input: The expression ended where an operand was expected.",
      ),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // An empty value is the externalized gate.
    fireEvent.change(value, { target: { value: "" } });
    create();
    expect(
      await screen.findByText(CAD_PARAMETER_MANAGER_LABELS.valueInvalid),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expression editing: the $ autocomplete, the preview, the commits
// ---------------------------------------------------------------------------

describe("CadParameterManager expression editing", () => {
  it("opens the $ autocomplete mid-text, inserts the bare identifier, and previews live", () => {
    mountManager();
    const input = openEditor("plateHeight");

    // The editor opens on the domain's own printing: the literal's
    // canonical magnitude.
    expect(input.value).toBe("10");

    // A `$` token ANYWHERE opens the list; the partial filters it.
    fireEvent.change(input, { target: { value: "10mm + $de" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const options = [
      ...screen.getByRole("listbox").querySelectorAll("[role=option]"),
    ].map((option) => option.textContent);
    expect(options).toEqual(["$derivedDepth"]);

    // Clicking inserts the BARE identifier — the token the grammar parses —
    // and the live preview evaluates the current text (10 + 16).
    fireEvent.click(screen.getByRole("option", { name: "$derivedDepth" }));
    expect(input.value).toBe("10mm + derivedDepth");
    expect(screen.getByText("= 26 mm", { exact: true })).toBeTruthy();
  });

  it("excludes the edited variable from its own suggestions", () => {
    mountManager();
    const input = openEditor("width");

    fireEvent.change(input, { target: { value: "$d" } });
    const options = [
      ...screen.getByRole("listbox").querySelectorAll("[role=option]"),
    ].map((option) => option.textContent);
    // width's own row is never suggested (a trivial self-cycle), even when
    // the partial would otherwise match the edited name itself.
    fireEvent.change(input, { target: { value: "$wid" } });
    const selfQuery = [
      ...screen.getByRole("listbox").querySelectorAll("[role=option]"),
    ].map((option) => option.textContent);
    expect(options).toEqual(["$derivedDepth"]);
    expect(selfQuery).toEqual([]);
  });

  it("commits the expression AST payload and closes the editor", async () => {
    const store = mountManager();
    const input = openEditor("plateHeight");

    fireEvent.change(input, { target: { value: "$w" } });
    fireEvent.click(screen.getByRole("option", { name: "$width" }));
    expect(input.value).toBe("width");
    expect(screen.getByText("= 8 mm", { exact: true })).toBeTruthy();

    // The editor's Apply is the manage surface's only Apply button (the
    // edit form is unmounted in manage mode).
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands[0]?.type).toBe("parameter.set");
    expect(entry.commands[0]?.id).toBe("param_height");
    expect(entry.commands[0]?.value).toBeUndefined();
    expect(entry.commands[0]?.expression).toEqual(requireExpression("width"));

    // The editor closed; the row now reads the derived quantity and its
    // direct reference.
    expect(screen.queryByLabelText("plateHeight")).toBeNull();
    expect(
      within(rowOf("plateHeight")).getByText("= 8 mm", { exact: true }),
    ).toBeTruthy();
    expect(
      within(rowOf("plateHeight")).getByText("depends on width"),
    ).toBeTruthy();
  });

  it("surfaces a typed self-cycle verbatim in the alert region and issues nothing", async () => {
    const store = mountManager();
    const input = openEditor("width");

    // Typed, not suggested (the self row is excluded from the list): the
    // domain still refuses the cycle at commit — the evaluator cannot see
    // it against the cached values, so the field validation passes.
    fireEvent.change(input, { target: { value: "width" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("parameter/cycle");
    expect(alert.textContent).toContain("width → width");
    expect(store.commandLog).toHaveLength(0);

    // The refusal leaves the editor open underneath; cancelling issues
    // nothing and closes it.
    expect(screen.getByLabelText("width")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("width")).toBeNull();
    expect(store.commandLog).toHaveLength(0);
  });

  it("blocks an invalid expression at the field and issues nothing", async () => {
    const store = mountManager();
    const input = openEditor("plateHeight");

    fireEvent.change(input, { target: { value: "width *" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(
      await screen.findByText(
        "expression/unexpected-end-of-input: The expression ended where an operand was expected.",
      ),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);
    // The structured failure keeps the editor open; the field gate (not the
    // alert region) carries it — cancel discards the edit.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("plateHeight")).toBeNull();
    expect(store.commandLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Clear back to literal
// ---------------------------------------------------------------------------

describe("CadParameterManager clear", () => {
  it("commits the clear-null form landing on the evaluated quantity", async () => {
    const store = mountManager();

    const row = rowOf("derivedDepth");
    expect(within(row).getByText("= 16 mm", { exact: true })).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Make literal" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands[0]?.type).toBe("parameter.set");
    expect(entry.commands[0]?.id).toBe("param_derived_depth");
    expect(entry.commands[0]?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 16,
    });
    expect(entry.commands[0]?.expression).toBeNull();

    // The row is a literal now: the quantity loses the derivation marker,
    // the graph line is gone, and the row's action is the switch again.
    expect(
      within(rowOf("derivedDepth")).getByText("16 mm", { exact: true }),
    ).toBeTruthy();
    expect(within(rowOf("derivedDepth")).queryByText(/depends on/)).toBeNull();
    expect(
      within(rowOf("derivedDepth")).getByRole("button", {
        name: "Set expression",
      }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The dependency graph
// ---------------------------------------------------------------------------

describe("CadParameterManager dependency graph", () => {
  it("renders direct references and reference counts", () => {
    mountManager();

    expect(
      within(rowOf("derivedDepth")).getByText("depends on width"),
    ).toBeTruthy();
    // width is read by exactly one stored expression; the literals by none.
    expect(within(rowOf("width")).getByText("used by 1 variable")).toBeTruthy();
    expect(within(rowOf("plateHeight")).queryByText(/used by/)).toBeNull();
    expect(within(rowOf("width")).queryByText(/depends on/)).toBeNull();
  });

  it("prints the stored expression through the domain after a commit", async () => {
    const store = mountManager();
    const input = openEditor("plateHeight");

    fireEvent.change(input, { target: { value: "$w" } });
    fireEvent.click(screen.getByRole("option", { name: "$width" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(store.commandLog).toHaveLength(1));

    // The stored AST is the domain's; its printing is what the manager
    // would reopen the editor with.
    const stored = store
      .getDocument()
      .parameters.parameters.find(
        (parameter) => parameter.id === "param_height",
      );
    const storedExpression = stored?.expression ?? null;
    expect(
      storedExpression === null ? null : printExpression(storedExpression),
    ).toBe("width");
  });
});

// ---------------------------------------------------------------------------
// The shared alert region across manager commits
// ---------------------------------------------------------------------------

describe("CadParameterPanel manage-mode alert region", () => {
  it("clears a refusal once a later manager commit succeeds", async () => {
    const store = mountManager();

    // The refusal: a typed self-cycle the field validation passes.
    const input = openEditor("width");
    fireEvent.change(input, { target: { value: "width" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("parameter/cycle");
    expect(alert.textContent).toContain("width → width");
    expect(store.commandLog).toHaveLength(0);

    // The refused editor is discarded (issuing nothing), then a successful
    // create commits through the same apply surface.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "caseHeight" },
    });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "10mm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands[0]?.type).toBe("parameter.create");
    expect(entry.commands[0]?.name).toBe("caseHeight");

    // The stale refusal is gone: the region reports the LATEST outcome,
    // not the last failure.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rename (Phase 24)
// ---------------------------------------------------------------------------

describe("CadParameterManager rename", () => {
  /** Opens the row's rename editor and returns its name field. */
  function openRename(name: string): HTMLInputElement {
    fireEvent.click(
      within(rowOf(name)).getByRole("button", { name: "Rename" }),
    );
    const input = screen.getByLabelText("New name");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("the rename editor field must render an input.");
    }
    return input;
  }

  it("commits parameter.rename and rewrites the dependent's dependency line", async () => {
    const store = mountManager();
    const input = openRename("width");

    fireEvent.change(input, { target: { value: "shelfWidth" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands[0]?.type).toBe("parameter.rename");
    expect(entry.commands[0]?.id).toBe("param_width");
    expect(entry.commands[0]?.name).toBe("shelfWidth");

    // The editor closed; the row's name moved.
    expect(screen.queryByLabelText("New name")).toBeNull();
    expect(rowOf("shelfWidth")).toBeTruthy();
    expect(screen.queryByText("width", { exact: true })).toBeNull();
    // THE REWRITE, VISIBLE: the dependent's dependency line reads the NEW
    // name (its stored AST was rewritten in the same application), and its
    // evaluated quantity is unchanged.
    expect(
      within(rowOf("derivedDepth")).getByText("depends on shelfWidth"),
    ).toBeTruthy();
    expect(
      within(rowOf("derivedDepth")).getByText("= 16 mm", { exact: true }),
    ).toBeTruthy();
    // The stored expression really carries the new identifier.
    const stored = store
      .getDocument()
      .parameters.parameters.find(
        (parameter) => parameter.id === "param_derived_depth",
      );
    expect(
      stored?.expression === null
        ? null
        : printExpression(stored?.expression as ExpressionNode),
    ).toBe("shelfWidth * 2");
  });

  it("validates the name rules as field errors and issues nothing", async () => {
    const store = mountManager();
    const input = openRename("width");

    // Empty: not an identifier.
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByText(CAD_PARAMETER_MANAGER_LABELS.nameInvalid),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // Reserved: the expression function set.
    fireEvent.change(input, { target: { value: "sqrt" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByText(
        'The name "sqrt" is reserved by the expression function set.',
      ),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // Taken: another LIVE variable's name (the row's own is excluded).
    fireEvent.change(input, { target: { value: "plateHeight" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByText('A variable named "plateHeight" already exists.'),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);

    // The refusal-free path still works after the field errors.
    fireEvent.change(input, { target: { value: "shelfWidth" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    expect(rowOf("shelfWidth")).toBeTruthy();
  });

  it("cancel closes the editor and issues nothing", () => {
    const store = mountManager();
    openRename("width");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New name")).toBeNull();
    expect(screen.getByText("width", { exact: true })).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Delete (Phase 24)
// ---------------------------------------------------------------------------

describe("CadParameterManager delete", () => {
  it("requires the two-click confirm and removes an unreferenced variable", async () => {
    const store = mountManager();

    // First click ARMS: the action row swaps to Confirm delete + Cancel,
    // and nothing is issued.
    fireEvent.click(
      within(rowOf("plateHeight")).getByRole("button", { name: "Delete" }),
    );
    expect(
      within(rowOf("plateHeight")).getByRole("button", {
        name: "Confirm delete",
      }),
    ).toBeTruthy();
    expect(store.commandLog).toHaveLength(0);
    expect(rowOf("plateHeight")).toBeTruthy();

    // Cancel disarms without issuing; re-arming works.
    fireEvent.click(
      within(rowOf("plateHeight")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
    fireEvent.click(
      within(rowOf("plateHeight")).getByRole("button", { name: "Delete" }),
    );

    // The armed second leg issues `parameter.delete`; the row disappears
    // with the live collection.
    fireEvent.click(
      within(rowOf("plateHeight")).getByRole("button", {
        name: "Confirm delete",
      }),
    );
    await waitFor(() => expect(store.commandLog).toHaveLength(1));
    const entry = JSON.parse(
      JSON.stringify(store.commandLog[0]),
    ) as SerializedCommandLogEntry;
    expect(entry.commands[0]?.type).toBe("parameter.delete");
    expect(entry.commands[0]?.id).toBe("param_height");
    expect(screen.queryByText("plateHeight", { exact: true })).toBeNull();
  });

  it("surfaces the refusal with the blockers and keeps the row", async () => {
    const store = mountManager();

    // `width` is read by derivedDepth's stored expression: the delete
    // refuses, and the shared alert names the blocker.
    fireEvent.click(
      within(rowOf("width")).getByRole("button", { name: "Delete" }),
    );
    fireEvent.click(
      within(rowOf("width")).getByRole("button", {
        name: "Confirm delete",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("document/in-use");
    expect(alert.textContent).toContain("derivedDepth");
    expect(store.commandLog).toHaveLength(0);
    // The row survived the refusal (disarmed — the confirm is gone).
    expect(rowOf("width")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
  });
});
