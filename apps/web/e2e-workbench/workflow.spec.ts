import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";

/**
 * Phase 28 complete-workbench workflow e2e — the plan's workflow gate on
 * the COMPLETE composition (`/workbench-complete`): the eight surfaces
 * (toolbar, command menu, viewport, model tree, property panel, parameter
 * panel, history timeline, status bar) plus the import/export dialogs, on
 * the production build under the determinism setup (SwiftShader, fixed
 * 1280x720 DPR 1, one worker, video on).
 *
 * The battery:
 *  - OPEN — the complete workbench boots, settles, and every surface
 *    reports its honest initial state (fresh-open screenshot artifact);
 *  - SELECT/EDIT/REGENERATE — a tree pick selects, the property panel
 *    derives the body's provenance, a panel edit commits one `parameter.set`
 *    and the scene regenerates, and undo/redo round-trips the volume
 *    (selection screenshot artifact);
 *  - CREATE — the sketch → extrude bridge commits a real feature and the
 *    worker executes it at the analytic volume; the hole bridge cuts it;
 *    the timeline carries the whole history (history screenshot artifact);
 *  - KEYBOARD — Ctrl+K opens the command menu, typed query + Enter arms
 *    the measure tool, a toolbar digit re-arms select, and Escape cancels
 *    the live tool;
 *  - EXPORT/IMPORT — the export dialog holds real STL bytes, the held
 *    round trip previews the imported mesh under its truth-telling chip
 *    and returns honestly (export-dialog + import-preview artifacts);
 *  - REMOVE — the property panel's delete action commits `feature.delete`
 *    through the command vocabulary, and undo restores it.
 *
 * Every clicked sketch point derives from the documented canvas transform
 * (`SKETCH_CANVAS`, the same source the render suite imports); every
 * semantic assertion reads the machine surfaces, with screenshots as
 * artifacts, never as the only evidence.
 */

const ROOT = "workbench-complete-root";
const TREE = '[data-slot="cad-model-tree"]';
const PROPERTY = '[data-slot="cad-property-panel"]';
const TOOLBAR = '[data-slot="cad-toolbar"]';
const MODE_TOGGLE = '[data-testid="complete-mode-toggle"]';
const HOLE_BUTTON = '[data-testid="complete-hole"]';
const EXPORT_BUTTON = '[data-testid="complete-export"]';
const IMPORT_BUTTON = '[data-testid="complete-import"]';
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

/** The harness's fixed inline size (playwright.workbench.config's viewport). */
const VIEWPORT_INLINE_PX = 1280;

/** Saves an artifact under the workbench artifacts directory. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/workbench", { recursive: true });
  await writeFile(`e2e-artifacts/workbench/${name}`, bytes);
}

/**
 * Capture discipline: park the pointer off every surface (no hover fills),
 * drop focus (no caret or focus ring in the frame), let transitions run.
 */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(300);
}

/** Opens the complete workbench and waits for the settled first scene. */
async function openWorkbench(page: Page): Promise<string> {
  await page.goto("/workbench-complete");
  return waitForSettledScene(page, ROOT);
}

/** Waits until the root's settle stamp agrees with the settled volume. */
async function waitForRootSettle(page: Page): Promise<string> {
  return waitForSettledScene(page, ROOT);
}

/**
 * The overflow pin: a settled workbench must never widen the page. The
 * scrolling feature timeline keeps a growing chip chain INSIDE its group
 * (the timeline group's `[contain:inline-size]` discipline), so the
 * document's inline size stays at the harness viewport's; the status
 * bar's dense row stays one h-7 line that its content never spills out
 * of. Asserts only after the settle protocol — never on a bare load.
 */
