import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  bodySelectionKey,
  clickFaceAnchor,
  faceSelectionKey,
  faceWithNormal,
  readFaceAnchors,
  readHover,
  readSelection,
  readSelectionRegeneration,
  saveArtifact,
  sha256,
  waitForSelectionFrame,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 12 selection-and-picking e2e — the phase-level browser gate.
 * Validation criteria from the plan:
 *  - a FACE can be selected: a click at a derived face-anchor point (never
 *    a guessed pixel) resolves to the synthetic face reference and its
 *    body;
 *  - selection state SURVIVES same-regeneration re-renders (hover, pointer
 *    moves, control changes) and is DROPPED when the regeneration changes
 *    (a parameter change builds a new synthetic space — the transience
 *    rule), with the next pick tagged for the new regeneration;
 *  - MULTI-selection works (two faces, toggle semantics), single click
 *    replaces, clear empties;
 *  - the highlight is DETERMINISTIC: byte-identical canvas across two full
 *    runs, and provably different pixels from the unselected scene;
 *  - the principal selection flow is captured on video (config-level
 *    `video: "on"` + the video-artifact reporter).
 *
 * Point derivation: the fixture publishes per-face anchor points (CSS
 * pixels relative to the viewport) computed from cad-core's guaranteed
 * on-face anchors projected through the pure spec→screen mapping; the spec
 * identifies faces semantically by their mean normal (+z = top plate face,
 * -y = front wall, +x = right wall). Runs against the production build.
 */

const TOP_NORMAL = [0, 0, 1] as const;
const FRONT_WALL_NORMAL = [0, -1, 0] as const;
const RIGHT_WALL_NORMAL = [1, 0, 0] as const;

const ENLARGED_HOLE_DIAMETER_MM = 12;

/** Expected serialized form of the synthetic face reference for a pick. */
function expectedFaceRef(
  revision: number,
  faceIndex: number,
): Record<string, number | string> {
  return {
    kind: "face",
    bodyId: "body_plate",
    regeneration: revision,
    faceIndex,
  };
}

/** Moves the mouse to a face anchor without pressing any button. */
async function hoverFaceAnchor(
  page: Page,
  anchor: { readonly point: readonly [number, number] },
): Promise<void> {
  const canvas = page.locator("#render-viewport canvas");
  const box = await canvas.boundingBox();
  expect(box, "canvas bounding box").not.toBeNull();
  if (box === null) throw new Error("unreachable: box checked above");
  await page.mouse.move(box.x + anchor.point[0], box.y + anchor.point[1]);
}

test("a face can be selected and reports the synthetic face and body references", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const revision = await readSelectionRegeneration(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);

  await clickFaceAnchor(page, top.anchor);
  await waitForSelectionFrame(page, faceSelectionKey(revision, top.faceIndex));

  const selected = await readSelection(page);
  expect(selected).toEqual([expectedFaceRef(revision, top.faceIndex)]);
  // The human-readable surface names the body the face belongs to.
  await expect(page.locator("#selection-list")).toContainText("body_plate");

  // Body category: the same click resolves to the stable body reference.
  await page.locator("#pick-category-body").check();
  await clickFaceAnchor(page, top.anchor);
  await waitForSelectionFrame(page, bodySelectionKey());
  expect(await readSelection(page)).toEqual([
    { kind: "body", bodyId: "body_plate" },
  ]);

  // Restore the face category for the specs that follow.
  await page.locator("#pick-category-face").check();
  await clickFaceAnchor(page, top.anchor);
  await waitForSelectionFrame(page, faceSelectionKey(revision, top.faceIndex));
  expect(await readSelection(page)).toEqual([
    expectedFaceRef(revision, top.faceIndex),
  ]);
});

