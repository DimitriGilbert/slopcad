import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  clickFaceAnchor,
  type CaptureRect,
  type DiffBounds,
  diffElementCaptures,
  faceSelectionKey,
  faceWithNormal,
  readFaceAnchors,
  readRenderedFrames,
  readSelection,
  readSelectionRegeneration,
  saveArtifact,
  sha256,
  waitForSelectionFrame,
  waitForSettledScene,
  waitForTreeSelectionFrame,
} from "./helpers";

/**
 * Phase 15 phase-level e2e — the COMPOSED workbench (`/workbench`), the
 * browser gate for "all four components work together in one browser
 * workbench". The page mounts `CadToolbar`, `CadViewport`, `CadModelTree`,
 * and `CadParameterPanel` around one real document through one
 * `CadProvider` store, and REPLACES the Phase 14 hand-rolled workbench
 * fixture: every flow the old fixture asserted through hand-wired controls
 * now runs through the components' own provider-driven surfaces, and this
 * spec is the ported form of the Phase 14 assertions (parameter edit
 * commits a `parameter.set` transaction and settles a new volume; undo and
 * redo revert and re-apply the document; invalid expressions issue
 * nothing; tool activation and selection run through the hooks).
 *
 * The plan's browser scenario, with the five plan-mandated screenshot
 * baselines, each byte-stable under the established settle discipline
 * (pointer parked, transitions settled, frames nudged where interactions
 * do not generate canvas events):
 *
 *  - INITIAL — the composed page (toolbar top, tree left, panel right,
 *    viewport dominant, status bar) settles byte-stable across two full
 *    runs, and a fresh load in a later test reproduces those exact bytes;
 *  - SELECTED — a tree click selects the plate body, the highlight reaches
 *    a rendered frame, the canvas change LOCALIZES to the model's screen
 *    region (pixel diff, no overlay DOM to mask), and clear → re-select
 *    through the components' own surfaces reproduces the exact bytes;
 *  - PARAMETER EDITOR — the focused mid-edit Formedible field (Playwright
 *    hides the caret) is byte-reproduced on re-entry, then commits one
 *    canonical transaction and the settled volume follows the document;
 *  - REGENERATED — the post-edit page and canvas are captured, the canvas
 *    diff against the pre-edit frame localizes to the model region, and
 *    the undo/redo history round-trip restores the EXACT bytes;
 *  - ERROR — an invalid expression surfaces the domain's structured
 *    failure as a visible field error, Apply disables, NOTHING is issued
 *    (command log, volume, frames all stay put), the page bytes differ
 *    from the initial baseline, and re-entering the error reproduces them.
 *
 * Byte comparisons use Playwright `Buffer.equals`. The viewport has no
 * overlay slot, so canvas-element captures contain only canvas pixels and
 * need no masks. Every pixel assertion stands beside a numeric/DOM
 * assertion. Point derivation follows the Phase 12 rule: every clicked
 * point comes from the fixture's face-anchor surface, never a guessed
 * pixel.
 */

const ROOT = "workbench-root";
const VIEWPORT = "workbench-viewport";
const CANVAS = "#workbench-viewport canvas";
const TREE = '[data-slot="cad-model-tree"]';
const PANEL = '[data-slot="cad-parameter-panel"]';
const TOOLBAR = '[data-slot="cad-toolbar"]';
const PLATE_KEY = "body|body_plate";
const FEATURE_KEY = "feature|feat_rotate_plate";
const TOP_NORMAL = [0, 0, 1] as const;
const FRONT_NORMAL = [0, -1, 0] as const;

/** The domain's structured failure for a truncated expression, verbatim. */
const EXPRESSION_ERROR =
  "expression/unexpected-end-of-input: The expression ended where an operand was expected.";

/** Padding (CSS px) around the face anchors that still counts as model. */
const MODEL_REGION_PAD_PX = 96;

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  /** The settled boot-state page — the byte baseline. */
  initialPage: undefined as Buffer | undefined,
  /** The settled boot-state canvas — the byte baseline. */
  initialCanvas: undefined as Buffer | undefined,
};

/** The tree row for a reference key (e.g. `body|body_plate`). */
function treeNode(page: Page, key: string): Locator {
  return page.locator(`${TREE} [data-node-key="${key}"]`);
}

