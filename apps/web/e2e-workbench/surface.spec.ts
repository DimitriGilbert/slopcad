/**
 * Phase 49 surface-workflow e2e — the roadmap's validation gate on the
 * OCCT composition (`/workbench-complete-occt`): the surface tab authors a
 * BASE SHEET on a datum plane, TRIMS it by a second sheet, and THICKENS
 * the trimmed sheet into a solid whose settled volume lands on the
 * analytic value. Every operation routes through the COMMAND MENU (Ctrl+K
 * → query → Enter — the surface verbs yield their width below 1800 px,
 * the toolbar's yielding-tier discipline, so the palette is the
 * always-reachable path) and every settle is numeric: the dispatch
 * anchor + settle protocol prove the pixels belong to the numbers.
 *
 * The analytic chain (all planar, so exact):
 *  - base sheet: a 30 × 20 plane patch (area 600 mm², no volume);
 *  - tool sheet: a 10 × 200 crossing band (u 10..20, v −100..100);
 *  - trim keep-inside: the 10 × 20 common band — exactly 200 mm²;
 *  - thicken ×2 mm: area × thickness = 400 mm³, the planar developable's
 *    exact value (no curvature term).
 *
 * The from-behind journey (Phase 48's carried render gate): the settled
 * sheet viewed from BELOW — a front-face-only material would cull every
 * triangle and leave the canvas empty; the `openShell` DoubleSide
 * discipline renders BOTH sides. The assertion is raster: the captured
 * canvas must carry a healthy population of non-background pixels.
 */

import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";

const ROOT = "workbench-complete-occt-root";
const VIEWPORT_ID = "workbench-complete-viewport";
const CANVAS = `#${VIEWPORT_ID} canvas`;
const DIALOG = '[data-testid="feature-form-dialog"]';

/** Relative volume tolerance (display rounding plus kernel noise). */
const VOLUME_REL_TOLERANCE = 0.002;

/** The analytic chain's numbers (mm² / mm³). */
const TRIMMED_AREA = 10 * 20;
const THICKENED_VOLUME = TRIMMED_AREA * 2;

/** The raster bar the from-behind capture must clear (pixels). */
const MIN_SHEET_PIXELS = 5_000;

/** Saves an artifact under the workbench artifacts directory. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/workbench", { recursive: true });
  await writeFile(`e2e-artifacts/workbench/${name}`, bytes);
}

/** Opens a feature dialog through the COMMAND MENU (Ctrl+K → query → Enter). */
async function openDialogViaCommandMenu(
  page: Page,
  query: string,
): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-command-menu-open",
    "true",
  );
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
  await expect(page.locator(DIALOG)).toBeVisible();
}

/** Submits the open feature dialog and waits for the scene re-dispatch. */
async function submitDialogAndSettle(
  page: Page,
  name: string,
): Promise<string> {
  const before = await dispatchedCount(page, ROOT);
  await page.locator(DIALOG).getByRole("button", { name }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  return waitForSettledScene(page, ROOT, { afterDispatch: before });
}

/** Edits one labeled number field inside the open dialog. */
async function editDialogNumber(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  await page.locator(DIALOG).getByLabel(label).fill(value);
}

/** Picks one option in the dialog's nth select (Base UI real-click commit). */
async function pickDialogOption(
  page: Page,
  triggerIndex: number,
  optionText: string,
): Promise<void> {
  await page.locator(`${DIALOG} [role="combobox"]`).nth(triggerIndex).click();
  await page.getByRole("option", { name: optionText }).click();
}

/**
 * Counts the canvas pixels that differ from the capture's own corner
 * background color (decoded in-page — the same browser renderer that
 * produced the PNG reads it back, so no spec-side decoder exists).
 * A culled sheet leaves a uniform capture; a rendered one thousands.
 */
async function countNonBackgroundPixels(
  page: Page,
  png: Buffer,
): Promise<number> {
  return page.evaluate((base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const decode = async (): Promise<ImageData> => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("decoding captures requires a 2D canvas context");
      }
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    return decode().then((image) => {
      const channel = (offset: number): number => image.data[offset] ?? 0;
      const corner = (
        x: number,
        y: number,
      ): readonly [number, number, number] => {
        const offset = (y * image.width + x) * 4;
        return [channel(offset), channel(offset + 1), channel(offset + 2)];
      };
      // The background is sampled from the four corners; a pixel differs
      // when any channel drifts past the AA tolerance.
      const backgrounds = [
        corner(0, 0),
        corner(image.width - 1, 0),
        corner(0, image.height - 1),
        corner(image.width - 1, image.height - 1),
      ];
      let differing = 0;
      for (let index = 0; index < image.width * image.height; index += 1) {
        const offset = index * 4;
        const [r, g, b] = [
          channel(offset),
          channel(offset + 1),
          channel(offset + 2),
        ];
        const isBackground = backgrounds.some(
          (background) =>
            Math.abs(r - background[0]) <= 8 &&
            Math.abs(g - background[1]) <= 8 &&
            Math.abs(b - background[2]) <= 8,
        );
        if (!isBackground) differing += 1;
      }
      return differing;
    });
  }, png.toString("base64"));
}

