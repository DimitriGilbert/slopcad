import { expect, test } from "@playwright/test";

import {
  previewCanvas,
  ROOT,
  saveArtifact,
  sha256,
  waitForSettledPreview,
} from "./helpers";

/**
 * Phase 32 component-preview e2e — the phase-level browser gate, one
 * test group per reusable component (production build, SwiftShader,
 * fixed 1280×720 DPR-1, one worker). Each group proves:
 *
 *  - BUILD: the real Manifold worker builds the component through the
 *    package's public context kernel; the settled volume agrees with the
 *    component's analytic fixture within the curved band (the page
 *    publishes BOTH numbers — `data-volume` is the kernel's measurement,
 *    `data-expected-volume` the closed form at the same parameters);
 *  - REGENERATE: a parameter edit through the CadParameterPanel (the
 *    Formedible form over the component's parameter collection — the
 *    same public parameter mechanism the workbench speaks) rebuilds: the
 *    numeric surface follows the edit's prediction, the rendered pixels
 *    change, and the edit's contract refusal path surfaces the
 *    component's structured error without dispatching;
 *  - DETERMINISM: two consecutive full runs render byte-identical canvas
 *    pixels, and a fresh context reproduces the same bytes (the artifact
 *    baseline; run the suite three times to pin cross-run stability).
 *
 * Byte comparisons use Playwright `Buffer.equals` on canvas-ELEMENT
 * screenshots (the render harness's masking lesson). Every pixel
 * assertion stands beside the numeric assertions.
 */

/** Relative tolerance for kernel-measured vs analytic volume (curved band). */
const VOLUME_REL_TOLERANCE = 0.005;

interface ComponentCase {
  readonly id: string;
  /** A parameter to edit, its default, an in-bounds edit, and a refused value. */
  readonly edit: {
    readonly parameter: string;
    readonly default: number;
    readonly to: number;
    readonly refused: number;
  };
  readonly portCount: number;
}

const CASES: readonly ComponentCase[] = [
  {
    id: "nema17-mount",
    edit: { default: 46, parameter: "plateSizeMm", refused: 200, to: 60 },
    portCount: 5,
  },
  {
    id: "arduino-uno-mount",
    edit: { default: 6, parameter: "standoffHeightMm", refused: 40, to: 12 },
    portCount: 4,
  },
  {
    id: "electronics-enclosure",
    edit: { default: 25, parameter: "innerHeightMm", refused: 500, to: 40 },
    portCount: 5,
  },
];

function expectVolumeAgrees(volumeText: string, expectedText: string): void {
  const volume = Number(volumeText);
  const expected = Number(expectedText);
  expect(Number.isFinite(volume), `volume text ${volumeText}`).toBe(true);
  expect(Number.isFinite(expected), `expected text ${expectedText}`).toBe(true);
  expect(
    Math.abs(volume - expected),
    `kernel ${volume} vs analytic ${expected}`,
  ).toBeLessThanOrEqual(expected * VOLUME_REL_TOLERANCE);
}

