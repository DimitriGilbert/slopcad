/**
 * The feature forms' component tests (Phase 40 fix): the thread form's
 * designation picker FILLS the linked numbers through Formedible's change
 * hook — picking a designation copies the ISO table row's major diameter
 * and pitch into the editable number fields, a hand edit after a pick
 * persists, and the submitted specification carries the five numbers only
 * (the designation is picker state, never persisted feature data).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HoleFormValues } from "./feature-forms";
import type { StructuredHoleSubmission } from "./hole-dialog";
import type { ThreadCutInput } from "./thread";

import {
  CurveFeatureForm,
  HoleFeatureForm,
  MirrorFeatureForm,
  PatternFeatureForm,
  PatternPathFeatureForm,
  ThreadFeatureForm,
} from "./feature-forms";

afterEach(cleanup);

/** The designation select's trigger (the form's first select). */
function designationTrigger(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>(
    "[data-slot=select-trigger]",
  );
  if (trigger === null) throw new Error("the designation trigger is absent");
  return trigger;
}

/** Reads a number field's current input value. */
function numberFieldValue(label: RegExp): string {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`the field ${String(label)} is not a number input`);
  }
  return field.value;
}

/** Edits a number field's value. */
function editNumberField(label: RegExp, value: string): void {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`the field ${String(label)} is not a number input`);
  }
  fireEvent.change(field, { target: { value } });
}

/**
 * Clicks the designation option carrying the given designation text.
 * Base UI's select items commit on REAL mouse clicks only (a pointerdown
 * must arm the item first — synthetic `detail: 0` clicks stay tied to the
 * highlight state), so the helper drives the pointerdown + click pair.
 */
async function pickDesignation(designation: string): Promise<void> {
  fireEvent.click(designationTrigger());
  await waitFor(() => {
    expect(document.querySelector("[data-slot=select-item]")).not.toBeNull();
  });
  const item = [...document.querySelectorAll("[data-slot=select-item]")].find(
    (element) => element.textContent?.startsWith(`${designation} —`) === true,
  );
  if (item === undefined) {
    throw new Error(`the designation option ${designation} is absent`);
  }
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item, { detail: 1, pointerType: "mouse" });
}

describe("ThreadFeatureForm: the designation picker fills the linked numbers", () => {
  it("fills major diameter and pitch on a pick, keeps hand edits, and never persists the designation", async () => {
    const onThread = vi.fn<(specification: ThreadCutInput) => void>();
    render(<ThreadFeatureForm onThread={onThread} />);

    // The defaults are the M6 row: 6 / 1.
    expect(numberFieldValue(/^Major diameter/)).toBe("6");
    expect(numberFieldValue(/^Pitch/)).toBe("1");

    // Pick M8 → the linked fields become the table row's 8 / 1.25.
    await pickDesignation("M8");
    await waitFor(() => expect(numberFieldValue(/^Major diameter/)).toBe("8"));
    await waitFor(() => expect(numberFieldValue(/^Pitch/)).toBe("1.25"));

    // A hand edit after the pick persists (the fill is tied to
    // designation CHANGES, not to every field change).
    editNumberField(/^Major diameter/, "7.5");
    await waitFor(() =>
      expect(numberFieldValue(/^Major diameter/)).toBe("7.5"),
    );
    // Editing the number did not refill anything.
    expect(numberFieldValue(/^Pitch/)).toBe("1.25");

    // Submit: the specification carries the five numbers only — no
    // designation key ever crosses the seam.
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onThread).toHaveBeenCalledTimes(1));
    const specification = onThread.mock.calls[0]?.[0];
    expect(specification).toBeDefined();
    if (specification === undefined) return;
    expect(specification).toEqual({
      majorDiameterMm: 7.5,
      pitchMm: 1.25,
      lengthMm: 6,
      mode: 1,
      handedness: 1,
      axis: 3,
    });
    expect(Object.keys(specification)).not.toContain("designation");
  });

  it("refills the numbers on every NEW pick (fine rows overwrite a hand edit)", async () => {
    const onThread = vi.fn<(specification: ThreadCutInput) => void>();
    render(<ThreadFeatureForm onThread={onThread} />);

    // Pick the fine M8x1 row: 8 / 1.
    await pickDesignation("M8x1");
    await waitFor(() => expect(numberFieldValue(/^Major diameter/)).toBe("8"));

    // A hand edit, then a NEW designation pick: the fill wins again —
    // the picker is the documented source while the user is picking.
    editNumberField(/^Major diameter/, "9");
    await waitFor(() => expect(numberFieldValue(/^Major diameter/)).toBe("9"));
    await pickDesignation("M12");
    await waitFor(() => expect(numberFieldValue(/^Major diameter/)).toBe("12"));
    await waitFor(() => expect(numberFieldValue(/^Pitch/)).toBe("1.75"));
  });
});