test("surface: base sheet → trim → thicken lands on the analytic 400 mm³, and the sheet renders from behind", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/workbench-complete-occt");
  await waitForSettledScene(page, ROOT);
  const dismiss = page.locator('[data-testid="workbench-sketch-hint-dismiss"]');
  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  // The base datum plane (identity frame — the patch binds to it).
  await openDialogViaCommandMenu(page, "Create datum geometry");
  await editDialogNumber(page, "Normal z", "1");
  await editDialogNumber(page, "In-plane x x", "1");
  await page
    .locator(DIALOG)
    .getByRole("button", { name: "Create datum" })
    .click();
  await expect(page.locator(DIALOG)).toBeHidden();

  // The base sheet: 30 × 20 plane patch on the datum (the form's defaults).
  await openDialogViaCommandMenu(page, "base sheet");
  const created = await submitDialogAndSettle(page, "Create base sheet");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "sheet",
  );
  await page.mouse.move(4, 4);
  await saveArtifact(
    "surface-create-sheet.png",
    await page.locator(`#${VIEWPORT_ID}`).screenshot(),
  );
  expect(created.length).toBeGreaterThan(0);

  // The tool sheet: a crossing band, u 10..20, v −100..100.
  await openDialogViaCommandMenu(page, "base sheet");
  await editDialogNumber(page, "u min (mm)", "10");
  await editDialogNumber(page, "u max (mm)", "20");
  await editDialogNumber(page, "v min (mm)", "-100");
  await editDialogNumber(page, "v max (mm)", "100");
  await submitDialogAndSettle(page, "Create base sheet");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "sheet",
  );

  // The trim: keep the tool's region (inside) — the exact 10 × 20 band.
  await openDialogViaCommandMenu(page, "Trim one sheet");
  // Defaults: target "surface 1", tool "surface 2", keep inside.
  await submitDialogAndSettle(page, "Trim sheet");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "sheet",
  );
  await page.mouse.move(4, 4);
  await saveArtifact(
    "surface-trim-sheet.png",
    await page.locator(`#${VIEWPORT_ID}`).screenshot(),
  );

  // FROM BEHIND (the carried Phase 48 render gate) — taken NOW, while the
  // OPEN trimmed sheet is the active scene: the bottom standard view puts
  // the camera under the plane, and a front-face-only material would cull
  // every triangle and leave the canvas empty. (After the thicken the
  // scene is a closed solid whose bottom face is a front face — the gate
  // would pass vacuously there.) The openShell → DoubleSide discipline
  // must render BOTH sides.
  await page.locator('[data-testid="view-cube-face-bottom"]').click();
  await expect
    .poll(async () =>
      page
        .locator(`#${VIEWPORT_ID} [data-camera-mode]`)
        .first()
        .getAttribute("data-camera-mode"),
    )
    .toBe("user");
  // Flush the camera commit through the compositor (a clipped screenshot
  // forces a frame — the settle lamp fires once per projection change, so
  // the re-render cannot be awaited on it), park the pointer off every
  // surface, then take the raster proof.
  await page.mouse.move(4, 4);
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await page.waitForTimeout(500);
  const png = await page.locator(CANVAS).screenshot();
  await saveArtifact("surface-sheet-from-behind.png", png);
  const sheetPixels = await countNonBackgroundPixels(page, png);
  expect(
    sheetPixels,
    `from behind, ${String(sheetPixels)} non-background pixels cleared the bar — a culled backface leaves a uniform canvas`,
  ).toBeGreaterThanOrEqual(MIN_SHEET_PIXELS);

  // The thicken: the trimmed sheet × 2 mm → exactly 400 mm³.
  await openDialogViaCommandMenu(page, "Thicken a sheet");
  await pickDialogOption(page, 0, "trimmed");
  await submitDialogAndSettle(page, "Thicken sheet");
  const volume = await waitForSettledScene(page, ROOT);
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "sheet",
  );
  expect(
    Math.abs(Number(volume) - THICKENED_VOLUME),
    `thickened ${volume} vs analytic ${String(THICKENED_VOLUME)}`,
  ).toBeLessThanOrEqual(THICKENED_VOLUME * VOLUME_REL_TOLERANCE);

  // The timeline carries the whole surface history as valid features.
  const timeline = JSON.parse(
    (await page.locator(`#${ROOT}`).getAttribute("data-feature-timeline")) ??
      "{}",
  ) as { entries: { kind: string; status: string }[] };
  const kinds = timeline.entries.map((entry) => entry.kind);
  for (const kind of ["create-sheet", "trim-surface", "thicken-surface"]) {
    expect(kinds).toContain(kind);
    expect(timeline.entries.find((entry) => entry.kind === kind)?.status).toBe(
      "valid",
    );
  }
  await page.mouse.move(4, 4);
  await saveArtifact(
    "surface-thicken-sheet.png",
    await page.locator(`#${VIEWPORT_ID}`).screenshot(),
  );
});
