import { expect, test } from "@playwright/test";

/**
 * The Phase 52 assembly motion journey: component patterns stamp
 * occurrences (the instance count follows), the explode state authors and
 * scrubs DETERMINISTICALLY (the same factor always reproduces the same
 * scene stamp), the revolute joint scrubs inside its limits, the joint
 * drag declines with its structured reason, and the cross-document source
 * edit marks the assembly stale until regeneration.
 */

const ROOT = "#assembly-motion-root";

/** The source document id the fixture's staleness edge carries. */
const SOURCE_DOC_STAMP = "doc_motion_source";

test("patterns, explode scrub determinism, motion limits, and staleness", async ({
  page,
}) => {
  await page.goto("/workbench-assembly-motion");

  // The fixture hydrates with the seed + the cross-document source.
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-hydrated", "true");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-occurrence-count",
    "2",
  );
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-pattern-count",
    "0",
  );

  // -- The linear pattern stamps three occurrences; the instance count
  //    follows the document (the walk resolves every placed body).
  await page.getByTestId("motion-linear-pattern").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-occurrence-count",
    "5",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-pattern-count",
    "3",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-instance-count",
    "5",
  );

  // -- The circular pattern is idempotent authoring: one stamp of six.
  await page.getByTestId("motion-circular-pattern").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-occurrence-count",
    "11",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-pattern-count",
    "9",
  );
  await page.getByTestId("motion-circular-pattern").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-occurrence-count",
    "11",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-pattern-count",
    "9",
  );

  // -- The mirror stamps the mirrored placement.
  await page.getByTestId("motion-mirror").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-occurrence-count",
    "12",
  );

  // -- The explode state authors at factor 1; the scene stamp appears.
  await page.getByTestId("motion-explode-author").click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-explode-active",
    "true",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-explode-factor",
    "1.00",
  );
  const explodedStamp = await page
    .locator(ROOT)
    .getAttribute("data-cad-explode-scene");
  expect(explodedStamp ?? "").not.toBe("");

  // Scrub determinism: away from 1 and back to 1 reproduces the SAME
  // stamped scene, bit for bit — the pure function re-derives every frame.
  const scrub = page.getByTestId("motion-explode-scrub");
  await scrub.fill("0.25");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-explode-factor",
    "0.25",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-explode-active",
    "true",
  );
  const quarterStamp = await page
    .locator(ROOT)
    .getAttribute("data-cad-explode-scene");
  expect(quarterStamp ?? "").not.toBe("");
  expect(quarterStamp).not.toEqual(explodedStamp);
  await scrub.fill("1");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-explode-factor",
    "1.00",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-explode-scene",
    explodedStamp ?? "",
  );

  // -- The revolute joint scrubs inside its limits; the joint's local pose
  //    stamp changes with the parameter (motion at 30° differs from 0°).
  const jointScrub = page.getByTestId("motion-joint-scrub");
  await jointScrub.fill("30");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-motion-parameter",
    "30.0",
  );
  const motionAt30 = await page
    .locator(ROOT)
    .getAttribute("data-cad-motion-scene");
  expect(motionAt30 ?? "").not.toBe("");
  await jointScrub.fill("0");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-motion-parameter",
    "0.0",
  );
  const motionAt0 = await page
    .locator(ROOT)
    .getAttribute("data-cad-motion-scene");
  expect(motionAt0).not.toEqual(motionAt30);
  // Past the limit clamps: the parameter input's own max is the limit, and
  // the application clamps regardless (the limit fixture's UI face).
  await jointScrub.fill("90");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-cad-motion-parameter",
    "90.0",
  );

  // -- The clearance floor is a stamped number (the sampled probe ran).
  const clearance = await page
    .locator(ROOT)
    .getAttribute("data-cad-clearance-mm");
  expect(clearance ?? "").toMatch(/^\d+(\.\d+)?$/);

  // -- Joint-driven drag declines with its structured reason (the Phase 51
  //    boundary), never a fake drag.
  await page.getByTestId("motion-drag-decline").click();
  await expect(page.getByTestId("motion-drag-decline-text")).toContainText(
    "mate solver",
  );

  // -- The cross-document staleness rule: editing the source marks the
  //    assembly stale; regeneration clears it.
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-stale", "false");
  await page.getByTestId("motion-edit-source").click();
  await expect(page.getByTestId("motion-stale-badge")).toHaveText("STALE");
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-stale", "true");
  const staleSources = await page
    .locator(ROOT)
    .getAttribute("data-cad-stale-sources");
  expect(staleSources ?? "").toContain(SOURCE_DOC_STAMP);
  await page.getByTestId("motion-regenerate").click();
  await expect(page.getByTestId("motion-stale-badge")).toHaveText("up to date");
  await expect(page.locator(ROOT)).toHaveAttribute("data-cad-stale", "false");
});
