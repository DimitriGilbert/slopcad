/**
 * The expression-number field's component tests (Phase 21): the `$`-token
 * autocomplete opens only on an active `$` token, filters the configured
 * parameter names, commits the clicked row's full `$name` (mouse and
 * keyboard), and leaves the plain-number behavior untouched — numbers land
 * in the form value as numbers, not strings. Phase 30: the token grammar
 * admits the negated `-$name` form — the dropdown opens on `-$`, a clicked
 * row completes to `-$name` (the sign preserved), and the validator judges
 * the negated token by its name alone.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFormedible } from "../hooks/use-formedible";
import {
  activeExpressionNumberToken,
  expressionNumberProblem,
  expressionNumberTokenName,
  expressionNumberTokenNegated,
  filterExpressionNumberNames,
  insertExpressionNumberSelection,
} from "./expression-number-field";

afterEach(cleanup);

const NAMES = ["plateHeight", "caseHeight", "holeDepth"] as const;

interface ValueFormValues extends Record<string, unknown> {
  readonly distanceMm: number | string;
}

function ValueForm({
  onChange,
}: {
  readonly onChange: (value: number | string | undefined) => void;
}) {
  const form = useFormedible<ValueFormValues>({
    fields: [
      {
        name: "distanceMm",
        required: true,
        type: "expressionNumber",
        label: "Distance (mm)",
        suffix: "mm",
        expressionNumberConfig: { parameterNames: [...NAMES] },
        validation: (value) =>
          expressionNumberProblem(value, {
            parameterNames: [...NAMES],
            message: "Enter a finite number.",
          }),
      },
    ],
    formOptions: {
      defaultValues: { distanceMm: 10 },
      onSubmit: ({ value }) => {
        onChange(value.distanceMm);
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: "Create",
  });
  return <form.Form aria-label="value form" className="space-y-3" noValidate />;
}

function mount(onChange: (value: number | string | undefined) => void): void {
  render(<ValueForm onChange={onChange} />);
}

function fieldInput(): HTMLInputElement {
  const field = screen.getByLabelText(/^Distance \(mm\)/);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("the expression-number field is not an input");
  }
  return field;
}

describe("expression-number field: the $-token autocomplete", () => {
  it("shows no dropdown without an active $ token", () => {
    mount(() => {});
    const input = fieldInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on $, lists the configured names, and filters by the partial", () => {
    mount(() => {});
    const input = fieldInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "$" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listbox = screen.getByRole("listbox");
    expect(
      [...listbox.querySelectorAll("[role=option]")].map(
        (option) => option.textContent,
      ),
    ).toEqual(["$plateHeight", "$caseHeight", "$holeDepth"]);
    fireEvent.change(input, { target: { value: "$he" } });
    const filtered = screen.getByRole("listbox");
    expect(
      [...filtered.querySelectorAll("[role=option]")].map(
        (option) => option.textContent,
      ),
    ).toEqual(["$plateHeight", "$caseHeight"]);
  });

  it("shows no dropdown when a $ token does not start the value", () => {
    mount(() => {});
    const input = fieldInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "10 + $" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("commits the clicked row's full $name into the field and the form value", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit);
    const input = fieldInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "$ca" } });
    fireEvent.click(screen.getByRole("option", { name: "$caseHeight" }));
    expect(input.value).toBe("$caseHeight");
    // The committed token is the form value verbatim (submit blocked until
    // the form's own submit event; drive it through the form element).
    const form = input.closest("form");
    if (form === null) throw new Error("the value form is absent");
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSubmit).toHaveBeenCalledWith("$caseHeight");
  });

  it("commits with the keyboard: ArrowDown + Enter, and Escape closes", () => {
    mount(() => {});
    const input = fieldInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "$" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("$holeDepth");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(input, { target: { value: "$h" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the number semantics: plain numbers land as numbers", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit);
    const input = fieldInput();
    expect(input.value).toBe("10");
    fireEvent.change(input, { target: { value: "25" } });
    const form = input.closest("form");
    if (form === null) throw new Error("the value form is absent");
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSubmit).toHaveBeenCalledWith(25);
  });

  it("opens on a negated token and completes the clicked row to -$name", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit);
    const input = fieldInput();
    fireEvent.focus(input);
    // Typing `-$` opens the same dropdown (the partial is empty — all names).
    fireEvent.change(input, { target: { value: "-$" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.change(input, { target: { value: "-$ca" } });
    // Clicking a suggestion inserts the sign with the name.
    fireEvent.click(screen.getByRole("option", { name: "$caseHeight" }));
    expect(input.value).toBe("-$caseHeight");
    const form = input.closest("form");
    if (form === null) throw new Error("the value form is absent");
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSubmit).toHaveBeenCalledWith("-$caseHeight");
  });

  it("shows no dropdown when a negated token does not start the value", () => {
    mount(() => {});
    const input = fieldInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "10 -$" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("expression-number field: the value validation", () => {
  it("refuses an unknown parameter by name and passes known ones", () => {
    const validation = {
      parameterNames: [...NAMES],
      message: "Enter a finite number.",
    };
    expect(expressionNumberProblem("$nope", validation)).toBe(
      'Unknown parameter "nope".',
    );
    expect(expressionNumberProblem("$holeDepth", validation)).toBeNull();
    expect(expressionNumberProblem("$nope!", validation)).toBe(
      "Enter a finite number.",
    );
    expect(expressionNumberProblem(8, validation)).toBeNull();
    expect(expressionNumberProblem(Number.NaN, validation)).toBe(
      "Enter a finite number.",
    );
    expect(expressionNumberProblem(undefined, validation)).toBe(
      "Enter a finite number.",
    );
  });

  it("judges a negated token by its name alone, sign-stripped", () => {
    const validation = {
      parameterNames: [...NAMES],
      message: "Enter a finite number.",
    };
    expect(expressionNumberProblem("-$holeDepth", validation)).toBeNull();
    expect(expressionNumberProblem("-$nope", validation)).toBe(
      'Unknown parameter "nope".',
    );
    expect(expressionNumberProblem("-$nope!", validation)).toBe(
      "Enter a finite number.",
    );
  });

  it("honors a stricter numeric gate for literals only", () => {
    const validation = {
      parameterNames: [...NAMES],
      acceptsNumber: (value: number) => Number.isFinite(value) && value > 0,
      message: "Enter a strictly positive number.",
    };
    expect(expressionNumberProblem(-2, validation)).toBe(
      "Enter a strictly positive number.",
    );
    expect(expressionNumberProblem("$holeDepth", validation)).toBeNull();
  });
});

describe("expression-number field: the token primitives", () => {
  it("detects the active token at the caret and rejects non-token carets", () => {
    expect(activeExpressionNumberToken("$he", 3)).toEqual({
      start: 0,
      end: 3,
      partial: "he",
      negated: false,
    });
    expect(activeExpressionNumberToken("10 + $", 6)).toEqual({
      start: 5,
      end: 6,
      partial: "",
      negated: false,
    });
    expect(activeExpressionNumberToken("12", 2)).toBeNull();
    expect(activeExpressionNumberToken("$he ok", 6)).toBeNull();
  });

  it("anchors a negated token at its sign and reports it", () => {
    expect(activeExpressionNumberToken("-$he", 4)).toEqual({
      start: 0,
      end: 4,
      partial: "he",
      negated: true,
    });
    expect(activeExpressionNumberToken("-$", 2)).toEqual({
      start: 0,
      end: 2,
      partial: "",
      negated: true,
    });
    // The span starts at the `-`, so the field's start-of-value rule sees
    // the whole token.
    expect(activeExpressionNumberToken("10 -$", 5)?.start).toBe(3);
  });

  it("inserts a selection at the token position, preserving the tail", () => {
    const token = activeExpressionNumberToken("$ca + 4", 3);
    if (token === null) throw new Error("the token is absent");
    expect(
      insertExpressionNumberSelection("$ca + 4", token, "caseHeight"),
    ).toBe("$caseHeight + 4");
  });

  it("preserves the typed sign in an inserted negated selection", () => {
    const token = activeExpressionNumberToken("-$ca", 4);
    if (token === null) throw new Error("the token is absent");
    expect(insertExpressionNumberSelection("-$ca", token, "caseHeight")).toBe(
      "-$caseHeight",
    );
  });

  it("names a token regardless of sign and flags the negated form", () => {
    expect(expressionNumberTokenName("$holeDepth")).toBe("holeDepth");
    expect(expressionNumberTokenName("-$holeDepth")).toBe("holeDepth");
    expect(expressionNumberTokenName("10")).toBeNull();
    expect(expressionNumberTokenNegated("-$holeDepth")).toBe(true);
    expect(expressionNumberTokenNegated("$holeDepth")).toBe(false);
    expect(expressionNumberTokenNegated("10")).toBe(false);
    expect(expressionNumberTokenNegated("-$nope!")).toBe(false);
  });

  it("filters names by substring, case-insensitively, capped", () => {
    expect(filterExpressionNumberNames([...NAMES], "HEIGHT", 8)).toEqual([
      "plateHeight",
      "caseHeight",
    ]);
    expect(filterExpressionNumberNames([...NAMES], "", 2)).toEqual([
      "plateHeight",
      "caseHeight",
    ]);
  });
});