// ---------------------------------------------------------------------------
// The structured hole dialog (Phase 42)
// ---------------------------------------------------------------------------

/** The select triggers in form order (type, designation, …). */
function selectTriggers(): readonly HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-slot=select-trigger]"),
  ];
}

/** Opens the indexed select and clicks the option starting with `text`. */
async function pickSelectOption(
  triggerIndex: number,
  optionText: string,
): Promise<void> {
  const trigger = selectTriggers()[triggerIndex];
  if (trigger === undefined) {
    throw new Error(`the select trigger ${String(triggerIndex)} is absent`);
  }
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(document.querySelector("[data-slot=select-item]")).not.toBeNull();
  });
  const item = [...document.querySelectorAll("[data-slot=select-item]")].find(
    (element) => element.textContent?.startsWith(optionText) === true,
  );
  if (item === undefined) {
    throw new Error(`the select option ${optionText} is absent`);
  }
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.click(item, { detail: 1, pointerType: "mouse" });
}

describe("HoleFeatureForm: the schema-driven structured hole dialog", () => {
  it("renders the straight type's schema fields and hides the other types'", () => {
    const onHole = vi.fn<(submission: StructuredHoleSubmission) => void>();
    render(<HoleFeatureForm datumAxes={[]} onHole={onHole} sketches={[]} />);
    // The straight type's load-bearing fields are present…
    expect(screen.getByLabelText(/^Diameter/)).toBeDefined();
    expect(screen.getByLabelText(/^Depth/)).toBeDefined();
    expect(screen.getByLabelText(/Drill tip angle/)).toBeDefined();
    // …and every other type's are conditionally hidden (the schema drives
    // the field list — counterbore/countersink/taper/thread fields absent
    // from the rendered form until their type carries them).
    expect(screen.queryByLabelText(/Counterbore/)).toBeNull();
    expect(screen.queryByLabelText(/Countersink/)).toBeNull();
    expect(screen.queryByLabelText(/Taper angle/)).toBeNull();
    expect(screen.queryByLabelText(/Thread major/)).toBeNull();
  });

  it("reveals the counterbore fields when the type selects them", async () => {
    const onHole = vi.fn<(submission: StructuredHoleSubmission) => void>();
    render(<HoleFeatureForm datumAxes={[]} onHole={onHole} sketches={[]} />);
    expect(screen.queryByLabelText(/Counterbore/)).toBeNull();
    await pickSelectOption(0, "Counterbore");
    await waitFor(() => {
      expect(screen.getByLabelText(/Counterbore Ø/)).toBeDefined();
    });
    expect(screen.getByLabelText(/Counterbore depth/)).toBeDefined();
    // The taper fields stay hidden.
    expect(screen.queryByLabelText(/Taper angle/)).toBeNull();
  });

  it("fills the threaded type's numbers from the ISO designation picker", async () => {
    const onHole = vi.fn<(submission: StructuredHoleSubmission) => void>();
    render(<HoleFeatureForm datumAxes={[]} onHole={onHole} sketches={[]} />);
    await pickSelectOption(0, "Threaded");
    await waitFor(() => {
      expect(screen.getByLabelText(/Thread major/)).toBeDefined();
    });
    // With the threaded type selected, the designation select is the
    // SECOND trigger; picking M10 copies the table row's 10 / 1.5.
    await pickSelectOption(1, "M10");
    await waitFor(() => expect(numberFieldValue(/Thread major/)).toBe("10"));
    await waitFor(() => expect(numberFieldValue(/Thread pitch/)).toBe("1.5"));
  });

  it("submits the structured specification with positions and axis, never the designation", async () => {
    const onHole = vi.fn<(submission: StructuredHoleSubmission) => void>();
    const onValuesChange = vi.fn<(values: HoleFormValues) => void>();
    render(
      <HoleFeatureForm
        datumAxes={[]}
        onHole={onHole}
        onValuesChange={onValuesChange}
        sketches={[]}
      />,
    );
    // Every change reaches the preview ghost's input.
    editNumberField(/^Diameter/, "5");
    await waitFor(() =>
      expect(onValuesChange).toHaveBeenCalledWith(
        expect.objectContaining({ diameterMm: 5 }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onHole).toHaveBeenCalledTimes(1));
    const submission = onHole.mock.calls[0]?.[0];
    expect(submission).toBeDefined();
    if (submission === undefined) return;
    expect(submission.spec.type).toBe(1);
    expect(submission.spec.diameterMm).toBe(5);
    expect(submission.spec.depthMm).toBe(6);
    expect(submission.positionXMm).toBe(15);
    expect(submission.positionYMm).toBe(10);
    expect(submission.axis).toBe(3);
    expect(submission.positionsSketchId).toBeNull();
    expect(submission.datumAxisId).toBeNull();
  });
});

describe("PatternFeatureForm: the pattern editor's legs and skips", () => {
  it("submits the default leg with no skips", async () => {
    const onPattern = vi.fn<
      (specification: {
        readonly legs: readonly {
          readonly directionDeg: number;
          readonly count: number;
          readonly spacingMm: number;
        }[];
        readonly skips: readonly number[];
      }) => void
    >();
    render(<PatternFeatureForm onPattern={onPattern} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onPattern).toHaveBeenCalledTimes(1));
    expect(onPattern.mock.calls[0]?.[0]).toEqual({
      legs: [{ directionDeg: 0, count: 3, spacingMm: 20 }],
      skips: [],
    });
  });

  it("adds a skip row and carries the ordinal into the submission", async () => {
    const onPattern = vi.fn<
      (specification: {
        readonly legs: readonly {
          readonly directionDeg: number;
          readonly count: number;
          readonly spacingMm: number;
        }[];
        readonly skips: readonly number[];
      }) => void
    >();
    render(<PatternFeatureForm onPattern={onPattern} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip an instance" }));
    // The new skip row's default ordinal (1) rides the submission.
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onPattern).toHaveBeenCalledTimes(1));
    expect(onPattern.mock.calls[0]?.[0]).toEqual({
      legs: [{ directionDeg: 0, count: 3, spacingMm: 20 }],
      skips: [1],
    });
  });
});

