import { expect, test } from "@playwright/test";

/**
 * The Phase 58 interference journey: the check fills the report panel
 * (one interfering pair, one clearance), isolation narrows the viewport to
 * exactly the pair's two instances and back, and both snapshot exports
 * reproduce byte-identical digests across repeated exports — the
 * deterministic-snapshot contract at the browser surface.
 */

const ROOT = "#interference-workbench-root";

test("report panel, pair isolation, and deterministic snapshot exports", async ({
  page,
}) => {
  await page.goto("/workbench-assembly-interference");

  // The fixture hydrates with its three occurrences and shows honest
  // silence in the panel and no report stamps.
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-hydrated", "true");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-occurrence-count",
    "3",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-instance-count",
    "3",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-interference-pairs",
    "0",
  );
  await expect(page.getByTestId("interference-panel")).toContainText(
    "No report yet",
  );

  // -- The check fills the panel: one interfering pair (block penetrates
  //    the plate), one clear pair, one kernel-declined skip (the fixture's
  //    seam declines nothing — zero skipped), all measured clearances.
  await page.getByTestId("interference-run").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-interference-pairs",
    "1",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-checked-pairs",
    "1",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-interference-skipped",
    "0",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-clearance-count",
    "3",
  );
  await expect(page.getByTestId("interference-row-0")).toContainText("block");
  await expect(page.getByTestId("interference-row-0")).toContainText(
    "interferes",
  );
  await expect(page.getByTestId("interference-row-0")).toContainText(
    "5400.000 mm³",
  );

  // -- Isolation narrows the viewport to exactly the pair's instances.
  await page.getByTestId("interference-isolate-0").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-isolated-pair",
    "occ_int_plate|occ_int_block",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-instance-count",
    "2",
  );
  await page.getByTestId("interference-show-all").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-isolated-pair",
    "none",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-instance-count",
    "3",
  );

  // -- The JSON snapshot export is byte-stable across repeated exports:
  //    the same digest, the same byte count.
  await page.getByTestId("interference-export-json").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-report-format",
    "json",
  );
  const jsonDigest = await page
    .locator(ROOT)
    .getAttribute("data-cad-report-digest");
  const jsonBytes = await page
    .locator(ROOT)
    .getAttribute("data-cad-report-bytes");
  expect(jsonDigest).not.toBe("none");
  await page.getByTestId("interference-export-json").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-report-digest",
    jsonDigest ?? "",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-report-bytes",
    jsonBytes ?? "",
  );
  await expect(page.getByTestId("interference-download")).toHaveAttribute(
    "download",
    "interference-snapshot.json",
  );

  // -- The HTML snapshot export carries its own stable digest — a
  //    different document, equally deterministic.
  await page.getByTestId("interference-export-html").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-report-format",
    "html",
  );
  const htmlDigest = await page
    .locator(ROOT)
    .getAttribute("data-cad-report-digest");
  expect(htmlDigest).not.toBe("none");
  expect(htmlDigest).not.toBe(jsonDigest);
  await page.getByTestId("interference-export-html").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-report-digest",
    htmlDigest ?? "",
  );
  await expect(page.getByTestId("interference-download")).toHaveAttribute(
    "download",
    "interference-snapshot.html",
  );
});
