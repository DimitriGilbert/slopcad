import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  faceSelectionKey,
  faceWithNormal,
  readFaceAnchors,
  readSelectionRegeneration,
  saveArtifact,
  waitForSelectionFrame,
  waitForSettledScene,
  waitForTreeSelectionFrame,
  type FaceAnchorSurface,
} from "./helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * Phase 27.3 radius/diameter e2e — the plan's validation: circles/arcs/
 * cylindrical geometry measured WHERE SUPPORTED, with semantic values and
 * correct units. Runs on the composed workbench (`/workbench`), driving the
 * same surfaces every other measurement rides: the viewport's face picks,
 * the model tree's body picks, the sketch → revolve journey, and the
 * Measurement block's Radius row.
 *
 *  - HONESTY (declines first) — the plate's planar top face declines
 *    `radius/not-cylindrical`; a body reference declines
 *    `radius/unresolvable-reference` (a body is a composition of faces,
 *    not one circle); with no selection the row shows nothing;
 *  - GROUND TRUTH — the sketch → revolve journey (rectangle (0,0)→(30,25),
 *    full sweep about X) produces the radius-25 cylinder; its wall face —
 *    the one curved face, published with a `null` mean normal — displays
 *    `R 25.000 mm` with its diameter dual `⌀ 50.000 mm` through the
 *    least-squares fit (the kernel's revolution vertices lie ON the true
 *    cylinder, so the fit reproduces the exact radius; the precision label
 *    `fit` says so on the source line);
 *  - UNITS — the value and its unit render as one readout, both
 *    presentations, three decimals.
 *
 * Machine surfaces: `data-radius` / `data-radius-diameter` (the dual
 * presentation), `data-radius-source` (what and how), and
 * `data-radius-declined` (the structured decline code). Clicks follow the
 * house rule: machine-derived face anchors and tree rows only.
 */

const ROOT = "workbench-root";
const VIEWPORT = "workbench-viewport";
const TREE = '[data-slot="cad-model-tree"]';
const READOUT = "#workbench-radius-readout";
const DIAMETER = "#workbench-radius-diameter";
const SOURCE = "#workbench-radius-source";
const TOP_NORMAL = [0, 0, 1] as const;
const CAP_NORMAL = [1, 0, 0] as const;
const PLATE_KEY = "body|body_plate";
const REVOLVE_BODY_ID = "body_revolve";
const SKETCH = "#sketch-root";
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';
const REVOLVE_BUTTON = '[data-testid="sketch-revolve"]';

/** The revolved rectangle: workplane (0,0) → (30,25) — a radius-25 cylinder. */
const RECT = { x0: 0, y0: 0, x1: 30, y1: 25 } as const;

/** The radius readout the Measurement block displays, as data. */
async function readRadius(page: Page): Promise<string> {
  return (await page.locator(`#${ROOT}`).getAttribute("data-radius")) ?? "";
}

/** The radius row's structured decline, as data. */
async function readRadiusDeclined(page: Page): Promise<string> {
  return (
    (await page.locator(`#${ROOT}`).getAttribute("data-radius-declined")) ?? ""
  );
}

/** Waits until the radius surface displays exactly `expected`. */
async function waitForRadius(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ id, want }) => {
      const root = document.getElementById(id);
      return root !== null && root.getAttribute("data-radius") === want;
    },
    { id: ROOT, want: expected },
  );
}

/** Waits until the radius row records exactly `expected` as its decline. */
async function waitForRadiusDeclined(
  page: Page,
  expected: string,
): Promise<void> {
  await page.waitForFunction(
    ({ id, want }) => {
      const root = document.getElementById(id);
      return (
        root !== null && root.getAttribute("data-radius-declined") === want
      );
    },
    { id: ROOT, want: expected },
  );
}

/** Clicks the viewport at a face's machine-derived anchor point. */
async function clickFace(
  page: Page,
  anchor: { readonly point: readonly [number, number] },
): Promise<void> {
  await page.locator(`#${VIEWPORT} canvas`).click({
    position: { x: anchor.point[0], y: anchor.point[1] },
  });
}

/** The tree row for a reference key (e.g. `body|body_plate`). */
function treeNode(page: Page, key: string) {
  return page.locator(`${TREE} [data-node-key="${key}"]`);
}

/**
 * The cylinder's wall face: of the revolve scene's three faces — two caps
 * and the wall — the caps carry the AXIAL mean normal (±x); the wall does
 * not (its representative normals wrap the turn, and the kernel's revolve
 * normals do not cancel to a single direction — published either as `null`
 * or as a non-axial mean). Selects the wall deterministically; throws when
 * the scene does not carry exactly one such face (the spec's assumption
 * broke).
 */