test("selection survives same-regeneration re-renders and drops on regeneration change", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const revision = await readSelectionRegeneration(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const frontWall = faceWithNormal(anchors, FRONT_WALL_NORMAL);

  await clickFaceAnchor(page, top.anchor);
  const topKey = faceSelectionKey(revision, top.faceIndex);
  await waitForSelectionFrame(page, topKey);
  const selected = await readSelection(page);
  const withHighlight = await page
    .locator("#render-viewport canvas")
    .screenshot();

  // Hover is separate from selection: hovering another face updates the
  // hover reference, changes no pixels (hover is data-only, documented),
  // and leaves the selection untouched.
  await hoverFaceAnchor(page, frontWall.anchor);
  expect(await readHover(page)).toBe(
    JSON.stringify(expectedFaceRef(revision, frontWall.faceIndex)),
  );
  expect(await readSelection(page)).toEqual(selected);
  expect(
    (await page.locator("#render-viewport canvas").screenshot()).equals(
      withHighlight,
    ),
    "hover must not change a single pixel",
  ).toBe(true);

  // A non-geometry state change (the pick-category control re-renders the
  // scene with different props) re-renders WITHOUT a new regeneration:
  // the selection and its highlight persist byte-identically.
  await page.locator("#pick-category-body").check();
  await page.locator("#pick-category-face").check();
  expect(await readSelection(page)).toEqual(selected);
  await waitForSelectionFrame(page, topKey);
  expect(
    (await page.locator("#render-viewport canvas").screenshot()).equals(
      withHighlight,
    ),
    "same-regeneration re-render must keep the highlight pixels",
  ).toBe(true);

  // Pointer leaves the model: hover clears, selection persists.
  const box = await page.locator("#render-viewport canvas").boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("unreachable: box checked above");
  await page.mouse.move(box.x + 2, box.y + 2);
  expect(await readHover(page)).toBe("");
  expect(await readSelection(page)).toEqual(selected);

  // A parameter change regenerates the model: NEW revision, NEW synthetic
  // space — the face selection is dropped (transience, enforced by the
  // domain state) and the highlight disappears.
  await page
    .locator("#param-holeDiameter")
    .fill(String(ENLARGED_HOLE_DIAMETER_MM));
  await waitForSettledScene(page);
  const nextRevision = await readSelectionRegeneration(page);
  expect(nextRevision).toBeGreaterThan(revision);
  expect(await readSelection(page)).toEqual([]);
  await waitForSelectionFrame(page, "");

  // The next pick is tagged for the NEW regeneration and the new
  // synthetic space (the anchor map is re-derived from the new projection).
  const nextAnchors = await readFaceAnchors(page);
  const nextTop = faceWithNormal(nextAnchors, TOP_NORMAL);
  await clickFaceAnchor(page, nextTop.anchor);
  await waitForSelectionFrame(
    page,
    faceSelectionKey(nextRevision, nextTop.faceIndex),
  );
  expect(await readSelection(page)).toEqual([
    expectedFaceRef(nextRevision, nextTop.faceIndex),
  ]);
});

test("multi-select toggles, single click replaces, clear empties", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const revision = await readSelectionRegeneration(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const frontWall = faceWithNormal(anchors, FRONT_WALL_NORMAL);
  const rightWall = faceWithNormal(anchors, RIGHT_WALL_NORMAL);

  const refOf = (faceIndex: number) => expectedFaceRef(revision, faceIndex);
  const keyOf = (faceIndex: number) => faceSelectionKey(revision, faceIndex);

  // Single mode: replaces.
  await clickFaceAnchor(page, top.anchor);
  await waitForSelectionFrame(page, keyOf(top.faceIndex));
  expect(await readSelection(page)).toEqual([refOf(top.faceIndex)]);

  // Multi mode (shift): appends, insertion order preserved.
  await clickFaceAnchor(page, frontWall.anchor, ["Shift"]);
  await waitForSelectionFrame(
    page,
    `${keyOf(top.faceIndex)};${keyOf(frontWall.faceIndex)}`,
  );
  expect(await readSelection(page)).toEqual([
    refOf(top.faceIndex),
    refOf(frontWall.faceIndex),
  ]);

  // Multi mode: toggles OFF, preserving the others' order.
  await clickFaceAnchor(page, frontWall.anchor, ["Shift"]);
  await waitForSelectionFrame(page, keyOf(top.faceIndex));
  expect(await readSelection(page)).toEqual([refOf(top.faceIndex)]);

  // Single mode again: replaces the whole selection.
  await clickFaceAnchor(page, rightWall.anchor);
  await waitForSelectionFrame(page, keyOf(rightWall.faceIndex));
  expect(await readSelection(page)).toEqual([refOf(rightWall.faceIndex)]);

  // Multi-append the top face: order is [rightWall, top].
  await clickFaceAnchor(page, top.anchor, ["Shift"]);
  await waitForSelectionFrame(
    page,
    `${keyOf(rightWall.faceIndex)};${keyOf(top.faceIndex)}`,
  );
  expect(await readSelection(page)).toEqual([
    refOf(rightWall.faceIndex),
    refOf(top.faceIndex),
  ]);

  // Clear empties the selection.
  await page.locator("#selection-clear").click();
  await waitForSelectionFrame(page, "");
  expect(await readSelection(page)).toEqual([]);
});

