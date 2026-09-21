import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { SettleAnchor } from "../e2e-render/helpers";

import {
  dispatchedCount,
  faceWithNormal,
  readFaceAnchors,
  waitForSettledScene,
} from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";

/**
 * The Phase 39 sketch-on-face journey e2e — the roadmap's validation gate,
 * verbatim: "workbench e2e: sketch on a face of an existing extrusion,
 * extrude, edit driving face — geometry follows."
 *
 * The journey on `/workbench-complete` (production build, SwiftShader,
 * fixed viewport, one worker):
 *
 *  1. CREATE the base: the sketch → extrude bridge commits a 20×15
 *     rectangle extruded `EXTRUDE_DEFAULT_DEPTH_MM` — analytic volume
 *     3000 mm³ (the workflow spec's create journey).
 *  2. SELECT the driving face: a click at the derived face-anchor point
 *     (never a guessed pixel) resolves the top face's synthetic reference.
 *  3. SKETCH ON FACE: the datum verb anchors a datum plane record to the
 *     face and boots the sketch editor on the face's workplane; the datum
 *     machine surface reports one resolved datum.
 *  4. EXTRUDE the pad: the pad extrude declares the datum as an input, and
 *     the composed pad scene (base + pad union) settles at the analytic
 *     6000 mm³.
 *  5. EDIT THE DRIVING FACE: one `parameter.set` on the base depth (10 →
 *     15) re-resolves the datum — the machine surface's datum origin lifts
 *     to z = 15 — and the re-dispatched composition settles at exactly
 *     7500 mm³: the pad followed the face. GEOMETRY FOLLOWS, analytically.
 *
 * Every semantic assertion reads the machine surfaces; the screenshot is
 * an artifact, never the only evidence.
 */

const ROOT = "workbench-complete-root";
const MODE_TOGGLE = '[data-testid="complete-mode-toggle"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const SKETCH_ON_FACE = '[data-testid="complete-sketch-on-face"]';
const SKETCH = "#sketch-root";
const VIEWPORT_ID = "workbench-complete-viewport";
const TOP_NORMAL = [0, 0, 1] as const;

/** The sketch rectangle the journeys draw (workplane mm). */
const RECT = { x0: 10, y0: 10, x1: 30, y1: 25 } as const;

/** Relative volume tolerance (the workbench suite's documented band). */
const VOLUME_REL_TOLERANCE = 0.005;

/** Saves an artifact under the workbench artifacts directory. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/workbench", { recursive: true });
  await writeFile(`e2e-artifacts/workbench/${name}`, bytes);
}

/** Opens the complete workbench and waits for the settled first scene. */
async function openWorkbench(page: Page): Promise<string> {
  await page.goto("/workbench-complete");
  return waitForSettledScene(page, ROOT);
}

/** Waits until the root's settle stamp agrees with the settled volume. */
async function waitForRootSettle(
  page: Page,
  anchor?: SettleAnchor,
): Promise<string> {
  return waitForSettledScene(page, ROOT, anchor);
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Draws the 20x15 rectangle with the rectangle tool (two corner picks). */
async function drawRectangle(page: Page): Promise<void> {
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "rectangle",
  );
  const surface = page.locator(`${SKETCH} [data-sketch-surface]`);
  await surface.click({ position: canvasPoint(RECT.x0, RECT.y0) });
  await surface.click({ position: canvasPoint(RECT.x1, RECT.y1) });
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { kind: string }[];
  expect(entities.filter((entity) => entity.kind === "rectangle").length).toBe(
    1,
  );
}

/** True when `value` matches `expected` inside the documented band. */
function volumeNear(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= expected * VOLUME_REL_TOLERANCE;
}

