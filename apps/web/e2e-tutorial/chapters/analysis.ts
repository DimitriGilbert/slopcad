import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

/** The analysis fixture's root (the session s22 machine surface). */
const ANALYSIS_ROOT = "#analysis-workbench-root";

/**
 * Chapter 25 — the analysis workbench. Mass properties are computed live
 * at boot, draft and curvature wait for the run and then class every face
 * and band every vertex, the curvature comb proves itself on the r=30
 * arc, and the zebra toggle probes surface quality as a view — never a
 * document edit (the s22 stage, at teaching pace).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "analysis",
    title: "Model analysis",
    summary:
      "Mass properties at boot, the draft and curvature run, the curvature comb's exact arc, and the zebra view.",
    cues: [
      {
        stepId: "boot",
        text: "Analysis: draft, curvature, zebra, mass. Mass is live at boot.",
      },
      {
        stepId: "mass",
        text: "Two materials total 289.710 grams — the compound carries a COG.",
      },
      {
        stepId: "idle",
        text: "Draft and curvature wait for the run — no numbers invented.",
      },
      {
        stepId: "run",
        text: "Run the analysis: every face classed, every vertex banded.",
      },
      {
        stepId: "draft",
        text: "The box sorts: one positive, one negative, four vertical faces.",
      },
      {
        stepId: "bands",
        text: "Curvature bands the welds: four flat, forty-six curved, none sharp.",
      },
      {
        stepId: "comb",
        text: "The comb over the r30 arc peaks at 0.033 — exactly one over r.",
      },
      {
        stepId: "zebra",
        text: "Zebra view: reflection stripes probe surface quality.",
      },
      {
        stepId: "shaded",
        text: "Back to shaded — a probe is a view, never a document edit.",
      },
      {
        stepId: "recap",
        text: "Ask the model questions; the answers stay numbers on the page.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    const root = page.locator(ANALYSIS_ROOT);

    await driver.step("boot");
    await page.goto("/workbench-analysis");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-mass-g", "289.710");
    await expect(root).toHaveAttribute("data-cad-comb-max-kappa", "0.033");
    await driver.dwell();

    await driver.step("mass");
    const massLine = page.getByText(/Total mass 289\.710 g/);
    await expect(massLine).toBeVisible();
    await driver.pointAtReadout(massLine);
    await driver.dwell();

    await driver.step("idle");
    const draftPanel = page.getByTestId("analysis-draft-panel");
    await expect(draftPanel).toContainText("No draft report yet");
    await driver.humanPoint(draftPanel);
    await driver.dwell();

    await driver.step("run");
    await driver.humanClick(page.getByTestId("analysis-run"));
    await expect(root).toHaveAttribute(
      "data-cad-draft-classes",
      "positive=1|negative=1|vertical=4|undercut=0",
    );
    await expect(root).toHaveAttribute(
      "data-cad-band-census",
      "flat=4|curved=46|sharp=0",
    );

    await driver.step("draft");
    await driver.pointAtReadout(draftPanel);
    await driver.dwell();

    await driver.step("bands");
    const curvaturePanel = page.getByTestId("analysis-curvature-panel");
    await expect(curvaturePanel).toContainText("welded vertices");
    await driver.humanPoint(curvaturePanel);
    await driver.dwell();

    await driver.step("comb");
    const combLine = page.getByText(/max \|κ\| = 0\.033/);
    await expect(combLine).toBeVisible();
    await driver.pointAtReadout(combLine);
    await driver.dwell();

    await driver.step("zebra");
    await expect(root).toHaveAttribute("data-cad-zebra", "off");
    await driver.humanClick(page.getByTestId("analysis-zebra-toggle"));
    await expect(root).toHaveAttribute("data-cad-zebra", "on");
    await driver.dwell();

    await driver.step("shaded");
    await driver.humanClick(page.getByTestId("analysis-zebra-toggle"));
    await expect(root).toHaveAttribute("data-cad-zebra", "off");
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
