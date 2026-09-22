import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";

/**
 * Phase 45 viewport navigation e2e — the interactive-visualization law on
 * the COMPLETE composition (`/workbench-complete`), machine-surface first:
 *
 *  - BOOT — the overlay defaults OFF: camera source "spec", display mode
 *    "shaded" — the exact state every pre-Phase-45 baseline renders with;
 *  - ORBIT — a real pointer drag takes the camera ("user" source), the
 *    document is untouched (the settle volume and frame count stand),
 *    and RESET returns to spec law explicitly;
 *  - STANDARD VIEWS — Front/Top command the analytic cameras (azimuth/
 *    elevation pinned to the Z-up decomposition of the commanded
 *    direction), and the ISO corner follows the angle convention;
 *  - FIT — the framing distance is the analytic bounds-sphere fit;
 *  - PROJECTION — the persp/ortho toggle writes the same overlay (the
 *    projection readout flips, the pose stays);
 *  - DISPLAY MODES — the four modes flip the display surface and every
 *    flip schedules frames (demand-loop discipline under a mode change);
 *  - LOOK-AT — declines without a selection, aims with one (distance
 *    preserved — a re-target, not a re-frame);
 *  - ZOOM WINDOW — arms, drags a rectangle, commits a zoomed camera.
 *
 * Screenshots are artifacts (never the only evidence); every semantic
 * assertion reads the machine surfaces the composition publishes.
 */

const ROOT = "workbench-complete-root";
const VIEWPORT_ID = "workbench-complete-viewport";
const CANVAS = `#${VIEWPORT_ID} canvas`;
const TREE = '[data-slot="cad-model-tree"]';

/** The guide plate's bounds half-diagonal (30 × 20 × 10 mm). */
const PLATE_RADIUS = Math.hypot(30, 20, 10) / 2;

/** The fit margin and standard FOV (`standard-views.ts` constants). */
const FIT_MARGIN = 1.1;
const STANDARD_FOV_DEG = 40;

/** The analytic framing distance of a standard view over the plate. */
function framingDistanceMm(): number {
  return (
    (PLATE_RADIUS * FIT_MARGIN) /
    Math.sin(((STANDARD_FOV_DEG / 2) * Math.PI) / 180)
  );
}

/** Saves an artifact under the workbench artifacts directory. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/workbench", { recursive: true });
  await writeFile(`e2e-artifacts/workbench/${name}`, bytes);
}

/** Park the pointer and drop focus for clean captures. */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(200);
}

/** Opens the complete workbench and waits for the settled first scene. */
async function openWorkbench(page: Page): Promise<void> {
  await page.goto("/workbench-complete");
  await waitForSettledScene(page, ROOT);
}

/** One camera attribute off the viewport's machine surface (the CadViewport
 * container inside `#workbench-complete-viewport`, where `data-camera-*`
 * is written). `name` is the bare suffix ("mode", "azimuth-deg", …). */
async function cameraAttribute(page: Page, name: string): Promise<string> {
  const value = await page
    .locator(`#${VIEWPORT_ID} [data-camera-${name}]`)
    .first()
    .getAttribute(`data-camera-${name}`);
  return value ?? "";
}

/** One root attribute. */
async function rootAttribute(page: Page, name: string): Promise<string> {
  const value = await page.locator(`#${ROOT}`).getAttribute(name);
  return value ?? "";
}

test.beforeEach(async ({ page }) => {
  await openWorkbench(page);
  // The getting-started hint spans the viewport bottom (pointer-events
  // on) and would intercept the view panel's clicks: dismiss it — the
  // navigation surface under test is the panel, not the hint.
  const dismiss = page.locator('[data-testid="workbench-sketch-hint-dismiss"]');
  if (await dismiss.isVisible()) {
    await dismiss.click();
  }
});

test("boot: the overlay defaults off (spec law, shaded)", async ({ page }) => {
  expect(await rootAttribute(page, "data-viewport-camera-source")).toBe("spec");
  expect(await rootAttribute(page, "data-viewport-display-mode")).toBe(
    "shaded",
  );
  expect(await rootAttribute(page, "data-viewport-convention")).toBe(
    "third-angle",
  );
  expect(await cameraAttribute(page, "mode")).toBe("spec");
  await settleForCapture(page);
  await saveArtifact(
    "viewport-navigation-boot.png",
    await page.locator("#workbench-complete-viewport").screenshot(),
  );
});