async function assertNoChromeOverflow(page: Page): Promise<void> {
  const pageWidths = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(
    pageWidths.document,
    `documentElement.scrollWidth ${String(pageWidths.document)} exceeds the ${String(VIEWPORT_INLINE_PX)}px viewport`,
  ).toBeLessThanOrEqual(VIEWPORT_INLINE_PX);
  expect(
    pageWidths.body,
    `body.scrollWidth ${String(pageWidths.body)} exceeds the ${String(VIEWPORT_INLINE_PX)}px viewport`,
  ).toBeLessThanOrEqual(VIEWPORT_INLINE_PX);
  const bar = await page.evaluate(() => {
    const element = document.querySelector('[data-slot="cad-status-bar"]');
    if (element === null) return null;
    return {
      height: element.getBoundingClientRect().height,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  expect(bar, "the status bar must be mounted").not.toBeNull();
  expect(bar?.height, "the status bar row must keep its h-7 height").toBe(28);
  expect(
    bar?.scrollWidth,
    "the status bar row must not scroll its content",
  ).toBeLessThanOrEqual(bar?.clientWidth ?? 0);
}

/** The parsed history surface. */
interface HistorySurface {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly cursor: number;
  readonly depth: number;
}

/** The parsed feature-timeline surface. */
interface TimelineSurface {
  readonly rollback: unknown;
  readonly entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
  }[];
  readonly executed: readonly string[];
}

/** One read of the root's machine surface (parsed attributes). */
async function readSurface(page: Page): Promise<{
  readonly selectionKey: string;
  readonly toolId: string;
  readonly toolPhase: string;
  readonly history: HistorySurface;
  readonly timeline: TimelineSurface;
  readonly commandCount: number;
  readonly sceneKind: string;
  readonly viewportShowing: string;
  readonly importVolume: string;
  readonly importedSettle: string;
  readonly commandMenuOpen: string;
  readonly exportDialogOpen: string;
  readonly importDialogOpen: string;
}> {
  const root = page.locator(`#${ROOT}`);
  const attr = async (name: string): Promise<string> => {
    const value = await root.getAttribute(name);
    expect(value, `${name} must exist`).not.toBeNull();
    return value ?? "";
  };
  const commandLog = JSON.parse(await attr("data-command-log")) as unknown[];
  return {
    selectionKey: await attr("data-selection-key"),
    toolId: await attr("data-tool-id"),
    toolPhase: await attr("data-tool-phase"),
    history: JSON.parse(await attr("data-history")) as HistorySurface,
    timeline: JSON.parse(
      await attr("data-feature-timeline"),
    ) as TimelineSurface,
    commandCount: commandLog.length,
    sceneKind: await attr("data-scene-kind"),
    viewportShowing: await attr("data-viewport-showing"),
    importVolume: await attr("data-import-volume"),
    importedSettle: await root
      .getAttribute("data-cad-imported-volume")
      .then((value) => value ?? ""),
    commandMenuOpen: await attr("data-command-menu-open"),
    exportDialogOpen: await attr("data-export-dialog-open"),
    importDialogOpen: await attr("data-import-dialog-open"),
  };
}

/** Waits until the import preview's settle stamp agrees with its volume. */
async function waitForImportPreviewSettled(page: Page): Promise<void> {
  await page.waitForFunction((rootId) => {
    const root = document.getElementById(rootId);
    const volume = root?.getAttribute("data-import-volume") ?? "";
    const settle = root?.getAttribute("data-cad-imported-volume") ?? "";
    return volume !== "" && volume === settle;
  }, ROOT);
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Activates a sketch tool through the sketch toolbar. */
async function activateSketchTool(page: Page, toolId: string): Promise<void> {
  await page.locator(`[data-sketch-tool-id="${toolId}"]`).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    toolId,
  );
}

/** Draws the 20x15 rectangle with the rectangle tool (two corner picks). */
async function drawRectangle(page: Page): Promise<void> {
  await activateSketchTool(page, "rectangle");
  const surface = page.locator(`${SKETCH} [data-sketch-surface]`);
  const first = canvasPoint(RECT.x0, RECT.y0);
  const second = canvasPoint(RECT.x1, RECT.y1);
  await surface.click({ position: first });
  await surface.click({ position: second });
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

test("the complete workbench opens and every surface reports", async ({
  page,
}) => {
  const volume = await openWorkbench(page);
  expect(Number(volume)).toBeGreaterThan(0);

  // The toolbar mirrors the registry with select live.
  await expect(
    page.locator(`${TOOLBAR} button[data-tool-id="select"]`),
  ).toHaveAttribute("aria-pressed", "true");
  // The model tree derives the document (two features, one body row).
  await expect(
    page.locator(`${TREE} [data-node-key="feature|feat_translate_plate"]`),
  ).toBeVisible();
  await expect(
    page.locator(`${TREE} [data-node-key="feature|feat_rotate_plate"]`),
  ).toBeVisible();
  await expect(
    page.locator(`${TREE} [data-node-key="body|body_plate"]`),
  ).toBeVisible();
  // The property panel starts at its honest empty state.
  await expect(page.locator(PROPERTY)).toContainText("Nothing selected.");
  // The parameter panel shows the document's parameters.
  await expect(page.getByLabel("holeDiameter", { exact: true })).toBeVisible();
  // The status bar mirrors the store and the session's spans exist.
  await expect(page.locator('[data-slot="cad-status-bar"]')).toContainText(
    "tool = select (active)",
  );
  // The timeline carries both features, all valid, none executed-yet.
  const surface = await readSurface(page);
  void surface.commandCount;
  expect(surface.timeline.entries.map((entry) => entry.kind)).toEqual([
    "translate",
    "rotate",
  ]);
  // The boot derivation's first run executes both features (the executed
  // sequence is per-run, and this run had no prior results to reuse).
  expect(surface.timeline.executed).toEqual([
    "feat_translate_plate",
    "feat_rotate_plate",
  ]);
  expect(surface.history).toEqual({
    canUndo: false,
    canRedo: false,
    cursor: 0,
    depth: 0,
  });
  expect(surface.toolId).toBe("select");
  expect(surface.toolPhase).toBe("active");
  expect(surface.sceneKind).toBe("plate");
  expect(surface.viewportShowing).toBe("document");

  await settleForCapture(page);
  await assertNoChromeOverflow(page);
  await saveArtifact(
    "complete-workbench-fresh-open.png",
    await page.screenshot(),
  );
});

test("select, inspect, edit, regenerate, undo, and redo", async ({ page }) => {
  const bootVolume = await openWorkbench(page);

  // SELECT through the tree (the stable body reference).
  await page.locator(`${TREE} [data-node-key="body|body_plate"]`).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    "body|body_plate",
  );

  // INSPECT: the property panel derives the body's provenance.
  await expect(page.locator(PROPERTY)).toContainText("plate");
  await expect(page.locator(PROPERTY)).toContainText("body_plate");
  await expect(page.locator(PROPERTY)).toContainText("Produced by");

  await settleForCapture(page);
  await saveArtifact(
    "complete-workbench-selection.png",
    await page.screenshot(),
  );

  // EDIT through the parameter panel (one parameter.set transaction).
  await page.getByLabel("holeDiameter", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "10",
  );
  const editedVolume = await waitForRootSettle(page);
  expect(volumeNear(Number(editedVolume), Number(bootVolume))).toBe(false);

  // The history grew; undo reverts the volume exactly; redo re-applies.
  await expect(page.locator(UNDO_BUTTON)).toBeEnabled();
  await page.locator(UNDO_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "8",
  );
  const undoneVolume = await waitForRootSettle(page);
  expect(undoneVolume).toBe(bootVolume);
  await expect(page.locator(REDO_BUTTON)).toBeEnabled();
  await page.locator(REDO_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "10",
  );
  await waitForRootSettle(page);
});

test("create: sketch, extrude, and hole land on the timeline", async ({
  page,
}) => {
  await openWorkbench(page);

  // CREATE 1: the sketch -> extrude bridge (real feature, real kernel run).
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
  const extrudedVolume = await waitForRootSettle(page);
  const analytic =
    (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;
  expect(
    volumeNear(Number(extrudedVolume), analytic),
    `extruded ${extrudedVolume} vs analytic ${String(analytic)}`,
  ).toBe(true);

  // CREATE 2: the hole bridge cuts the new extrusion (parameter-driven).
  await page.locator(HOLE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "hole",
  );
  const holedVolume = await waitForRootSettle(page);
  expect(Number(holedVolume), "a hole removes material").toBeLessThan(
    Number(extrudedVolume),
  );

  // HISTORY: four features, all valid, every one executed by the last run.
  const surface = await readSurface(page);
  expect(surface.timeline.entries.map((entry) => entry.kind)).toEqual([
    "translate",
    "rotate",
    "extrude",
    "hole",
  ]);
  for (const entry of surface.timeline.entries) {
    expect(entry.status).toBe("valid");
  }
  // `executed` is the LAST RUN's sequence: the hole create marked exactly
  // the new node stale, so the incremental run executed the hole alone.
  expect(surface.timeline.executed).toEqual(["feat_hole1"]);
  expect(surface.history.canUndo).toBe(true);

  // UNDO removes the hole feature; the scene falls back honestly.
  await page.locator(UNDO_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  await waitForRootSettle(page);

  await settleForCapture(page);
  await assertNoChromeOverflow(page);
  await saveArtifact("complete-workbench-history.png", await page.screenshot());
});

test("the command menu and toolbar run tools from the keyboard", async ({
  page,
}) => {
  await openWorkbench(page);

  // Ctrl+K opens the menu; typing filters; Enter runs the top command.
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

  // A toolbar digit re-arms select: the container owns the digit keys.
  await page.locator(`${TOOLBAR} button[data-tool-id="select"]`).focus();
  await page.keyboard.press("1");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-tool-id",
    "select",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-tool-phase",
    "active",
  );

  // Escape cancels the live activation (the viewport's documented
  // surface): the focusable container owns the key handling.
  await page
    .locator('#workbench-complete-viewport [aria-label="CAD viewport"]')
    .focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-tool-phase",
    "cancelled",
  );
});

test("export holds real bytes and the import round trip previews honestly", async ({
  page,
}) => {
  const volume = await openWorkbench(page);

  // EXPORT: the dialog lists the formats; STL holds real, sized bytes.
  await page.locator(EXPORT_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-export-dialog-open",
    "true",
  );
  await expect(page.locator("[data-cad-export-dialog]")).toBeVisible();
  await settleForCapture(page);
  await saveArtifact(
    "complete-workbench-export-dialog.png",
    await page.screenshot(),
  );
  await page.getByTestId("cad-export-run-stl").click();
  const entry = page.locator('[data-cad-export-entry="stl"]');
  await expect(entry).toContainText("triangles");
  const heldRaw = await page
    .locator(`#${ROOT}`)
    .getAttribute("data-export-held");
  const held = JSON.parse(heldRaw ?? "{}") as Record<string, number>;
  expect(held.stl).toBeGreaterThan(0);
  // Escape closes the dialog (the dialog primitive's own discipline).
  await page.keyboard.press("Escape");

  // IMPORT: the held STL round-trips into the honest geometry preview.
  await page.locator(IMPORT_BUTTON).click();
  await expect(page.locator("[data-cad-import-dialog]")).toBeVisible();
  await page.getByTestId("cad-import-held-stl").click();
  // A successful import closes the dialog: the result is the preview
  // itself, now visible in the viewport under its truth-telling chip.
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-import-dialog-open",
    "false",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-viewport-showing",
    "import",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-import-source",
    "stl",
  );
  await waitForImportPreviewSettled(page);
  const surface = await readSurface(page);
  expect(volumeNear(Number(surface.importVolume), Number(volume))).toBe(true);
  expect(surface.importedSettle).toBe(surface.importVolume);

  await settleForCapture(page);
  await saveArtifact(
    "complete-workbench-import-preview.png",
    await page.screenshot(),
  );

  // BACK: one click returns the viewport to the parametric document.
  await page.getByTestId("complete-clear-import").click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-viewport-showing",
    "document",
  );
  const returned = await waitForRootSettle(page);
  expect(returned).toBe(volume);
});