for (const component of CASES) {
  test.describe(`component preview: ${component.id}`, () => {
    test("builds in the worker and agrees with the analytic fixture", async ({
      page,
    }) => {
      await page.goto(`/components/${component.id}`);
      const settled = await waitForSettledPreview(page);
      expectVolumeAgrees(settled.volume, settled.expected);

      await expect(page.locator(`${ROOT}[data-error]`)).toHaveAttribute(
        "data-error",
        "",
      );

      // The interface surface: the definition's ports, resolved at defaults.
      const ports = JSON.parse(
        (await page.locator(ROOT).getAttribute("data-ports")) ?? "[]",
      ) as unknown[];
      expect(ports).toHaveLength(component.portCount);

      // The build surface: bodies under the definition's preview body ids.
      const bodies = JSON.parse(
        (await page.locator(ROOT).getAttribute("data-bodies")) ?? "[]",
      ) as { bodyId: string }[];
      expect(bodies.length).toBeGreaterThanOrEqual(1);

      const shot = await previewCanvas(page).screenshot();
      await saveArtifact(`${component.id}-default.png`, shot);
      console.log(`sha256 ${component.id}-default ${sha256(shot)}`);

      // The evidence shot: the WHOLE page at defaults (the canvas crop
      // above proves the pixels; this one shows the parameter panel, the
      // interface ports table, and the build readouts around them).
      const pageShot = await page.screenshot({ fullPage: true });
      await saveArtifact(`${component.id}-page.png`, pageShot);
      console.log(`sha256 ${component.id}-page ${sha256(pageShot)}`);
    });

    test("a parameter edit regenerates the build through the parameter panel", async ({
      page,
    }) => {
      await page.goto(`/components/${component.id}`);
      const before = await waitForSettledPreview(page);
      const shotBefore = await previewCanvas(page).screenshot();

      // Edit through the Formedible panel: the field label IS the parameter
      // name (domain data), the submit button is the page's "Rebuild".
      await page
        .getByLabel(component.edit.parameter, { exact: true })
        .fill(String(component.edit.to));
      await page.getByRole("button", { name: "Rebuild" }).click();
      const after = await waitForSettledPreview(page);
      expectVolumeAgrees(after.volume, after.expected);

      // The numeric surface followed the edit, and the pixels changed.
      expect(after.volume).not.toBe(before.volume);
      const shotAfter = await previewCanvas(page).screenshot();
      expect(
        shotAfter.equals(shotBefore),
        "the edited build must differ pixel-wise",
      ).toBe(false);
      await saveArtifact(`${component.id}-edited.png`, shotAfter);

      // The page's parameter surface carries the edited value.
      const values = JSON.parse(
        (await page.locator(ROOT).getAttribute("data-parameter-values")) ??
          "{}",
      ) as Record<string, number>;
      expect(values[component.edit.parameter]).toBe(component.edit.to);
    });

    test("an out-of-contract edit is refused by the contract, not dispatched", async ({
      page,
    }) => {
      await page.goto(`/components/${component.id}`);
      const settled = await waitForSettledPreview(page);

      // The dispatch surface at rest — the boot build's counters. A page
      // that skipped its contract guard would dispatch the refused edit
      // (both counters bump at the dispatch moment, before any build
      // outcome), so BOTH must be proven untouched afterwards.
      const dispatchedBefore = await page
        .locator(ROOT)
        .getAttribute("data-dispatched");
      const revisionBefore = await page
        .locator(ROOT)
        .getAttribute("data-current-revision");
      expect(dispatchedBefore, "the boot build dispatched").not.toBe(null);
      expect(dispatchedBefore).not.toBe("");
      expect(revisionBefore, "the boot build bumped the revision").not.toBe(
        null,
      );
      expect(revisionBefore).not.toBe("");

      await page
        .getByLabel(component.edit.parameter, { exact: true })
        .fill(String(component.edit.refused));
      await page.getByRole("button", { name: "Rebuild" }).click();

      // The refusal surfaces the contract's code; nothing rebuilds — no
      // dispatch, no revision bump, and the settle surface keeps the same
      // volume.
      await expect(
        page.getByText(/component-contract\//).first(),
      ).toBeVisible();
      await page.waitForTimeout(250);
      expect(
        await page.locator(ROOT).getAttribute("data-dispatched"),
        "a refused edit must not reach the worker session",
      ).toBe(dispatchedBefore);
      expect(
        await page.locator(ROOT).getAttribute("data-current-revision"),
        "a refused edit must not bump the build revision",
      ).toBe(revisionBefore);
      const volume = await page.locator(ROOT).getAttribute("data-volume");
      expect(volume).toBe(settled.volume);
    });

    test("two consecutive runs render byte-identical previews", async ({
      page,
    }) => {
      await page.goto(`/components/${component.id}`);
      await waitForSettledPreview(page);
      const first = await previewCanvas(page).screenshot();

      await page.reload();
      await waitForSettledPreview(page);
      const second = await previewCanvas(page).screenshot();
      expect(
        second.equals(first),
        "the reloaded preview must be byte-identical",
      ).toBe(true);

      // A fresh context (new browser storage, same build) reproduces bytes.
      const context = page.context().browser();
      expect(context).not.toBeNull();
      if (context === null) return;
      const fresh = await context.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      const freshPage = await fresh.newPage();
      await freshPage.goto(`/components/${component.id}`);
      await waitForSettledPreview(freshPage);
      const third = await previewCanvas(freshPage).screenshot();
      expect(
        third.equals(first),
        "a fresh context must reproduce the same bytes",
      ).toBe(true);
      await fresh.close();
    });
  });
}
