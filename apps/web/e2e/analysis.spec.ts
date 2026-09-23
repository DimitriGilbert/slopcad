import { expect, test } from "@playwright/test";

/**
 * The Phase 58 analysis journey: draft classification against the pull
 * datum, the curvature band census and comb curvature, the zebra display
 * mode toggle, and the document-material mass aggregate with its COG
 * stamp — the block's remaining consumers at the browser surface.
 */

const ROOT = "#analysis-workbench-root";

test("draft, curvature, zebra, and COG/mass readouts", async ({ page }) => {
  await page.goto("/workbench-analysis");

  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-hydrated", "true");
  await expect(page.locator("canvas").first()).toBeVisible();

  // -- The mass aggregate answers immediately: two material records over
  //    the analytic box compound, with the COG marker in the scene.
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-mass-g",
    "289.710",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-cog-mm",
    /^\d+\.\d{3}\|\d+\.\d{3}\|\d+\.\d{3}$/,
  );
  await expect(page.getByTestId("analysis-mass-panel")).toContainText(
    "Total mass 289.710 g",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-comb-max-kappa",
    "0.033",
  );

  // -- Before the run: the analysis panels show honest silence.
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-draft-faces",
    "none",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-band-census",
    "none",
  );

  // -- The run fills both analyses: the draft box classifies 1 positive
  //    (top), 1 negative (bottom), 4 vertical sides; the faceted tube's
  //    band census is 4 flat seam ends, 46 curved, 0 sharp.
  await page.getByTestId("analysis-run").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-draft-classes",
    "positive=1|negative=1|vertical=4|undercut=0",
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-draft-faces", "6");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-band-census",
    "flat=4|curved=46|sharp=0",
  );
  await expect(page.getByTestId("analysis-draft-panel")).toContainText(
    "90.000° from pull",
  );
  await expect(page.getByTestId("analysis-draft-panel")).toContainText(
    "vertical",
  );

  // -- The zebra display mode toggles the shader-level stripes on and
  //    off (the mode is opt-in; the default stays shaded).
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-zebra", "off");
  await page.getByTestId("analysis-zebra-toggle").click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-zebra", "on");
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.getByTestId("analysis-zebra-toggle").click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-zebra", "off");
});