test("feature removal rides the command vocabulary and undo restores it", async ({
  page,
}) => {
  await openWorkbench(page);

  // A feature with dependents refuses deletion STRUCTURALLY: selecting the
  // upstream translate and deleting surfaces the domain's verbatim refusal
  // in the panel's alert region, and NOTHING is issued.
  await page
    .locator(`${TREE} [data-node-key="feature|feat_translate_plate"]`)
    .click({ position: { x: 40, y: 12 } });
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection-key",
    "feature|feat_translate_plate",
  );
  await page
    .locator(PROPERTY)
    .getByRole("button", { name: "Delete feature" })
    .click();
  await expect(page.locator(PROPERTY)).toContainText(
    "transaction/command-failed",
  );
  await expect(page.locator(PROPERTY)).toContainText(
    'referenced by feature "feat_rotate_plate"',
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-command-log",
    "[]",
  );

  // REMOVE the downstream leaf: one feature.delete transaction; the
  // timeline loses the feature.
  await page
    .locator(`${TREE} [data-node-key="feature|feat_rotate_plate"]`)
    .click({ position: { x: 40, y: 12 } });
  await page
    .locator(PROPERTY)
    .getByRole("button", { name: "Delete feature" })
    .click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-command-log",
    /feature\.delete/,
  );
  const surface = await readSurface(page);
  expect(surface.timeline.entries.map((entry) => entry.kind)).toEqual([
    "translate",
  ]);

  // UNDO restores the feature exactly.
  await page.locator(UNDO_BUTTON).click();
  const restored = await readSurface(page);
  expect(restored.timeline.entries.map((entry) => entry.kind)).toEqual([
    "translate",
    "rotate",
  ]);
});