test("sketch on a face, extrude, edit the driving face — geometry follows", async ({
  page,
}) => {
  await openWorkbench(page);

  // CREATE the base extrusion (the workflow spec's create journey).
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  const baseVolume = await waitForRootSettle(page);
  const baseAnalytic =
    (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;
  expect(
    volumeNear(Number(baseVolume), baseAnalytic),
    `base ${baseVolume} vs analytic ${String(baseAnalytic)}`,
  ).toBe(true);

  // SELECT the driving face: the extrusion's top face (+z normal), clicked
  // at its derived anchor point on the viewport canvas.
  // The complete workbench publishes the face-anchor surface on its ROOT
  // (the same engine derivation the fixture viewport writes).
  const anchors = await readFaceAnchors(page, ROOT);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  await page
    .locator(`#${VIEWPORT_ID} canvas`)
    .click({ position: { x: top.anchor.point[0], y: top.anchor.point[1] } });
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    new RegExp(`^face\\|body_extrude\\|\\d+\\|${String(top.faceIndex)}$`),
  );

  // SKETCH ON FACE: the datum verb anchors the plane and boots the editor
  // on the face's workplane; the datum surface reports it RESOLVED.
  await page.locator(SKETCH_ON_FACE).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-datums",
    /^\[\{.*"resolved":true.*\}\]$/,
  );

  // EXTRUDE the pad: the datum-anchored pad joins the document, and the
  // composed scene settles at base + pad.
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  const paddedVolume = await waitForRootSettle(page);
  const paddedAnalytic = baseAnalytic * 2;
  expect(
    volumeNear(Number(paddedVolume), paddedAnalytic),
    `padded ${paddedVolume} vs analytic ${String(paddedAnalytic)}`,
  ).toBe(true);
  // The timeline carries the boot plate's chain plus both extrudes, all
  // valid.
  const timeline = JSON.parse(
    (await page.locator(`#${ROOT}`).getAttribute("data-feature-timeline")) ??
      "{}",
  ) as { entries: readonly { kind: string; status: string }[] };
  expect(timeline.entries.map((entry) => entry.kind)).toEqual([
    "translate",
    "rotate",
    "extrude",
    "extrude",
  ]);
  for (const entry of timeline.entries) {
    expect(entry.status).toBe("valid");
  }

  // EDIT THE DRIVING FACE: base depth 10 → 15. The datum machine surface
  // re-resolves (origin z lifts 10 → 15) and the recomposed scene settles
  // at exactly base(15) + pad(10) — the pad followed the face.
  const beforeEdit = await dispatchedCount(page, ROOT);
  await page.getByLabel("extrudeDepth", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Apply" }).click();
  const editedVolume = await waitForRootSettle(page, {
    afterDispatch: beforeEdit,
  });
  const editedAnalytic = baseAnalytic * 1.5 + baseAnalytic;
  expect(
    volumeNear(Number(editedVolume), editedAnalytic),
    `edited ${editedVolume} vs analytic ${String(editedAnalytic)}`,
  ).toBe(true);
  const datums = JSON.parse(
    (await page.locator(`#${ROOT}`).getAttribute("data-datums")) ?? "[]",
  ) as { resolved: boolean; origin: readonly [number, number, number] }[];
  expect(datums).toHaveLength(1);
  expect(datums[0]?.resolved).toBe(true);
  expect(datums[0]?.origin[2]).toBeCloseTo(15, 6);

  await page.mouse.move(4, 4);
  await saveArtifact("workbench-sketch-on-face.png", await page.screenshot());
});

test("a plain sketch re-entry after a face-anchored extrude boots the DEFAULT workplane and declares no datum input", async ({
  page,
}) => {
  await openWorkbench(page);

  // The base extrusion (3000 mm³), exactly as the journey above builds it.
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await waitForRootSettle(page);

  // The anchor-consuming cycle: select the top face, sketch on it, extrude
  // the pad — the extrude that USED to exit through the raw setMode and
  // leave the face anchor alive behind it.
  const anchors = await readFaceAnchors(page, ROOT);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  await page
    .locator(`#${VIEWPORT_ID} canvas`)
    .click({ position: { x: top.anchor.point[0], y: top.anchor.point[1] } });
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    new RegExp(`^face\\|body_extrude\\|\\d+\\|${String(top.faceIndex)}$`),
  );
  await page.locator(SKETCH_ON_FACE).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  const paddedVolume = await waitForRootSettle(page);
  const baseAnalytic =
    (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;
  expect(
    volumeNear(Number(paddedVolume), baseAnalytic * 2),
    `padded ${paddedVolume} vs analytic ${String(baseAnalytic * 2)}`,
  ).toBe(true);

  // THE REGRESSION: enter the sketch workspace PLAINLY (the Sketch button,
  // no face pick). The stale anchor must be gone — the session boots on the
  // DEFAULT XY workplane, not the face frame at z = 10.
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
  const workplane = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-workplane")) ??
      "null",
  ) as { origin: { x: number; y: number; z: number } };
  expect(workplane).not.toBeNull();
  expect(workplane.origin.z).toBe(0);

  // The same rectangle again, then extrude: the new feature must declare NO
  // datum input, so the scene follows the newest solid alone (3000 mm³ on
  // the default workplane) instead of composing base + datum-anchored pad
  // (6000 mm³) — the pad-composition fork is gated on exactly that input.
  await drawRectangle(page);
  const beforeExtrude = await dispatchedCount(page, ROOT);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  const plainVolume = await waitForRootSettle(page, {
    afterDispatch: beforeExtrude,
  });
  expect(
    volumeNear(Number(plainVolume), baseAnalytic),
    `plain re-entry ${plainVolume} vs analytic ${String(baseAnalytic)} — the new extrude re-declared the stale datum input`,
  ).toBe(true);
});

