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
import type { ThreadCutInput } from "./thread";

import { ThreadFeatureForm } from "./feature-forms";

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