/** A panel field by its label — which IS the parameter name (domain data). */
function panelField(page: Page, name: string): Locator {
  return page.getByLabel(name, { exact: true });
}

/** The submit button of the panel's Formedible form. */
function applyButton(page: Page): Locator {
  return page.getByRole("button", { name: "Apply" });
}

/** A tool button of the toolbar component, by tool id. */
function toolbarButton(page: Page, toolId: string): Locator {
  return page.locator(`${TOOLBAR} button[data-tool-id="${toolId}"]`);
}

/**
 * Capture discipline for page shots: park the pointer off every surface
 * (no hover fills), drop focus (no caret or focus ring in the frame), and
 * let the CSS transitions (button opacity, row hover, chevron) run out.
 */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(300);
}

/**
 * Settle for a FOCUSED-field capture: two animation frames plus a short
 * wait, so Chromium's number-input spinner paint settles after a fill
 * (the spinner glyph has a transitional layout that a screenshot can catch
 * mid-flight — the one focused-state pixel that is not instant-stable).
 */
async function editorSettle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
  await page.waitForTimeout(200);
}

/** One serialized command-log entry (the store's canonical transaction form). */
interface CommandLogEntry {
  readonly formatVersion: number;
  readonly commands: readonly {
    readonly type: string;
    readonly id: string;
    readonly value?: {
      readonly dimension: string;
      readonly unit: string;
      readonly value: number;
    };
    /** The expression payload's serialized AST (present exactly on expression commits). */
    readonly expression?: Record<string, unknown>;
  }[];
}

/** The workbench's history view (`data-history`). */
interface HistorySurface {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly cursor: number;
  readonly depth: number;
}

/** One read of the composed page's machine-readable surfaces. */
interface WorkbenchSurface {
  readonly holeDiameter: string;
  readonly history: HistorySurface;
  readonly commandLog: readonly CommandLogEntry[];
  readonly selection: readonly unknown[];
  readonly toolId: string;
  readonly toolPhase: string;
  readonly toolState: unknown;
  readonly measure: string;
}

async function readSurface(page: Page): Promise<WorkbenchSurface> {
  const root = page.locator(`#${ROOT}`);
  const raw = async (attribute: string): Promise<string> => {
    const value = await root.getAttribute(attribute);
    expect(value, `${attribute} must exist`).not.toBeNull();
    return value ?? "";
  };
  const parse = (value: string): unknown =>
    value === "" ? null : (JSON.parse(value) as unknown);
  return {
    holeDiameter: await raw("data-hole-diameter"),
    history: parse(await raw("data-history")) as HistorySurface,
    commandLog: parse(
      await raw("data-command-log"),
    ) as readonly CommandLogEntry[],
    selection: parse(await raw("data-selection")) as readonly unknown[],
    toolId: await raw("data-tool-id"),
    toolPhase: await raw("data-tool-phase"),
    toolState: parse(await raw("data-tool-state")),
    measure: await raw("data-measure"),
  };
}

/** Waits until the document's stored hole diameter reaches `expected`. */
async function waitForHoleDiameter(
  page: Page,
  expected: string,
): Promise<void> {
  await page.waitForFunction(
    ({ id, want }) => {
      const root = document.getElementById(id);
      return root !== null && root.getAttribute("data-hole-diameter") === want;
    },
    { id: ROOT, want: expected },
  );
}

/** Waits until the command log holds exactly `count` entries. */
async function waitForCommandCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    ({ id, expected }) => {
      const root = document.getElementById(id);
      if (root === null) return false;
      const log = JSON.parse(
        root.getAttribute("data-command-log") ?? "[]",
      ) as unknown[];
      return log.length === expected;
    },
    { id: ROOT, expected: count },
  );
}

/** Waits until the tool surface reports `toolId` live (`active`). */
async function waitForToolActive(page: Page, toolId: string): Promise<void> {
  await page.waitForFunction(
    ({ id, root }) => {
      const element = document.getElementById(root);
      return (
        element !== null &&
        element.getAttribute("data-tool-id") === id &&
        element.getAttribute("data-tool-phase") === "active"
      );
    },
    { id: toolId, root: ROOT },
  );
}

/** Waits until the tool surface reports `phase`. */
async function waitForToolPhase(page: Page, phase: string): Promise<void> {
  await page.waitForFunction(
    ({ want, root }) => {
      const element = document.getElementById(root);
      return (
        element !== null && element.getAttribute("data-tool-phase") === want
      );
    },
    { want: phase, root: ROOT },
  );
}

