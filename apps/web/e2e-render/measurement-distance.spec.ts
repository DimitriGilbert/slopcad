import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  bodySelectionKey,
  faceSelectionKey,
  faceWithNormal,
  readFaceAnchors,
  readSelectionRegeneration,
  saveArtifact,
  waitForSelectionFrame,
  waitForSettledScene,
  waitForTreeSelectionFrame,
} from "./helpers";

/**
 * Phase 27.2 reference-distance e2e — the plan's validation: distance
 * measured between supported references, with KNOWN FIXTURE ground truths.
 * Runs on the composed workbench (`/workbench`), driving the same surfaces
 * every other measurement rides: the viewport's face picks (shift for
 * additive), the model tree's body picks, and the Measurement block's
 * Distance row.
 *
 * The fixture camera looks from above-front-right, so the clickable faces
 * are the plate's top, front, and right planar faces — pairwise ADJACENT,
 * which is exactly their hand-computable distance: they share edges whose
 * tessellation vertices coincide, so the sampled minimum is EXACTLY
 * 0.000 mm (the plate's nonzero plane-separation truths — the 10 mm
 * top/bottom separation, parallel edges, concentric circles, bodies 4 mm
 * apart — are pinned by the cad-core distance suite, where the geometry is
 * constructible without a camera).
 *
 *  - GROUND TRUTH — top + front faces display `0.000 mm`; a body row plus
 *    a face displays `0.000 mm` across the stable/synthetic kinds;
 *  - SOURCE — the row names what it measures (`face ↔ face`,
 *    `body ↔ face`) and the unit renders as part of one readout;
 *  - HONESTY — a third face makes the request not-a-pair: the readout
 *    empties and the structured decline is carried as data.
 *
 * Machine surfaces: `data-distance` (the readout text, empty when nothing
 * is displayed), `data-distance-source` (the displayed pair kinds),
 * `data-distance-declined` (the structured decline code, empty when
 * none). Clicks follow the house rule: machine-derived face anchors and
 * tree rows only.
 */

const ROOT = "workbench-root";
const VIEWPORT = "workbench-viewport";
const TREE = '[data-slot="cad-model-tree"]';
const READOUT = "#workbench-measure-readout";
const SOURCE = "#workbench-distance-source";
const TOP_NORMAL = [0, 0, 1] as const;
const FRONT_NORMAL = [0, -1, 0] as const;
const RIGHT_NORMAL = [1, 0, 0] as const;
const PLATE_KEY = bodySelectionKey();

/** The distance readout the Measurement block displays, as data. */
async function readDistance(page: Page): Promise<string> {
  return (await page.locator(`#${ROOT}`).getAttribute("data-distance")) ?? "";
}

/** Waits until the distance surface displays exactly `expected`. */
async function waitForDistance(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ id, want }) => {
      const root = document.getElementById(id);
      return root !== null && root.getAttribute("data-distance") === want;
    },
    { id: ROOT, want: expected },
  );
}

/** Clicks the viewport at a face's machine-derived anchor point. */
async function clickFace(
  page: Page,
  anchor: { readonly point: readonly [number, number] },
  additive: boolean,
): Promise<void> {
  await page.locator(`#${VIEWPORT} canvas`).click({
    position: { x: anchor.point[0], y: anchor.point[1] },
    ...(additive ? { modifiers: ["Shift"] } : {}),
  });
}

/** The tree row for a reference key (e.g. `body|body_plate`). */
function treeNode(page: Page, key: string) {
  return page.locator(`${TREE} [data-node-key="${key}"]`);
}

test("two selected references display their known fixture distance", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // No selection, no distance request — the row shows nothing and no
  // decline is recorded (silence, not refusal).
  expect(await readDistance(page)).toBe("");
  expect(
    await page.locator(`#${ROOT}`).getAttribute("data-distance-declined"),
  ).toBe("");

  const anchors = await readFaceAnchors(page, VIEWPORT);
  const revision = await readSelectionRegeneration(page, ROOT);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const front = faceWithNormal(anchors, FRONT_NORMAL);
  const right = faceWithNormal(anchors, RIGHT_NORMAL);
  const topKey = faceSelectionKey(revision, top.faceIndex);
  const frontKey = faceSelectionKey(revision, front.faceIndex);
  const rightKey = faceSelectionKey(revision, right.faceIndex);

  // One face: still no distance request.
  await clickFace(page, top.anchor, false);
  await waitForSelectionFrame(page, topKey, ROOT);
  expect(await readDistance(page)).toBe("");
  expect(
    await page.locator(`#${ROOT}`).getAttribute("data-distance-declined"),
  ).toBe("");

  // SHIFT → the pair: top and front share the plate's top-front edge, so
  // the sampled minimum is exactly 0.000 mm.
  await clickFace(page, front.anchor, true);
  await waitForSelectionFrame(page, `${topKey};${frontKey}`, ROOT);
  await waitForDistance(page, "0.000 mm");
  await expect(page.locator(READOUT)).toHaveText("0.000 mm");
  // Units correct: the value and its unit render as one readout.
  expect(await page.locator(READOUT).textContent()).toMatch(/ mm$/);
  // The row names what it measures.
  await expect(page.locator(SOURCE)).toHaveText("face ↔ face");
  expect(
    await page.locator(`#${ROOT}`).getAttribute("data-distance-source"),
  ).toBe("face ↔ face");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact("distance-faces-pair.png", await page.screenshot());

  // HONESTY: a third face exceeds the pair — the readout empties and the
  // structured decline is surfaced as data instead of a number.
  await clickFace(page, right.anchor, true);
  await waitForSelectionFrame(page, `${topKey};${frontKey};${rightKey}`, ROOT);
  await waitForDistance(page, "");
  expect(
    await page.locator(`#${ROOT}`).getAttribute("data-distance-declined"),
  ).toBe("distance/not-a-pair");
  await expect(page.locator(READOUT)).toHaveCount(0);

  // CROSS-KIND: a stable body reference plus a synthetic face reference
  // measures through the same row — the body's own face is exactly on it.
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);
  await clickFace(page, front.anchor, true);
  await waitForSelectionFrame(page, `${PLATE_KEY};${frontKey}`, ROOT);
  await waitForDistance(page, "0.000 mm");
  await expect(page.locator(READOUT)).toHaveText("0.000 mm");
  await expect(page.locator(SOURCE)).toHaveText("body ↔ face");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact("distance-body-face.png", await page.screenshot());
});
