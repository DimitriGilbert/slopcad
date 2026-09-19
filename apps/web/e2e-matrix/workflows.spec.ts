import { mkdir, writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";

/**
 * Phase 35.3 browser compatibility matrix — the DOM-level core workbench
 * battery, engine-portable by construction: every assertion reads the
 * workbench's machine surfaces (data attributes, the model tree, the
 * panels, the worker-computed volumes) and never the rendered frame, so
 * the same spec runs unchanged on Chromium, Firefox, and WebKit.
 *
 * Firefox runs exactly this battery: headless Firefox has no WebGL on this
 * host (no GPU, no Xvfb, no sudo), so its render-stamp coverage is the
 * explicit reasoned skip in `render-settle.spec.ts`, while the parametric
 * model — kernel worker, document, parameters, features, timeline, tools,
 * export bytes — is proven here for all three engines.
 *
 * The companion `render-settle.spec.ts` adds the WebGL-settle workflows on
 * the engines with software WebGL (Chromium + WebKit).
 */

const ROOT = "workbench-complete-root";
const TREE = '[data-slot="cad-model-tree"]';
const PROPERTY = '[data-slot="cad-property-panel"]';
const TOOLBAR = '[data-slot="cad-toolbar"]';
const MODE_TOGGLE = '[data-testid="complete-mode-toggle"]';
const HOLE_BUTTON = '[data-testid="complete-hole"]';
const EXPORT_BUTTON = '[data-testid="complete-export"]';
const UNDO_BUTTON = 'button[aria-label="Undo"]';
const REDO_BUTTON = 'button[aria-label="Redo"]';
const SKETCH = "#sketch-root";
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';

/** The sketch rectangle the create journeys draw (workplane mm). */
const RECT = {
  x0: 10,
  y0: 10,
  x1: 30,
  y1: 25,
} as const;

/** Relative volume tolerance (the render suite's documented band). */
const VOLUME_REL_TOLERANCE = 0.005;

/** Saves a per-engine artifact under the matrix artifacts directory. */
async function saveArtifact(
  testInfo: TestInfo,
  name: string,
  bytes: Buffer,
): Promise<void> {
  await mkdir("e2e-artifacts/matrix", { recursive: true });
  await writeFile(
    `e2e-artifacts/matrix/${testInfo.project.name}-${name}`,
    bytes,
  );
}

/** Capture discipline: park the pointer, drop focus, let transitions run. */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(300);
}

/**
 * Waits for NUMERIC settle — the engine-portable form of the render
 * harness's settle: the worker has no computation in flight and the
 * volume attribute exists and is stable across two polls. (The render
 * stamp itself is the WebGL battery's concern; Firefox cannot produce
 * one, and every engine can produce this.)
 *
 * "Stable across two polls" means two CONSECUTIVE quiescent polls that
 * agree — never a baseline pinned to the first observation: a first poll
 * that lands in the post-commit/pre-dispatch window reads the OLD volume,
 * and a pinned baseline could then never match the post-settle NEW volume
 * (a guaranteed 30 s hang). Tracking the previous quiescent poll lets the
 * wait self-heal through the transition instead.
 */