/** The tool completion's canonical JSON surface (the measurement detail). */
interface ToolCompletionSurface {
  readonly toolId: string;
  readonly detail: {
    readonly kind: string;
    readonly distance?: { readonly unit: string; readonly value: number };
  };
}

/** Reads the tool completion's canonical JSON surface. */
async function readCompletion(page: Page): Promise<ToolCompletionSurface> {
  const raw = await page
    .locator(`#${ROOT}`)
    .getAttribute("data-tool-completion");
  expect(raw, "data-tool-completion must exist").not.toBeNull();
  if (raw === "" || raw === null) {
    throw new Error("the tool completion must be present");
  }
  return JSON.parse(raw) as ToolCompletionSurface;
}

/**
 * The model's screen region in canvas-capture pixels: the bounds of every
 * face-anchor point (published relative to the viewport's 800×520 box,
 * which the canvas fills exactly), padded by {@link MODEL_REGION_PAD_PX}.
 * Anchors are read from the CURRENT surface, so callers diffing across a
 * regeneration must call this after the new projection settled.
 */
async function modelRegion(page: Page): Promise<CaptureRect> {
  const anchors = await readFaceAnchors(page, VIEWPORT);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const anchor of Object.values(anchors)) {
    const x = anchor.point[0] * dpr;
    const y = anchor.point[1] * dpr;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    x: minX - MODEL_REGION_PAD_PX,
    y: minY - MODEL_REGION_PAD_PX,
    width: maxX - minX + MODEL_REGION_PAD_PX * 2,
    height: maxY - minY + MODEL_REGION_PAD_PX * 2,
  };
}

/** True when pixel `bounds` lie wholly inside a capture-pixel `region`. */
function boundsWithin(bounds: DiffBounds, region: CaptureRect): boolean {
  return (
    bounds.minX >= region.x &&
    bounds.minY >= region.y &&
    bounds.maxX < region.x + region.width &&
    bounds.maxY < region.y + region.height
  );
}

test("the composed workbench boots byte-stable across two runs", async ({
  page,
}) => {
  await page.goto("/workbench");
  const volumeFirst = await waitForSettledScene(page, ROOT);
  expect(Number(volumeFirst)).toBeGreaterThan(0);
  const shotFirst = await page.screenshot();
  const canvasFirst = await page.locator(CANVAS).screenshot();

  // Boot state: the document at its default, nothing issued, history
  // empty, the SELECT tool live through the toolbar component.
  const surface = await readSurface(page);
  expect(surface.holeDiameter).toBe("8");
  expect(surface.history).toEqual({
    canUndo: false,
    canRedo: false,
    cursor: 0,
    depth: 0,
  });
  expect(surface.commandLog).toEqual([]);
  expect(surface.toolId).toBe("select");
  expect(surface.toolPhase).toBe("active");

  // A full second run: fresh document load, fresh worker computation —
  // the same composed page, so the same settled bytes.
  await page.reload();
  const volumeSecond = await waitForSettledScene(page, ROOT);
  const shotSecond = await page.screenshot();
  const canvasSecond = await page.locator(CANVAS).screenshot();

  expect(volumeSecond).toBe(volumeFirst);
  expect(
    shotSecond.equals(shotFirst),
    `run1 sha256=${sha256(shotFirst)} vs run2 sha256=${sha256(shotSecond)}`,
  ).toBe(true);
  expect(
    canvasSecond.equals(canvasFirst),
    `canvas run1 sha256=${sha256(canvasFirst)} vs run2 sha256=${sha256(canvasSecond)}`,
  ).toBe(true);

  shared.initialPage = shotFirst;
  shared.initialCanvas = canvasFirst;
  await saveArtifact("cad-workbench-initial-run1.png", shotFirst);
  await saveArtifact("cad-workbench-initial-run2.png", shotSecond);
  await saveArtifact("cad-workbench-initial-canvas.png", canvasFirst);
});