test("face anchors and the datum overlay track a resized viewport (live-size projection)", async ({
  page,
}) => {
  await openWorkbench(page);

  // The journey's document: base extrusion, then the face-anchored datum
  // and its pad — the composition whose top face and datum overlay marker
  // the resize below re-projects.
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await waitForRootSettle(page);
  const anchorsFirst = await readFaceAnchors(page, ROOT);
  const topFirst = faceWithNormal(anchorsFirst, TOP_NORMAL);
  await page.locator(`#${VIEWPORT_ID} canvas`).click({
    position: { x: topFirst.anchor.point[0], y: topFirst.anchor.point[1] },
  });
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    new RegExp(
      `^face\\|body_extrude\\d*\\|\\d+\\|${String(topFirst.faceIndex)}$`,
    ),
  );
  await page.locator(SKETCH_ON_FACE).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await waitForRootSettle(page);

  // The composed solid's top face (+z), selected through the published
  // anchor at the suite's fixed 1280×720 frame — the baseline click.
  const before = await readFaceAnchors(page, ROOT);
  const topBefore = faceWithNormal(before, TOP_NORMAL);
  const beforeJson = JSON.stringify(before);
  await page.locator(`#${VIEWPORT_ID} canvas`).click({
    position: { x: topBefore.anchor.point[0], y: topBefore.anchor.point[1] },
  });
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    new RegExp(
      `^face\\|body_extrude\\d*\\|\\d+\\|${String(topBefore.faceIndex)}$`,
    ),
  );

  // RESIZE mid-test to 1600×720: the viewport reflows to a wider, shorter
  // canvas. The engine re-projects the anchors at the LIVE canvas size, so
  // the surface must change before the re-click means anything.
  await page.setViewportSize({ width: 1600, height: 720 });
  await expect
    .poll(
      async () =>
        await page.locator(`#${ROOT}`).getAttribute("data-face-anchors"),
      "the anchor surface must re-project at the resized canvas",
    )
    .not.toBe(beforeJson);

  // THE REGRESSION: the identical semantic pick — the top face through its
  // published anchor — must still select the correct face at the resized
  // frame. A fixed-frame projection mis-projects at this size and the click
  // lands off the body entirely (an empty selection).
  const after = await readFaceAnchors(page, ROOT);
  const topAfter = faceWithNormal(after, TOP_NORMAL);
  await page.locator(`#${VIEWPORT_ID} canvas`).click({
    position: { x: topAfter.anchor.point[0], y: topAfter.anchor.point[1] },
  });
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    new RegExp(
      `^face\\|body_extrude\\d*\\|\\d+\\|${String(topAfter.faceIndex)}$`,
    ),
  );

  // The datum overlay must stay on the geometry: the marker's glyph box
  // (its 24×24 mm plane rectangle reaches from the datum's workplane-
  // origin corner INTO the body) overlaps the region the body's own
  // anchor points span — all of them live projections of on-body points
  // at this frame. A fixed-frame overlay drifts off the body at this
  // size; the overlap pins it to the live projection.
  const markerBox = await page
    .locator("[data-datum-overlay-marker]")
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        height: box.height,
        width: box.width,
        x: box.x,
        y: box.y,
      };
    });
  const canvasBox = await page.locator(`#${VIEWPORT_ID} canvas`).boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox === null) return;
  const marker = {
    left: markerBox.x - canvasBox.x,
    right: markerBox.x + markerBox.width - canvasBox.x,
    top: markerBox.y - canvasBox.y,
    bottom: markerBox.y + markerBox.height - canvasBox.y,
  };
  const xs = Object.values(after).map((anchor) => anchor.point[0]);
  const ys = Object.values(after).map((anchor) => anchor.point[1]);
  const inflation = 24;
  const body = {
    left: Math.min(...xs) - inflation,
    right: Math.max(...xs) + inflation,
    top: Math.min(...ys) - inflation,
    bottom: Math.max(...ys) + inflation,
  };
  expect(marker.right).toBeGreaterThan(body.left);
  expect(marker.left).toBeLessThan(body.right);
  expect(marker.bottom).toBeGreaterThan(body.top);
  expect(marker.top).toBeLessThan(body.bottom);

  // And the overlay's own frame contract, exactly: its SVG viewBox must BE
  // the live canvas size (a 1:1 pixel mapping), never the fixture's
  // authored 800×520 — a fixed-frame overlay letterboxes its markers into
  // the wrong pixels at every other window size.
  const overlayViewBox = await page
    .locator("svg[data-datum-overlay]")
    .evaluate((element) => element.getAttribute("viewBox"));
  expect(overlayViewBox).toBe(
    `0 0 ${String(Math.round(canvasBox.width))} ${String(
      Math.round(canvasBox.height),
    )}`,
  );
});
