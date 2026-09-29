import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

/**
 * Chapter 11 — appearances and lighting. The body's tree row carries a
 * palette: the appearance library (brass, and clearing back to the scene
 * default), the view panel's three light rigs, and the opt-in Quality
 * render (s10's journey, on a fresh boot plate).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "appearance-and-lighting",
    title: "Appearances and lighting",
    summary:
      "Body appearances from the tree palette, the light rigs, and quality mode.",
    cues: [
      {
        stepId: "chip",
        text: "The palette dot on the plate's tree row opens appearances.",
      },
      {
        stepId: "library",
        text: "The library: steel, brass, copper, anodized blue, carbon, ceramic.",
      },
      {
        stepId: "brass",
        text: "Click Brass.",
      },
      {
        stepId: "applied",
        text: "The plate renders brass — and the chip carries its color.",
      },
      {
        stepId: "clear",
        text: "None returns the scene default.",
      },
      {
        stepId: "rigs",
        text: "Lower in the view panel: three light rigs — Studio, North, Inspect.",
      },
      {
        stepId: "inspect",
        text: "Inspect is one hard light — flattening, but honest.",
      },
      {
        stepId: "studio",
        text: "Studio wraps the model in soft, even light.",
      },
      {
        stepId: "quality-pair",
        text: "Render quality: Standard is the deterministic default.",
      },
      {
        stepId: "quality-on",
        text: "Quality opts into soft shadows and ambient occlusion.",
      },
      {
        stepId: "back-standard",
        text: "Back to Standard — fast and reproducible.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("chip");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    const appearanceChip = page
      .locator('[data-cad-tree-body-appearance=""]')
      .first();
    await expect(appearanceChip).toBeAttached();
    await driver.humanPoint(appearanceChip);
    await driver.dwell();

    /** Opens the appearance library (s10's Escape-then-open discipline). */
    const openLibrary = async (): Promise<void> => {
      await page.keyboard.press("Escape");
      await driver.dwell(150);
      await driver.humanClick(appearanceChip);
      await driver.dwell(300);
    };

    await driver.step("library");
    await openLibrary();
    const presets = page.locator('[aria-label="Appearance presets"]');
    await expect(presets).toBeAttached();
    for (const presetId of [
      "steel",
      "brass",
      "copper",
      "anodized-blue",
      "carbon",
      "ceramic",
    ]) {
      await driver.humanPoint(
        page.locator(`[data-testid="appearance-preset-${presetId}"]`),
      );
    }
    await driver.dwell();

    await driver.step("brass");
    await driver.humanClick(page.getByTestId("appearance-preset-brass"));
    await expect
      .poll(async () =>
        page.locator("[data-cad-tree-appearance-active]").count(),
      )
      .toBe(1);

    await driver.step("applied");
    await page.keyboard.press("Escape");
    await driver.dwell(150);
    await driver.humanPoint(page.locator("[data-cad-tree-appearance-active]"));
    await driver.dwell();

    await driver.step("clear");
    await openLibrary();
    await driver.humanClick(page.getByTestId("appearance-preset-none"));
    await expect
      .poll(async () =>
        page.locator("[data-cad-tree-appearance-active]").count(),
      )
      .toBe(0);
    await page.keyboard.press("Escape");
    await driver.dwell(150);

    await driver.step("rigs");
    for (const rigId of ["studio", "north-window", "inspection"]) {
      await driver.humanPoint(
        page.locator(`[data-testid="light-rig-${rigId}"]`),
      );
    }
    await driver.dwell();

    await driver.step("inspect");
    const inspectRig = page.locator('[data-testid="light-rig-inspection"]');
    await driver.humanClick(inspectRig);
    await expect(inspectRig).toHaveAttribute("aria-pressed", "true");

    await driver.step("studio");
    const studioRig = page.locator('[data-testid="light-rig-studio"]');
    await driver.humanClick(studioRig);
    await expect(studioRig).toHaveAttribute("aria-pressed", "true");
    await expect(inspectRig).toHaveAttribute("aria-pressed", "false");

    await driver.step("quality-pair");
    await driver.humanPoint(
      page.locator('[data-testid="render-quality-standard"]'),
    );
    await driver.humanPoint(
      page.locator('[data-testid="render-quality-quality"]'),
    );
    await driver.dwell();

    await driver.step("quality-on");
    const qualityRender = page.locator(
      '[data-testid="render-quality-quality"]',
    );
    await driver.humanClick(qualityRender);
    await expect(qualityRender).toHaveAttribute("aria-pressed", "true");

    await driver.step("back-standard");
    const standardRender = page.locator(
      '[data-testid="render-quality-standard"]',
    );
    await driver.humanClick(standardRender);
    await expect(standardRender).toHaveAttribute("aria-pressed", "true");
    await driver.dwell(1_200);
  },
};