test("selecting the plate in the tree highlights the viewport byte-reproducibly", async ({
  page,
}) => {
  const initialPage = shared.initialPage;
  const initialCanvas = shared.initialCanvas;
  expect(
    initialPage,
    "the determinism test must establish the page baseline first",
  ).toBeDefined();
  expect(
    initialCanvas,
    "the determinism test must establish the canvas baseline first",
  ).toBeDefined();
  if (initialPage === undefined || initialCanvas === undefined) {
    throw new Error("unreachable: baselines checked above");
  }

  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // A fresh load reproduces the initial baseline exactly.
  const fresh = await page.screenshot();
  expect(
    fresh.equals(initialPage),
    `fresh sha256=${sha256(fresh)} vs initial sha256=${sha256(initialPage)}`,
  ).toBe(true);

  // TREE → VIEWPORT: the plate row (the rotate feature's output) applies
  // the domain pick with the body reference; the highlight reaches a
  // rendered frame and the feature row stays unselected.
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);
  await expect(treeNode(page, PLATE_KEY)).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(treeNode(page, FEATURE_KEY)).toHaveAttribute(
    "data-selected",
    "false",
  );

  // The selection must have changed the CANVAS, and the change must
  // localize to the model's screen region (no overlay DOM exists to mask).
  const selectedCanvas = await page.locator(CANVAS).screenshot();
  const diff = await diffElementCaptures(page, initialCanvas, selectedCanvas);
  expect(
    diff.unmasked,
    "the body highlight must change canvas pixels",
  ).toBeGreaterThan(0);
  const highlightBounds = diff.unmaskedBounds;
  expect(highlightBounds, "unmasked pixels imply bounds").not.toBeNull();
  if (highlightBounds === null) {
    throw new Error("unreachable: bounds checked above");
  }
  const region = await modelRegion(page);
  expect(
    boundsWithin(highlightBounds, region),
    `highlight bounds ${JSON.stringify(highlightBounds)} must localize to the model region ${JSON.stringify(region)}`,
  ).toBe(true);

  await settleForCapture(page);
  const selectedPage = await page.screenshot();
  await saveArtifact("cad-workbench-selected.png", selectedPage);

  // Clear through the components' own surfaces: Escape cancels the armed
  // SELECT tool (the viewport's keyboard), and the empty-space click then
  // runs the viewport's default clear — after which the canvas is back at
  // the EXACT baseline bytes.
  await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Escape");
  await waitForToolPhase(page, "cancelled");
  await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
  await waitForTreeSelectionFrame(page, "", ROOT);
  await expect(treeNode(page, PLATE_KEY)).toHaveAttribute(
    "data-selected",
    "false",
  );
  await settleForCapture(page);
  const clearedCanvas = await page.locator(CANVAS).screenshot();
  expect(
    clearedCanvas.equals(initialCanvas),
    `cleared sha256=${sha256(clearedCanvas)} vs baseline sha256=${sha256(initialCanvas)}`,
  ).toBe(true);

  // Re-arm Select through the toolbar; the same tree click must reproduce
  // the EXACT selected-state bytes.
  await toolbarButton(page, "select").click();
  await waitForToolActive(page, "select");
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);
  await settleForCapture(page);
  const reselectedCanvas = await page.locator(CANVAS).screenshot();
  await saveArtifact("cad-workbench-selected-canvas.png", reselectedCanvas);
  expect(
    reselectedCanvas.equals(selectedCanvas),
    `reselected sha256=${sha256(reselectedCanvas)} vs selected sha256=${sha256(selectedCanvas)}`,
  ).toBe(true);
});