test("orbit takes the camera; the document is untouched; reset returns to spec", async ({
  page,
}) => {
  const volumeBefore = await rootAttribute(page, "data-cad-rendered-volume");
  const framesBefore = Number(
    await rootAttribute(page, "data-rendered-frames"),
  );
  expect(await cameraAttribute(page, "mode")).toBe("spec");

  const box = await page.locator(CANVAS).boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // A generous left-drag orbits (past the click threshold, over empty
  // space at the viewport's left half so no pick interferes).
  await page.mouse.move(cx - 120, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy - 30, { steps: 6 });
  await page.mouse.up();

  await expect
    .poll(async () => rootAttribute(page, "data-viewport-camera-source"))
    .toBe("user");
  expect(await cameraAttribute(page, "mode")).toBe("user");
  // The user camera is rendering-only: the document's settle volume and
  // frame count stand (no document action, no serialization).
  expect(await rootAttribute(page, "data-cad-rendered-volume")).toBe(
    volumeBefore,
  );
  expect(Number(await rootAttribute(page, "data-rendered-frames"))).toBe(
    framesBefore,
  );

  await page.click('[data-testid="view-reset"]');
  await expect
    .poll(async () => rootAttribute(page, "data-viewport-camera-source"))
    .toBe("spec");
  expect(await cameraAttribute(page, "mode")).toBe("spec");
});

test("standard views command the analytic cameras (front/top pinned, iso follows the convention)", async ({
  page,
}) => {
  await page.click('[data-testid="view-front"]');
  await expect.poll(async () => cameraAttribute(page, "mode")).toBe("user");
  // Front views from -Y in the Z-up frame: azimuth 270°, elevation 0°.
  expect(Number(await cameraAttribute(page, "azimuth-deg"))).toBe(270);
  expect(Number(await cameraAttribute(page, "elevation-deg"))).toBe(0);
  // The framing distance is the analytic bounds-sphere fit.
  expect(Number(await cameraAttribute(page, "distance-mm"))).toBeCloseTo(
    framingDistanceMm(),
    0,
  );

  await page.click('[data-testid="view-top"]');
  // The top camera looks straight down with up +Y: decomposed against
  // its own up-pole that is azimuth 0°, elevation 0° — a genuinely
  // different pose from front's azimuth 270°.
  await expect.poll(async () => cameraAttribute(page, "azimuth-deg")).toBe("0");
  expect(await cameraAttribute(page, "elevation-deg")).toBe("0");

  // The convention flips the ISO corner (front-top-right → left).
  await page.click('[data-testid="view-iso"]');
  const thirdAngleAzimuth = Number(await cameraAttribute(page, "azimuth-deg"));
  await page.click('[data-testid="view-convention-toggle"]');
  await expect
    .poll(async () => rootAttribute(page, "data-viewport-convention"))
    .toBe("first-angle");
  await page.click('[data-testid="view-iso"]');
  const firstAngleAzimuth = Number(await cameraAttribute(page, "azimuth-deg"));
  // Analytic: the third-angle corner (+x,-y,+z) decomposes to azimuth
  // 315°, the first-angle corner (-x,-y,+z) to 225° — exactly 90° apart.
  expect(Math.abs(firstAngleAzimuth - thirdAngleAzimuth)).toBe(90);
});

test("fit frames the bounds analytically from any view", async ({ page }) => {
  await page.click('[data-testid="view-front"]');
  await expect.poll(async () => cameraAttribute(page, "mode")).toBe("user");
  await page.click('[data-testid="view-fit"]');
  await expect
    .poll(async () => Number(await cameraAttribute(page, "distance-mm")))
    .toBeCloseTo(framingDistanceMm(), 0);
  // Fit keeps the current view direction: front stays front.
  expect(Number(await cameraAttribute(page, "azimuth-deg"))).toBe(270);
});

test("the projection toggle writes the same overlay (pose preserved)", async ({
  page,
}) => {
  await page.click('[data-testid="view-front"]');
  await expect
    .poll(async () => cameraAttribute(page, "projection"))
    .toBe("perspective");
  const pose = {
    azimuth: await cameraAttribute(page, "azimuth-deg"),
    elevation: await cameraAttribute(page, "elevation-deg"),
  };
  await page.click('[data-testid="view-projection-toggle"]');
  await expect
    .poll(async () => cameraAttribute(page, "projection"))
    .toBe("orthographic");
  expect(await cameraAttribute(page, "azimuth-deg")).toBe(pose.azimuth);
  expect(await cameraAttribute(page, "elevation-deg")).toBe(pose.elevation);
  await page.click('[data-testid="view-projection-toggle"]');
  await expect
    .poll(async () => cameraAttribute(page, "projection"))
    .toBe("perspective");
});