describe("PatternPathFeatureForm: the path picker and orientation", () => {
  it("submits the picked sketch with the numbers and the orientation option", async () => {
    const onPatternPath =
      vi.fn<
        (specification: {
          readonly sketchId: string;
          readonly count: number;
          readonly spacingMm: number;
          readonly orientation: number;
        }) => void
      >();
    render(
      <PatternPathFeatureForm
        onPatternPath={onPatternPath}
        sketches={[{ id: "skd_path", name: "the path" }]}
      />,
    );
    expect(numberFieldValue(/^Instances/)).toBe("4");
    expect(numberFieldValue(/^Spacing along the path/)).toBe("10");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onPatternPath).toHaveBeenCalledTimes(1));
    expect(onPatternPath.mock.calls[0]?.[0]).toEqual({
      sketchId: "skd_path",
      count: 4,
      spacingMm: 10,
      orientation: 1,
    });
  });
});

describe("MirrorFeatureForm: the plane picker and merge option", () => {
  it("submits the picked plane with the standalone default", async () => {
    const onMirror =
      vi.fn<
        (specification: {
          readonly datumPlaneId: string;
          readonly merge: number;
        }) => void
      >();
    render(
      <MirrorFeatureForm
        datumPlanes={[{ id: "dtm_plane", name: "the plane" }]}
        onMirror={onMirror}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onMirror).toHaveBeenCalledTimes(1));
    expect(onMirror.mock.calls[0]?.[0]).toEqual({
      datumPlaneId: "dtm_plane",
      merge: 1,
    });
  });
});

describe("CurveFeatureForm: the curve module's field list (Phase 47)", () => {
  /** Reads a text field's current input value. */
  function textFieldValue(label: RegExp): string {
    const field = screen.getByLabelText(label);
    if (!(field instanceof HTMLInputElement)) {
      throw new Error(`the field ${String(label)} is not a text input`);
    }
    return field.value;
  }

  it("renders every CURVE_FORM_FIELDS field with the module's defaults", () => {
    const onCreateCurve = vi.fn<(authoring: unknown) => void>();
    render(<CurveFeatureForm onCreateCurve={onCreateCurve} />);
    // The field list is the curve module's single source of truth: the
    // name, the kind select, the points textarea, the helix numbers, the
    // handedness select, and the equation fields all render.
    expect(textFieldValue(/^Name/)).toBe("curve");
    expect(textFieldValue(/^Helix radius/)).toBe("6");
    expect(textFieldValue(/^t min$/)).toBe("0");
    expect(textFieldValue(/^x\(t\)$/)).toBe("10mm * t");
    const points = screen.getByLabelText(/Points \(x, y, z per line\)/);
    expect(points).toBeDefined();
    expect((points as HTMLTextAreaElement).value.startsWith("0, 0, 0")).toBe(
      true,
    );
  });

  it("submits the authoring verbatim — the engine re-validates through the curve module", async () => {
    const onCreateCurve = vi.fn<(authoring: unknown) => void>();
    render(<CurveFeatureForm onCreateCurve={onCreateCurve} />);
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "spine guide" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create curve" }));
    await waitFor(() => expect(onCreateCurve).toHaveBeenCalledTimes(1));
    const submitted = onCreateCurve.mock.calls[0]?.[0] as {
      readonly name: string;
      readonly kind: string;
      readonly pointsText: string;
    };
    expect(submitted.name).toBe("spine guide");
    expect(submitted.kind).toBe("interpolated-spline");
    expect(submitted.pointsText).toContain("20, 0, 20");
  });
});