test("editing a parameter through the panel commits and regenerates the geometry", async ({
  page,
}) => {
  const initialCanvas = shared.initialCanvas;
  expect(
    initialCanvas,
    "the determinism test must establish the canvas baseline first",
  ).toBeDefined();
  if (initialCanvas === undefined) {
    throw new Error("unreachable: baseline checked above");
  }

  await page.goto("/workbench");
  const defaultVolume = await waitForSettledScene(page, ROOT);
  const framesBefore = await readRenderedFrames(page, ROOT);
  expect((await readSurface(page)).commandLog).toEqual([]);

  await settleForCapture(page);
  const beforeCanvas = await page.locator(CANVAS).screenshot();
  expect(
    beforeCanvas.equals(initialCanvas),
    `pre-edit sha256=${sha256(beforeCanvas)} vs baseline sha256=${sha256(initialCanvas)}`,
  ).toBe(true);

  // The parameter-editor baseline: the Formedible field focused mid-edit
  // (Playwright hides the caret), Apply reachable, document untouched.
  await panelField(page, "holeDiameter").fill("6");
  await editorSettle(page);
  await expect(applyButton(page)).toBeEnabled();
  const editorShot = await page.screenshot();
  await saveArtifact("cad-workbench-editor.png", editorShot);

  // Re-entering the same edit reproduces the editor bytes exactly: the
  // field goes back to the document value first, so the re-entry replays
  // the SAME 8 → 6 edit rather than re-filling an already-edited field.
  await panelField(page, "holeDiameter").fill("8");
  await settleForCapture(page);
  await panelField(page, "holeDiameter").fill("6");
  await editorSettle(page);
  const editorShotReentry = await page.screenshot();
  await saveArtifact("cad-workbench-editor-reentry.png", editorShotReentry);
  expect(
    editorShotReentry.equals(editorShot),
    `reentry sha256=${sha256(editorShotReentry)} vs editor sha256=${sha256(editorShot)}`,
  ).toBe(true);

  // Commit: the DOCUMENT changes first — one canonical parameter.set in the
  // log before any pixel settles.
  await applyButton(page).click();
  await waitForCommandCount(page, 1);
  const log = (await readSurface(page)).commandLog;
  expect(log[0]?.commands.map((command) => command.type)).toEqual([
    "parameter.set",
  ]);
  expect(log[0]?.commands[0]?.id).toBe("param_hole_diameter");
  expect(log[0]?.commands[0]?.value).toEqual({
    dimension: "length",
    unit: "mm",
    value: 6,
  });
  await expect(
    page.locator(PANEL).getByText("Current value: 6 mm"),
  ).toBeVisible();

  // The executor stand-in followed the document: a settled NEW volume.
  const editedVolume = await waitForSettledScene(page, ROOT);
  expect(editedVolume).not.toBe(defaultVolume);
  expect(await readRenderedFrames(page, ROOT)).toBeGreaterThan(framesBefore);

  // The regenerated baseline: the canvas diff against the pre-edit frame
  // must localize to the model's (re-derived) screen region — geometry
  // changed, chrome did not.
  await settleForCapture(page);
  const regeneratedCanvas = await page.locator(CANVAS).screenshot();
  const diff = await diffElementCaptures(page, beforeCanvas, regeneratedCanvas);
  expect(
    diff.unmasked,
    "the regenerated geometry must change canvas pixels",
  ).toBeGreaterThan(0);
  const geometryBounds = diff.unmaskedBounds;
  expect(geometryBounds, "unmasked pixels imply bounds").not.toBeNull();
  if (geometryBounds === null) {
    throw new Error("unreachable: bounds checked above");
  }
  const region = await modelRegion(page);
  expect(
    boundsWithin(geometryBounds, region),
    `geometry bounds ${JSON.stringify(geometryBounds)} must localize to the model region ${JSON.stringify(region)}`,
  ).toBe(true);
  const regeneratedShot = await page.screenshot();
  await saveArtifact("cad-workbench-regenerated.png", regeneratedShot);

  // Byte-reproduce the regenerated state through the history round-trip:
  // undo reverts to the settled default, redo re-applies the edit, and the
  // page and canvas return to the EXACT post-edit bytes.
  await page.locator("#history-undo").click();
  await waitForHoleDiameter(page, "8");
  await expect(
    page.locator(PANEL).getByText("Current value: 8 mm"),
  ).toBeVisible();
  expect(await waitForSettledScene(page, ROOT)).toBe(defaultVolume);
  await page.locator("#history-redo").click();
  await waitForHoleDiameter(page, "6");
  expect(await waitForSettledScene(page, ROOT)).toBe(editedVolume);
  await settleForCapture(page);
  const regeneratedShotRedo = await page.screenshot();
  expect(
    regeneratedShotRedo.equals(regeneratedShot),
    `redo sha256=${sha256(regeneratedShotRedo)} vs regenerated sha256=${sha256(regeneratedShot)}`,
  ).toBe(true);
  const regeneratedCanvasRedo = await page.locator(CANVAS).screenshot();
  expect(
    regeneratedCanvasRedo.equals(regeneratedCanvas),
    `redo canvas sha256=${sha256(regeneratedCanvasRedo)} vs regenerated sha256=${sha256(regeneratedCanvas)}`,
  ).toBe(true);
});