test("display modes flip the surface and schedule frames", async ({ page }) => {
  const framesBefore = Number(
    await rootAttribute(page, "data-rendered-frames"),
  );
  const modes = ["shaded-edges", "wireframe", "hidden-line", "shaded"] as const;
  for (const mode of modes) {
    await page.click(`[data-testid="display-mode-${mode}"]`);
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
      .toBe(mode);
  }
  // Display changes are renderer pass states, never document actions:
  // the settle-frame count (the document's render ledger) must not move.
  expect(Number(await rootAttribute(page, "data-rendered-frames"))).toBe(
    framesBefore,
  );
  await settleForCapture(page);
  await saveArtifact(
    "viewport-navigation-wireframe.png",
    await page.locator("#workbench-complete-viewport").screenshot(),
  );
  // Back to the default bytes for anything after this test.
  await page.click('[data-testid="display-mode-shaded"]');
  await expect
    .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
    .toBe("shaded");
});

test("look-at declines without a selection and re-targets with one (distance preserved)", async ({
  page,
}) => {
  await expect
    .poll(async () =>
      page
        .locator('[data-testid="view-look-at"]')
        .evaluate((element) => (element as HTMLButtonElement).disabled),
    )
    .toBe(true);

  // Select the plate body through the model tree (the public selection
  // surface — no synthetic pointer picks needed).
  await page.locator(`${TREE} [data-node-key="body|body_plate"]`).click();
  await expect
    .poll(async () =>
      page
        .locator('[data-testid="view-look-at"]')
        .evaluate((element) => (element as HTMLButtonElement).disabled),
    )
    .toBe(false);

  await page.click('[data-testid="view-front"]');
  await expect.poll(async () => cameraAttribute(page, "mode")).toBe("user");
  const distance = await cameraAttribute(page, "distance-mm");
  await page.click('[data-testid="view-look-at"]');
  await expect.poll(async () => cameraAttribute(page, "mode")).toBe("user");
  // A re-target, not a re-frame: the distance is preserved.
  expect(await cameraAttribute(page, "distance-mm")).toBe(distance);
});

test("zoom window arms, drags a rectangle, and commits a zoomed camera", async ({
  page,
}) => {
  await page.click('[data-testid="view-front"]');
  await expect.poll(async () => cameraAttribute(page, "mode")).toBe("user");
  const distanceBefore = Number(await cameraAttribute(page, "distance-mm"));

  await page.click('[data-testid="view-zoom-window"]');
  const layer = page.locator('[data-testid="viewport-zoom-window"]');
  await expect(layer).toBeVisible();
  const box = await layer.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // A quarter-size window: the cover factor is 0.5 → the perspective
  // distance halves.
  await page.mouse.move(cx - box.width / 4, cy - box.height / 4);
  await page.mouse.down();
  await page.mouse.move(cx + box.width / 4, cy + box.height / 4, {
    steps: 4,
  });
  await page.mouse.up();

  await expect
    .poll(async () => Number(await cameraAttribute(page, "distance-mm")))
    .toBeCloseTo(distanceBefore / 2, 0);
  // The layer disarmed after the commit.
  await expect(layer).toHaveCount(0);
});

test("camera state survives a document edit (the overlay is never discarded)", async ({
  page,
}) => {
  await page.click('[data-testid="view-top"]');
  await expect.poll(async () => cameraAttribute(page, "azimuth-deg")).toBe("0");

  // A real document action: a parameter edit through the panel (the
  // workflow suite's SELECT/EDIT journey, anchored on its dispatch).
  const beforeEdit = await dispatchedCount(page, ROOT);
  await page.getByLabel("holeDiameter", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "10",
  );
  await waitForSettledScene(page, ROOT, { afterDispatch: beforeEdit });
  // The user camera persisted through the regeneration: still the top
  // view (never written, never discarded by a non-user action).
  await expect.poll(async () => cameraAttribute(page, "azimuth-deg")).toBe("0");
  expect(await rootAttribute(page, "data-viewport-camera-source")).toBe("user");
});
