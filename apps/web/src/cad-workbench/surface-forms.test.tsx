/**
 * The Phase 49 surface tab's form tests (component level): each surface
 * form submits the structured payload its engine action commits — the
 * create-sheet form's datum binding and u/v bounds, the trim form's
 * target/tool/keep-side, the thicken form's wall and side, the knit
 * form's ordered sheet list and sewing tolerance, and the offset form's
 * signed distance. Selects follow Base UI's real-click commit discipline
 * (pointerdown arms, click with detail commits — the thread form's
 * precedent); every number rides a plain controlled input.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatumId } from "@slopcad/cad-core";

import {
  CreateSheetForm,
  KnitSurfaceForm,
  OffsetSurfaceForm,
  ThickenSurfaceForm,
  TrimSurfaceForm,
} from "./feature-forms";

afterEach(cleanup);

const DATUMS = [
  { id: "dtm_xy", name: "Top plane" },
  { id: "dtm_xz", name: "Front plane" },
];

const SHEETS = [
  { id: "body_surface", name: "surface 1" },
  { id: "body_surface2", name: "surface 2" },
];

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
 * Opens the indexed select (in DOM order) and commits the option starting
 * with `optionText` (Base UI commits on REAL mouse clicks only — the
 * pointerdown + click pair, the thread form's precedent).
 */
async function pickSelectOption(
  triggerIndex: number,
  optionText: string,
): Promise<void> {
  const triggers = [
    ...document.querySelectorAll<HTMLElement>("[data-slot=select-trigger]"),
  ];
  const trigger = triggers[triggerIndex];
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

describe("CreateSheetForm (Phase 49 surface tab)", () => {
  it("binds the picked datum and submits the u/v bounds", async () => {
    const onCreateSheet =
      vi.fn<
        (submission: {
          readonly datumId: DatumId;
          readonly uMinMm: number | string;
          readonly uMaxMm: number | string;
          readonly vMinMm: number | string;
          readonly vMaxMm: number | string;
        }) => void
      >();
    render(
      <CreateSheetForm
        datums={DATUMS}
        onCreateSheet={onCreateSheet}
        parameterNames={[]}
      />,
    );

    // The defaults: first datum, a 30 × 20 patch.
    expect(numberFieldValue(/^u min/)).toBe("0");
    expect(numberFieldValue(/^u max/)).toBe("30");
    expect(numberFieldValue(/^v min/)).toBe("0");
    expect(numberFieldValue(/^v max/)).toBe("20");

    await pickSelectOption(0, "Front plane");
    editNumberField(/^u max/, "40");
    editNumberField(/^v max/, "25");

    fireEvent.click(screen.getByRole("button", { name: "Create base sheet" }));
    await waitFor(() => expect(onCreateSheet).toHaveBeenCalledTimes(1));
    const submission = onCreateSheet.mock.calls[0]?.[0];
    expect(submission).toBeDefined();
    if (submission === undefined) return;
    expect(submission.uMinMm).toBe(0);
    expect(submission.uMaxMm).toBe(40);
    expect(submission.vMinMm).toBe(0);
    expect(submission.vMaxMm).toBe(25);
    expect(String(submission.datumId)).toBe("dtm_xz");
  });
});

describe("TrimSurfaceForm (Phase 49 surface tab)", () => {
  it("defaults to the first two sheets with keep-inside, and flips the keep side", async () => {
    const onTrim =
      vi.fn<
        (submission: {
          readonly sheetId: string;
          readonly toolId: string;
          readonly keepInside: 0 | 1;
        }) => void
      >();
    render(<TrimSurfaceForm sheets={SHEETS} onTrim={onTrim} />);

    fireEvent.click(screen.getByRole("button", { name: "Trim sheet" }));
    await waitFor(() => expect(onTrim).toHaveBeenCalledTimes(1));
    expect(onTrim.mock.calls[0]?.[0]).toEqual({
      sheetId: "body_surface",
      toolId: "body_surface2",
      keepInside: 1,
    });
  });

  it("submits the cut-away variant on the keep pick", async () => {
    const onTrim =
      vi.fn<
        (submission: {
          readonly sheetId: string;
          readonly toolId: string;
          readonly keepInside: 0 | 1;
        }) => void
      >();
    render(<TrimSurfaceForm sheets={SHEETS} onTrim={onTrim} />);

    await pickSelectOption(2, "Cut the tool's region away");
    fireEvent.click(screen.getByRole("button", { name: "Trim sheet" }));
    await waitFor(() => expect(onTrim).toHaveBeenCalledTimes(1));
    expect(onTrim.mock.calls[0]?.[0].keepInside).toBe(0);
  });
});

describe("ThickenSurfaceForm (Phase 49 surface tab)", () => {
  it("submits the wall thickness and the picked side", async () => {
    const onThickenSurface =
      vi.fn<
        (submission: {
          readonly sheetId: string;
          readonly thicknessMm: number | string;
          readonly side: 1 | -1;
        }) => void
      >();
    render(
      <ThickenSurfaceForm
        sheets={SHEETS}
        onThickenSurface={onThickenSurface}
        parameterNames={[]}
      />,
    );

    editNumberField(/^Thickness/, "3.5");
    await pickSelectOption(1, "Against the sheet's normals");
    fireEvent.click(screen.getByRole("button", { name: "Thicken sheet" }));
    await waitFor(() => expect(onThickenSurface).toHaveBeenCalledTimes(1));
    expect(onThickenSurface.mock.calls[0]?.[0]).toEqual({
      sheetId: "body_surface",
      thicknessMm: 3.5,
      side: -1,
    });
  });
});

describe("KnitSurfaceForm (Phase 49 surface tab)", () => {
  it("submits the ordered sheet list and the sewing tolerance", async () => {
    const onKnit =
      vi.fn<
        (submission: {
          readonly sheetIds: readonly string[];
          readonly toleranceMm: number | string;
        }) => void
      >();
    render(
      <KnitSurfaceForm sheets={SHEETS} onKnit={onKnit} parameterNames={[]} />,
    );

    // The defaults: both sheets pre-listed, the 0.001 mm sewing tolerance.
    expect(numberFieldValue(/^Sewing tolerance/)).toBe("0.001");
    editNumberField(/^Sewing tolerance/, "0.01");
    fireEvent.click(screen.getByRole("button", { name: "Knit sheets" }));
    await waitFor(() => expect(onKnit).toHaveBeenCalledTimes(1));
    expect(onKnit.mock.calls[0]?.[0]).toEqual({
      sheetIds: ["body_surface", "body_surface2"],
      toleranceMm: 0.01,
    });
  });
});

describe("OffsetSurfaceForm (Phase 49 surface tab)", () => {
  it("submits the target sheet and the signed distance", async () => {
    const onOffset =
      vi.fn<
        (submission: {
          readonly sheetId: string;
          readonly distanceMm: number | string;
        }) => void
      >();
    render(
      <OffsetSurfaceForm
        sheets={SHEETS}
        onOffset={onOffset}
        parameterNames={[]}
      />,
    );

    editNumberField(/^Offset distance/, "-4");
    fireEvent.click(screen.getByRole("button", { name: "Offset sheet" }));
    await waitFor(() => expect(onOffset).toHaveBeenCalledTimes(1));
    expect(onOffset.mock.calls[0]?.[0]).toEqual({
      sheetId: "body_surface",
      distanceMm: -4,
    });
  });
});