test("an invalid workbench-panel expression shows the error state and issues nothing", async ({
  page,
}) => {
  await page.goto("/workbench");
  const volume = await waitForSettledScene(page, ROOT);
  const framesBefore = await readRenderedFrames(page, ROOT);

  // The local initial baseline (self-contained: a prior test's failure
  // restarts the worker and clears shared state).
  await settleForCapture(page);
  const initialShot = await page.screenshot();
  if (shared.initialPage !== undefined) {
    expect(
      initialShot.equals(shared.initialPage),
      `initial sha256=${sha256(initialShot)} vs baseline sha256=${sha256(shared.initialPage)}`,
    ).toBe(true);
  }

  // Live domain validation: the structured failure surfaces verbatim as a
  // visible field error and Apply disables — submit is structurally blocked.
  await panelField(page, "volumeHint").fill("holeDiameter *");
  const error = page.locator(PANEL).getByText(EXPRESSION_ERROR);
  await expect(error).toBeVisible();
  await expect(applyButton(page)).toBeDisabled();

  // Nothing was issued and nothing moved: command log, volume, frames.
  await page.waitForTimeout(300);
  expect((await readSurface(page)).commandLog).toEqual([]);
  expect(await waitForSettledScene(page, ROOT)).toBe(volume);
  expect(await readRenderedFrames(page, ROOT)).toBe(framesBefore);

  // The error-state baseline: the bytes differ from the initial page (the
  // error is IN the pixels, not just the DOM).
  await settleForCapture(page);
  const errorShot = await page.screenshot();
  expect(
    errorShot.equals(initialShot),
    `error sha256=${sha256(errorShot)} must differ from initial sha256=${sha256(initialShot)}`,
  ).toBe(false);
  await saveArtifact("cad-workbench-error.png", errorShot);

  // Re-entering the error reproduces its bytes exactly.
  await panelField(page, "volumeHint").fill("holeDiameter * 2");
  await expect(error).toHaveCount(0);
  await panelField(page, "volumeHint").fill("holeDiameter *");
  await expect(error).toBeVisible();
  await settleForCapture(page);
  const errorShotReentry = await page.screenshot();
  expect(
    errorShotReentry.equals(errorShot),
    `reentry sha256=${sha256(errorShotReentry)} vs error sha256=${sha256(errorShot)}`,
  ).toBe(true);

  // Fixing the expression re-enables Apply; the commit IS the expression
  // (a `parameter.set` expression payload — the serialized AST, no value):
  // the document stores it and re-derives the cached value in the same
  // application.
  await panelField(page, "volumeHint").fill("holeDiameter * 3");
  await expect(applyButton(page)).toBeEnabled();
  await applyButton(page).click();
  await waitForCommandCount(page, 1);
  const log = (await readSurface(page)).commandLog;
  expect(log[0]?.commands[0]?.type).toBe("parameter.set");
  expect(log[0]?.commands[0]?.id).toBe("param_volume_hint");
  expect(log[0]?.commands[0]?.value).toBeUndefined();
  expect(log[0]?.commands[0]?.expression).toMatchObject({
    kind: "binary",
    left: { kind: "identifier", name: "holeDiameter" },
    operator: "*",
    right: { kind: "number", value: 3 },
  });
  await expect(error).toHaveCount(0);
});

test("undo and redo through the history pair revert and re-apply the document", async ({
  page,
}) => {
  await page.goto("/workbench");
  const defaultVolume = await waitForSettledScene(page, ROOT);

  await panelField(page, "holeDiameter").fill("6");
  await applyButton(page).click();
  const editedVolume = await waitForSettledScene(page, ROOT);
  expect(editedVolume).not.toBe(defaultVolume);

  // The document reverted; undo is a history move, not an issue: the
  // command log keeps its entry, the stored value is back to 8.
  await page.locator("#history-undo").click();
  await waitForHoleDiameter(page, "8");
  const surface = await readSurface(page);
  expect(surface.commandLog).toHaveLength(1);
  expect(surface.history.canRedo).toBe(true);
  expect(surface.history.cursor).toBe(0);
  await expect(
    page.locator(PANEL).getByText("Current value: 8 mm"),
  ).toBeVisible();
  expect(await waitForSettledScene(page, ROOT)).toBe(defaultVolume);

  await page.locator("#history-redo").click();
  await waitForHoleDiameter(page, "6");
  expect(await waitForSettledScene(page, ROOT)).toBe(editedVolume);
});

