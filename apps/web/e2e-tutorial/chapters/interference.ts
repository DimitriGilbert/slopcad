import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

/** The interference fixture's root (the session s21 machine surface). */
const INTERFERENCE_ROOT = "#interference-workbench-root";

/**
 * Chapter 24 — the interference workbench. The report panel stays empty
 * until a run exists, the batch measures every pair with its verdict, the
 * isolate/show-all pair stages the offending pair, and the JSON/HTML
 * snapshot exports carry distinct digests over the same truth (the s21
 * stage, at teaching pace).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "interference",
    title: "Interference checking",
    summary:
      "The interference report, isolation of an offending pair, and the deterministic JSON/HTML snapshot exports.",
    cues: [
      {
        stepId: "boot",
        text: "Interference: three blocks placed — two overlap, one stands clear.",
      },
      {
        stepId: "idle",
        text: "The report panel shows nothing before a run — no invented data.",
      },
      {
        stepId: "run",
        text: "Run the check: every pair measured, one interference found.",
      },
      {
        stepId: "verdict",
        text: "The row names the pair and its overlap volume. Isolate it.",
      },
      {
        stepId: "isolate",
        text: "Isolate pulls the pair forward; the third block steps aside.",
      },
      {
        stepId: "show-all",
        text: "Show all brings the full assembly back.",
      },
      {
        stepId: "json",
        text: "The snapshot exports as JSON — a digest stamps the exact bytes.",
      },
      {
        stepId: "html",
        text: "The same report as HTML: a different digest, the same truth.",
      },
      {
        stepId: "recap",
        text: "Overlaps surface before the parts are made. That is the point.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    const root = page.locator(INTERFERENCE_ROOT);

    await driver.step("boot");
    await page.goto("/workbench-assembly-interference");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "3");
    await driver.dwell();

    await driver.step("idle");
    const panel = page.getByTestId("interference-panel");
    await expect(panel).toContainText("No report yet");
    await driver.humanPoint(panel);
    await driver.dwell();

    await driver.step("run");
    await driver.humanClick(page.getByTestId("interference-run"));
    await expect(root).toHaveAttribute("data-cad-interference-pairs", "1");
    await expect(root).toHaveAttribute("data-cad-clearance-count", "3");

    await driver.step("verdict");
    const row = page.getByTestId("interference-row-0");
    await expect(row).toContainText("interferes");
    await driver.humanPoint(row);
    await driver.dwell();

    await driver.step("isolate");
    await driver.humanClick(page.getByTestId("interference-isolate-0"));
    await expect(root).toHaveAttribute("data-cad-instance-count", "2");
    await driver.dwell();

    await driver.step("show-all");
    await driver.humanClick(page.getByTestId("interference-show-all"));
    await expect(root).toHaveAttribute("data-cad-instance-count", "3");
    await driver.dwell();

    await driver.step("json");
    await driver.humanClick(page.getByTestId("interference-export-json"));
    await expect(root).toHaveAttribute("data-cad-report-format", "json");
    const jsonDigest = await root.getAttribute("data-cad-report-digest");
    expect(jsonDigest).not.toBe("none");
    const downloadLink = page.getByTestId("interference-download");
    await expect(downloadLink).toBeVisible();
    await driver.pointAtReadout(downloadLink);
    await driver.dwell();

    await driver.step("html");
    await driver.humanClick(page.getByTestId("interference-export-html"));
    await expect(root).toHaveAttribute("data-cad-report-format", "html");
    const htmlDigest = await root.getAttribute("data-cad-report-digest");
    expect(htmlDigest).not.toBe(jsonDigest);
    await driver.pointAtReadout(downloadLink);
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