async function waitForNumericSettle(page: Page): Promise<string> {
  const deadline = Date.now() + 30_000;
  let previous = "";
  while (Date.now() < deadline) {
    const state = await page.evaluate((rootId) => {
      const root = document.getElementById(rootId);
      return {
        inFlight: root?.getAttribute("data-in-flight") ?? null,
        volume: root?.getAttribute("data-volume") ?? "",
      };
    }, ROOT);
    if (state.inFlight === "0" && state.volume !== "") {
      if (previous === state.volume) return state.volume;
      previous = state.volume;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("The workbench never reached numeric settle.");
}

/** Opens the complete workbench and waits for the numeric settle. */
async function openWorkbench(page: Page): Promise<string> {
  await page.goto("/workbench-complete");
  return waitForNumericSettle(page);
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Draws the rectangle with the rectangle tool (two corner picks). */
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

test("the workbench boots and every surface reports honestly", async ({
  page,
}, testInfo) => {
  const volume = await openWorkbench(page);
  expect(Number(volume)).toBeGreaterThan(0);

  await expect(
    page.locator(`${TOOLBAR} button[data-tool-id="select"]`),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(`${TREE} [data-node-key="feature|feat_translate_plate"]`),
  ).toBeVisible();
  await expect(
    page.locator(`${TREE} [data-node-key="body|body_plate"]`),
  ).toBeVisible();
  await expect(page.locator(PROPERTY)).toContainText("Nothing selected.");
  await expect(page.getByLabel("holeDiameter", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="cad-status-bar"]')).toContainText(
    "tool = select (active)",
  );
  const timeline = JSON.parse(
    (await page.locator(`#${ROOT}`).getAttribute("data-feature-timeline")) ??
      "{}",
  ) as { entries: { kind: string }[] };
  expect(timeline.entries.map((entry) => entry.kind)).toEqual([
    "translate",
    "rotate",
  ]);

  await settleForCapture(page);
  await saveArtifact(testInfo, "fresh-open.png", await page.screenshot());
});

test("select, edit, regenerate, undo, and redo through the panels", async ({
  page,
}) => {
  const bootVolume = await openWorkbench(page);

  await page.locator(`${TREE} [data-node-key="body|body_plate"]`).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    "body|body_plate",
  );
  await expect(page.locator(PROPERTY)).toContainText("Produced by");

  await page.getByLabel("holeDiameter", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "10",
  );
  const editedVolume = await waitForNumericSettle(page);
  expect(editedVolume).not.toBe(bootVolume);

  await expect(page.locator(UNDO_BUTTON)).toBeEnabled();
  await page.locator(UNDO_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "8",
  );
  expect(await waitForNumericSettle(page)).toBe(bootVolume);
  await expect(page.locator(REDO_BUTTON)).toBeEnabled();
  await page.locator(REDO_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "10",
  );
  await waitForNumericSettle(page);
});

test("create: sketch, extrude, and hole land on the timeline", async ({
  page,
}) => {
  await openWorkbench(page);

  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await drawRectangle(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  const extrudedVolume = await waitForNumericSettle(page);
  const analytic =
    (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;
  expect(
    volumeNear(Number(extrudedVolume), analytic),
    `extruded ${extrudedVolume} vs analytic ${String(analytic)}`,
  ).toBe(true);

  await page.locator(HOLE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "hole",
  );
  const holedVolume = await waitForNumericSettle(page);
  expect(Number(holedVolume), "a hole removes material").toBeLessThan(
    Number(extrudedVolume),
  );

  const timeline = JSON.parse(
    (await page.locator(`#${ROOT}`).getAttribute("data-feature-timeline")) ??
      "{}",
  ) as { entries: { kind: string; status: string }[] };
  expect(timeline.entries.map((entry) => entry.kind)).toEqual([
    "translate",
    "rotate",
    "extrude",
    "hole",
  ]);
  for (const entry of timeline.entries) {
    expect(entry.status).toBe("valid");
  }

  await page.locator(UNDO_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForNumericSettle(page);
});

test("the command menu and toolbar run tools from the keyboard", async ({
  page,
}) => {
  await openWorkbench(page);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-command-menu-open",
    "true",
  );
  await page.keyboard.type("measure");
  await page.keyboard.press("Enter");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-tool-id",
    "measure",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-tool-phase",
    "active",
  );

  await page.locator(`${TOOLBAR} button[data-tool-id="select"]`).focus();
  await page.keyboard.press("1");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-tool-id",
    "select",
  );

  await page
    .locator('#workbench-complete-viewport [aria-label="CAD viewport"]')
    .focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-tool-phase",
    "cancelled",
  );
});

test("export holds real STL bytes for the export formats", async ({
  page,
}, testInfo) => {
  await openWorkbench(page);

  await page.locator(EXPORT_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-export-dialog-open",
    "true",
  );
  await expect(page.locator("[data-cad-export-dialog]")).toBeVisible();
  // The dialog artifact is captured on Chromium and Firefox only. Headless
  // WPE WebKit INTERMITTENTLY never paints the dialog overlay into its
  // composited screen surface: in the validated Phase 35 matrix run, both
  // the recorded video and page.screenshot() showed the dialog-less
  // workbench while the two DOM assertions above genuinely passed, and a
  // same-config isolated probe DID capture the overlay — so the surface is
  // flaky, not deterministically capturable (no screenshot option — clip,
  // element shot, animations/caret — can recover pixels the compositor
  // never painted). Keeping the capture would silently produce a
  // dialog-less "export-dialog.png"; the DOM assertions are the real
  // coverage on WebKit.
  if (testInfo.project.name !== "webkit") {
    await saveArtifact(testInfo, "export-dialog.png", await page.screenshot());
  }
  await page.getByTestId("cad-export-run-stl").click();
  const entry = page.locator('[data-cad-export-entry="stl"]');
  await expect(entry).toContainText("triangles");
  const heldRaw = await page
    .locator(`#${ROOT}`)
    .getAttribute("data-export-held");
  const held = JSON.parse(heldRaw ?? "{}") as Record<string, number>;
  expect(held.stl).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-export-dialog-open",
    "false",
  );
});