test("the toolbar's tools act on the viewport: measure completes, select drives selection", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);
  const anchors = await readFaceAnchors(page, VIEWPORT);
  const revision = await readSelectionRegeneration(page, ROOT);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const front = faceWithNormal(anchors, FRONT_NORMAL);

  // MEASURE through the toolbar component: two viewport picks, one
  // dimensional completion, read back from the tool surface.
  await toolbarButton(page, "measure").click();
  await waitForToolActive(page, "measure");
  let surface = await readSurface(page);
  expect(surface.toolId).toBe("measure");
  expect(surface.toolState).toEqual({ stage: "awaiting-first" });

  await clickFaceAnchor(page, top.anchor, [], VIEWPORT);
  surface = await readSurface(page);
  expect(surface.toolState).toEqual({
    stage: "awaiting-second",
    from: expect.anything(),
  });

  await clickFaceAnchor(page, front.anchor, [], VIEWPORT);
  await waitForToolPhase(page, "completed");
  const completion = await readCompletion(page);
  expect(completion.toolId).toBe("measure");
  expect(completion.detail.kind).toBe("measurement");
  const distance = completion.detail.distance;
  expect(
    distance,
    "a measurement completion carries its distance",
  ).toBeDefined();
  if (distance === undefined) {
    throw new Error("unreachable: distance checked above");
  }
  expect(distance.unit).toBe("mm");
  expect(distance.value).toBeGreaterThan(0);
  await expect(page.locator("#workbench-measure-readout")).toHaveText(
    `${distance.value.toFixed(3)} mm`,
  );

  // SELECT through the toolbar: a viewport face pick lands as the synthetic
  // face reference through the tool surface, highlight settled.
  await toolbarButton(page, "select").click();
  await waitForToolActive(page, "select");
  await clickFaceAnchor(page, top.anchor, [], VIEWPORT);
  await waitForSelectionFrame(
    page,
    faceSelectionKey(revision, top.faceIndex),
    ROOT,
  );
  expect(await readSelection(page, ROOT)).toEqual([
    {
      kind: "face",
      bodyId: "body_plate",
      regeneration: revision,
      faceIndex: top.faceIndex,
    },
  ]);

  // Escape cancels the live tool (the viewport's keyboard); the next
  // empty-space click runs the viewport's own default clear.
  await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Escape");
  await waitForToolPhase(page, "cancelled");
  await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection",
    "[]",
  );
});

test("the full authoring workflow is captured on video", async ({ page }) => {
  await page.goto("/workbench");
  const defaultVolume = await waitForSettledScene(page, ROOT); // load model
  const anchorsBefore = await readFaceAnchors(page, VIEWPORT);
  expect(Object.keys(anchorsBefore).length).toBeGreaterThan(0);

  // Select a feature's body through the tree.
  await treeNode(page, PLATE_KEY).click();
  await waitForTreeSelectionFrame(page, PLATE_KEY, ROOT);

  // Edit a parameter through the panel.
  await panelField(page, "holeDiameter").fill("6");
  await applyButton(page).click();
  await waitForCommandCount(page, 1);

  // Observe regenerated geometry: a settled new volume, anchors re-derived
  // from the NEW projection, and a viewport pick on the new faces.
  const editedVolume = await waitForSettledScene(page, ROOT);
  expect(editedVolume).not.toBe(defaultVolume);
  const anchors = await readFaceAnchors(page, VIEWPORT);
  const revision = await readSelectionRegeneration(page, ROOT);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  await clickFaceAnchor(page, top.anchor, [], VIEWPORT);
  await waitForSelectionFrame(
    page,
    faceSelectionKey(revision, top.faceIndex),
    ROOT,
  );

  // The error state and its recovery, on the way.
  await panelField(page, "volumeHint").fill("holeDiameter *");
  await expect(page.locator(PANEL).getByText(EXPRESSION_ERROR)).toBeVisible();
  await panelField(page, "volumeHint").fill("holeDiameter * 3");
  await applyButton(page).click();
  await waitForCommandCount(page, 2);

  const video = page.video();
  expect(video, "the page must be recorded").not.toBeNull();
  const path = await video?.path();
  expect(path, "a video file must be attached").toBeTruthy();
});
