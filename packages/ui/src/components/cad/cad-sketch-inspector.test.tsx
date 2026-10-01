/**
 * Component tests for `CadSketchInspector` (Phase 25): the solver readout,
 * the constraint list's selection semantics, the Formedible dimension editor
 * (finite gate, apply outcome surfacing, unchanged submits filtered by the
 * host), and the documented inert and hint behaviors.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAD_SKETCH_INSPECTOR_LABELS,
  CadSketchInspector,
  type CadSketchInspectorProps,
} from "./cad-sketch-inspector";

afterEach(cleanup);

const CONSTRAINTS: CadSketchInspectorProps["constraints"] = [
  {
    entityIds: ["skent_bottom"],
    id: "skcon_horizontal",
    kind: "horizontal",
    label: "horizontal",
    status: "ok",
  },
  {
    entityIds: ["skent_bottom"],
    id: "skcon_width",
    kind: "distance",
    label: "distance 60 mm",
    status: "ok",
  },
  {
    entityIds: ["skent_bottom"],
    id: "skconf_bad",
    kind: "distance",
    label: "distance 100 mm",
    message:
      "sketch/constraints-conflicting: drop skconf_bad to make the system solvable.",
    status: "error",
  },
];

function renderInspector(props: Partial<CadSketchInspectorProps> = {}) {
  const onSelectConstraint = vi.fn();
  const onEditDimension = vi.fn().mockReturnValue({ ok: true });
  const view = render(
    <CadSketchInspector
      constraints={CONSTRAINTS}
      diagnostics={[]}
      dimension={null}
      dof={7}
      onSelectConstraint={onSelectConstraint}
      onEditDimension={onEditDimension}
      selectedConstraintId={null}
      solveStatus="under-constrained"
      {...props}
    />,
  );
  return { onEditDimension, onSelectConstraint, view };
}

function constraintRow(id: string): HTMLElement {
  const element = document.querySelector(`[data-sketch-constraint-id="${id}"]`);
  if (element === null) throw new Error(`no row for ${id}`);
  return element as HTMLElement;
}

describe("CadSketchInspector", () => {
  it("shows the solver readout: status chip and degrees of freedom", () => {
    const { view } = renderInspector();
    const root = view.container.querySelector(
      '[data-slot="cad-sketch-inspector"]',
    );
    expect(
      root?.querySelector('[data-testid="sketch-solve-status"]')?.textContent,
    ).toBe("Under-constrained");
    expect(root?.getAttribute("data-sketch-inspector-dof")).toBe("7");
    expect(root?.getAttribute("data-sketch-inspector-solve-status")).toBe(
      "under-constrained",
    );
  });

  it("lists constraints with per-status styling and toggles selection", () => {
    const { onSelectConstraint } = renderInspector();
    expect(
      constraintRow("skcon_width").getAttribute(
        "data-sketch-constraint-status",
      ),
    ).toBe("ok");
    expect(
      constraintRow("skconf_bad").getAttribute("data-sketch-constraint-status"),
    ).toBe("error");
    fireEvent.click(constraintRow("skcon_width"));
    expect(onSelectConstraint).toHaveBeenLastCalledWith("skcon_width");
  });

  it("edits the selected dimensional constraint through the Formedible form", async () => {
    const { onEditDimension } = renderInspector({
      dimension: {
        constraintId: "skcon_width",
        decimals: 3,
        unit: "mm",
        value: 60,
      },
      selectedConstraintId: "skcon_width",
    });
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(onEditDimension).toHaveBeenCalledWith("skcon_width", 80);
    });
  });

  it("surfaces the apply surface's structured refusal verbatim", async () => {
    renderInspector({
      dimension: {
        constraintId: "skcon_width",
        decimals: 3,
        unit: "mm",
        value: 60,
      },
      selectedConstraintId: "skcon_width",
      ...({
        onEditDimension: () => ({
          error: {
            code: "sketch/constraints-conflicting",
            message: "The edit conflicts with an existing dimension.",
          },
          ok: false,
        }),
      } as Partial<CadSketchInspectorProps>),
    });
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="sketch-dimension-error"]')
          ?.textContent,
      ).toContain("sketch/constraints-conflicting");
    });
  });

  it("shows the hint when no dimensional constraint is selected", () => {
    renderInspector();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(
      screen.getByText(CAD_SKETCH_INSPECTOR_LABELS.dimensionHint),
    ).toBeDefined();
  });

  it("renders the diagnostics feed with severities", () => {
    const { view } = renderInspector({
      diagnostics: [
        {
          code: "sketch/under-constrained",
          message: "The sketch has 7 degrees of freedom.",
          severity: "warning",
        },
      ],
    });
    const item = view.container.querySelector(
      '[data-sketch-diagnostic-code="sketch/under-constrained"]',
    );
    expect(item?.getAttribute("data-sketch-diagnostic-severity")).toBe(
      "warning",
    );
    expect(item?.textContent).toContain("7 degrees of freedom");
  });
});

describe("CadSketchInspector parameter-bound dimensions", () => {
  const NAMES = ["boardL", "boardW"];

  it("renders the expressionNumber field with the $-autocomplete when parameter names arrive", () => {
    renderInspector({
      dimension: {
        constraintId: "skcon_width",
        decimals: 3,
        unit: "mm",
        value: 60,
      },
      parameterNames: NAMES,
      selectedConstraintId: "skcon_width",
    });
    // A combobox-role text input (tokens must be typable), not the native
    // number spinner.
    const input = screen.getByRole("combobox");
    expect((input as HTMLInputElement).value).toBe("60");
    fireEvent.change(input, { target: { value: "$bo" } });
    expect(screen.getByRole("option", { name: "$boardL" })).toBeDefined();
    expect(screen.getByRole("option", { name: "$boardW" })).toBeDefined();
    // The live filter narrows by the partial after the `$`.
    fireEvent.change(input, { target: { value: "$rdl" } });
    expect(screen.getByRole("option", { name: "$boardL" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "$boardW" })).toBeNull();
  });

  it("keeps the plain number field when no parameter names arrive", () => {
    renderInspector({
      dimension: {
        constraintId: "skcon_width",
        decimals: 3,
        unit: "mm",
        value: 60,
      },
      selectedConstraintId: "skcon_width",
    });
    expect(screen.getByRole("spinbutton")).toBeDefined();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("submits a $name token as the string value", async () => {
    const { onEditDimension } = renderInspector({
      dimension: {
        constraintId: "skcon_width",
        decimals: 3,
        unit: "mm",
        value: 60,
      },
      parameterNames: NAMES,
      selectedConstraintId: "skcon_width",
    });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "$boardL" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(onEditDimension).toHaveBeenCalledWith("skcon_width", "$boardL");
    });
  });

  it("defaults to the bound dimension's $name token", () => {
    renderInspector({
      dimension: {
        constraintId: "skcon_width",
        decimals: 3,
        parameterName: "boardL",
        unit: "mm",
        value: 26,
      },
      parameterNames: NAMES,
      selectedConstraintId: "skcon_width",
    });
    const input = screen.getByRole("combobox");
    expect((input as HTMLInputElement).value).toBe("$boardL");
  });

  it("refuses an unknown parameter token at field level (no submit)", () => {
    const { onEditDimension } = renderInspector({
      dimension: {
        constraintId: "skcon_width",
        decimals: 3,
        unit: "mm",
        value: 60,
      },
      parameterNames: NAMES,
      selectedConstraintId: "skcon_width",
    });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "$nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onEditDimension).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Unknown parameter "nope".');
  });
});