function wallFace(
  anchors: FaceAnchorSurface,
  bodyId: string,
): {
  readonly faceIndex: number;
  readonly anchor: { readonly point: readonly [number, number] };
} {
  const matches = Object.entries(anchors).filter(([key, anchor]) => {
    if (!key.startsWith(`${bodyId}/`)) return false;
    if (anchor.normal === null) return true;
    return Math.abs(anchor.normal[0]) < 0.5;
  });
  expect(matches.length, "exactly one wall (non-axial-normal) face").toBe(1);
  const first = matches[0];
  if (first === undefined) throw new Error("unreachable: matches asserted");
  const faceIndex = Number(first[0].split("/")[1]);
  expect(Number.isInteger(faceIndex), `face key "${first[0]}"`).toBe(true);
  return { faceIndex, anchor: first[1] };
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Draws the 30×25 axis-touching rectangle with the rectangle tool. */
async function drawRectangle(page: Page): Promise<void> {
  await page.locator('[data-sketch-tool-id="rectangle"]').click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "rectangle",
  );
  for (const [x, y] of [
    [RECT.x0, RECT.y0],
    [RECT.x1, RECT.y1],
  ] as const) {
    await page.locator(`${SKETCH} [data-sketch-surface]`).click({
      position: canvasPoint(x, y),
    });
  }
}

/** Runs the sketch → revolve journey to the settled radius-25 cylinder. */
async function runRectangleRevolveJourney(page: Page): Promise<void> {
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await drawRectangle(page);
  await page.locator(REVOLVE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "revolve",
  );
  await waitForSettledScene(page, ROOT);
}

test("the selected cylindrical face displays its known radius with its diameter dual", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // No selection, no radius request — the row shows nothing, no decline
  // recorded (silence, not refusal).
  expect(await readRadius(page)).toBe("");
  expect(await readRadiusDeclined(page)).toBe("");

  // HONESTY: the plate's planar top face declines, structured.
  const anchors = await readFaceAnchors(page, VIEWPORT);
  const revision = await readSelectionRegeneration(page, ROOT);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  await clickFace(page, top.anchor);
  await waitForSelectionFrame(
    page,
    faceSelectionKey(revision, top.faceIndex),
    ROOT,
  );
  await waitForRadiusDeclined(page, "radius/not-cylindrical");
  expect(await readRadius(page)).toBe("");

  // HONESTY: a body reference declines — a body is a composition of faces,
  // not one circle; the row names the refusal instead of guessing.
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);
  await waitForRadiusDeclined(page, "radius/unresolvable-reference");
  expect(await readRadius(page)).toBe("");

  // GROUND TRUTH: the sketch → revolve journey → the radius-25 cylinder.
  await runRectangleRevolveJourney(page);
  const revAnchors = await readFaceAnchors(page, VIEWPORT);
  const revRevision = await readSelectionRegeneration(page, ROOT);
  const wall = wallFace(revAnchors, REVOLVE_BODY_ID);
  await clickFace(page, wall.anchor);
  await waitForSelectionFrame(
    page,
    faceSelectionKey(revRevision, wall.faceIndex, REVOLVE_BODY_ID),
    ROOT,
  );
  await waitForRadius(page, "R 25.000 mm");
  await expect(page.locator(READOUT)).toHaveText("R 25.000 mm");
  // The dual presentation: the diameter, through the same unit
  // infrastructure, at the same three-decimal convention.
  await expect(page.locator(DIAMETER)).toHaveText("⌀ 50.000 mm");
  // Units correct: both values render with their unit as one readout.
  expect(await page.locator(READOUT).textContent()).toMatch(/ mm$/);
  expect(await page.locator(DIAMETER).textContent()).toMatch(/ mm$/);
  // The row names what it measures and HOW — a fit, not an exact.
  await expect(page.locator(SOURCE)).toHaveText("face (fit)");
  expect(
    await page.locator(`#${ROOT}`).getAttribute("data-radius-source"),
  ).toBe("face (fit)");
  expect(await readRadiusDeclined(page)).toBe("");

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact("radius-revolve-wall.png", await page.screenshot());

  // HONESTY on the same scene: a planar cap face declines, structured.
  const cap = faceWithNormal(revAnchors, CAP_NORMAL);
  await clickFace(page, cap.anchor);
  await waitForSelectionFrame(
    page,
    faceSelectionKey(revRevision, cap.faceIndex, REVOLVE_BODY_ID),
    ROOT,
  );
  await waitForRadiusDeclined(page, "radius/not-cylindrical");
  await waitForRadius(page, "");
  await expect(page.locator(READOUT)).toHaveCount(0);

  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await saveArtifact("radius-cap-declined.png", await page.screenshot());
});