test("the selection highlight is byte-deterministic across two full runs", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const unselected = await page.locator("#render-viewport canvas").screenshot();
  const anchors = await readFaceAnchors(page);
  const revision = await readSelectionRegeneration(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);

  await clickFaceAnchor(page, top.anchor);
  await waitForSelectionFrame(page, faceSelectionKey(revision, top.faceIndex));
  const run1 = await page.locator("#render-viewport canvas").screenshot();

  // The highlight must visibly change pixels...
  expect(
    run1.equals(unselected),
    "the selection highlight must alter the canvas bytes",
  ).toBe(false);
  await saveArtifact("selection-highlight.png", run1);

  // ...and reproduce byte-identically in a full second run (fresh load,
  // fresh worker, fresh kernel computation, same click).
  await page.reload();
  await waitForSettledScene(page);
  const rerunAnchors = await readFaceAnchors(page);
  const rerunRevision = await readSelectionRegeneration(page);
  expect(rerunRevision).toBe(revision);
  const rerunTop = faceWithNormal(rerunAnchors, TOP_NORMAL);
  expect(rerunTop.faceIndex).toBe(top.faceIndex);
  expect(rerunTop.anchor.point).toEqual(top.anchor.point);

  await clickFaceAnchor(page, rerunTop.anchor);
  await waitForSelectionFrame(
    page,
    faceSelectionKey(rerunRevision, rerunTop.faceIndex),
  );
  const run2 = await page.locator("#render-viewport canvas").screenshot();
  expect(
    run2.equals(run1),
    `run1 sha256=${sha256(run1)} vs run2 sha256=${sha256(run2)}`,
  ).toBe(true);
});

test("the principal selection flow is captured on video", async ({ page }) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const revision = await readSelectionRegeneration(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const rightWall = faceWithNormal(anchors, RIGHT_WALL_NORMAL);

  // The principal flow: hover, select, extend the selection, clear,
  // regenerate (selection drops).
  await hoverFaceAnchor(page, top.anchor);
  await clickFaceAnchor(page, top.anchor);
  await waitForSelectionFrame(page, faceSelectionKey(revision, top.faceIndex));
  await clickFaceAnchor(page, rightWall.anchor, ["Shift"]);
  await waitForSelectionFrame(
    page,
    `${faceSelectionKey(revision, top.faceIndex)};${faceSelectionKey(revision, rightWall.faceIndex)}`,
  );
  expect(await readSelection(page)).toEqual([
    expectedFaceRef(revision, top.faceIndex),
    expectedFaceRef(revision, rightWall.faceIndex),
  ]);
  await page.locator("#selection-clear").click();
  await waitForSelectionFrame(page, "");
  await page
    .locator("#param-holeDiameter")
    .fill(String(ENLARGED_HOLE_DIAMETER_MM));
  await waitForSettledScene(page);
  expect(await readSelection(page)).toEqual([]);

  // The config records every test (`video: "on"`); the reporter copies the
  // recording to e2e-artifacts/render/<test-title>.webm at run end.
  const video = page.video();
  expect(video, "the page must be recorded").not.toBeNull();
  const path = await video?.path();
  expect(path, "a video file must be attached").toBeTruthy();
});
