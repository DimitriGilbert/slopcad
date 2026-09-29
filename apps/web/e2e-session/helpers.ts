/**
 * The session harness's shared step library (Phase 9 extraction): the
 * UI-driving helpers `session.spec.ts` chains into its one-user journey,
 * moved verbatim so sibling harnesses (the upcoming tutorial) reuse the
 * same surfaces instead of duplicating them. Every flow, testid, and
 * numeric pin below is the existing suites' step library (e2e-workbench,
 * e2e, e2e-render, e2e-projects) — no new machine surfaces, no invented
 * selectors. The spec-owned bookkeeping (the coverage ledger, the stage
 * timeline, the manifest, the session user) stays in the spec; the
 * module-private helpers (`canvasPoint`, `dismissHint`,
 * `VOLUME_REL_TOLERANCE`, `TimelineSurface`) serve the exported ones only.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Download, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { SettleAnchor } from "../e2e-render/helpers";
import type {
  WebMcpToolAnnotations,
  WebMcpToolSnapshot,
} from "../src/webmcp/registry";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

// ---------------------------------------------------------------------------
// Shared constants and step-library helpers (the existing suites' surfaces)
// ---------------------------------------------------------------------------

export const COMPLETE_ROOT = "workbench-complete-root";
export const OCCT_ROOT = "workbench-complete-occt-root";
export const COMPLETE = `#${COMPLETE_ROOT}`;
export const SKETCH = "#sketch-root";
export const UNDO_BUTTON = 'button[aria-label="Undo"]';
export const REDO_BUTTON = 'button[aria-label="Redo"]';
export const DIALOG = '[data-testid="feature-form-dialog"]';
export const VIEWPORT_COMPLETE = "workbench-complete-viewport";
/** The sketch rectangle the create journeys draw (workplane mm). */
export const RECT = { x0: 10, y0: 10, x1: 30, y1: 25 } as const;

/** Relative volume tolerance (the workbench suite's documented band). */
const VOLUME_REL_TOLERANCE = 0.005;

/** True when `value` matches `expected` inside the documented band. */
export function volumeNear(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= expected * VOLUME_REL_TOLERANCE;
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Clicks the sketch canvas at a workplane mm point. */
export async function clickCanvasPoint(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page
    .locator(`${SKETCH} [data-sketch-surface]`)
    .click({ position: canvasPoint(x, y) });
}

/** Activates a sketch tool through the sketch toolbar. */
export async function activateSketchTool(
  page: Page,
  toolId: string,
): Promise<void> {
  await page.locator(`[data-sketch-tool-id="${toolId}"]`).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    toolId,
  );
}

/** The complete workbench re-shows its hint on every page load: dismiss it.
 * The hint mounts AFTER the settle stamp (a delayed getting-started float),
 * so the dismissal waits briefly for it instead of racing the mount — and
 * bounded, so a hint-free page never stalls. */
async function dismissHint(page: Page): Promise<void> {
  const dismiss = page.locator('[data-testid="workbench-sketch-hint-dismiss"]');
  try {
    await dismiss.click({ timeout: 3_000 });
    await page.waitForTimeout(150);
  } catch {
    // The hint did not mount on this load (already dismissed this session).
  }
}

/** Opens a complete workbench route and waits for the settled first scene. */
export async function openComplete(
  page: Page,
  rootId: string = COMPLETE_ROOT,
): Promise<string> {
  await page.goto(
    rootId === OCCT_ROOT ? "/workbench-complete-occt" : "/workbench-complete",
  );
  await dismissHint(page);
  return waitForSettledScene(page, rootId);
}

/** Waits until the complete workbench root's settle stamp agrees. */
export async function waitForRootSettle(
  page: Page,
  rootId: string,
  anchor?: SettleAnchor,
): Promise<string> {
  return waitForSettledScene(page, rootId, anchor);
}

/** The parsed feature-timeline surface. */
interface TimelineSurface {
  readonly rollback: unknown;
  readonly entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly diagnostics?: readonly { readonly message: string }[];
  }[];
  readonly executed: readonly string[];
}

/** One read of the complete workbench's machine surface. */
export async function readTimeline(
  page: Page,
  rootId: string,
): Promise<TimelineSurface> {
  const raw = await page
    .locator(`#${rootId}`)
    .getAttribute("data-feature-timeline")
    .then((value) => value ?? "{}");
  return JSON.parse(raw) as TimelineSurface;
}

/** One camera attribute off the viewport's machine surface. */
export async function cameraMode(page: Page): Promise<string> {
  return (
    (await page
      .locator(`#${VIEWPORT_COMPLETE} [data-camera-mode]`)
      .first()
      .getAttribute("data-camera-mode")) ?? ""
  );
}

/** One named camera attribute off the viewport container. */
export async function cameraAttribute(
  page: Page,
  name: string,
): Promise<string> {
  return (
    (await page
      .locator(`#${VIEWPORT_COMPLETE} [data-camera-${name}]`)
      .first()
      .getAttribute(`data-camera-${name}`)) ?? ""
  );
}

/** One root attribute off the complete workbench root. */
export async function rootAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(COMPLETE).getAttribute(name)) ?? "";
}

/**
 * Reads the WebMCP registry snapshot through the window test seam. The
 * seam is SNAPSHOT-ONLY by design (Phase 7): it exposes registration —
 * names, JSON Schemas, annotations — and deliberately NO execution entry,
 * so the session asserts what agents can discover, never drives tools.
 */
export async function readWebMcpSnapshot(
  page: Page,
): Promise<readonly WebMcpToolSnapshot[]> {
  return page.evaluate(() => window.__slopcadWebMcpTools?.() ?? []);
}

/** The JSON-Schema form's type member of one snapshot entry's input. */
export function schemaTypeOf(tool: WebMcpToolSnapshot): string | undefined {
  return (tool.inputSchema as { readonly type?: string }).type;
}

/** One named tool's annotations from a snapshot (null when absent). */
export function annotationsOf(
  tools: readonly WebMcpToolSnapshot[],
  name: string,
): WebMcpToolAnnotations | null {
  return tools.find((tool) => tool.name === name)?.annotations ?? null;
}

/** Opens the command menu (Ctrl+K) on a complete workbench. */
export async function openCommandMenu(
  page: Page,
  rootId: string,
): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-command-menu-open",
    "true",
  );
}

/** Closes the command menu with Escape. */
export async function closeCommandMenu(
  page: Page,
  rootId: string,
): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-command-menu-open",
    "false",
  );
}

/** Reads every rendered command-menu row id (menu left OPEN). */
export async function readMenuRowIds(page: Page): Promise<string[]> {
  const rows = page.locator("[data-cad-command-id]");
  const count = await rows.count();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push((await rows.nth(index).getAttribute("data-cad-command-id")) ?? "");
  }
  return ids;
}

/** Runs one command through the menu row (the user's always-reachable path). */
export async function runCommand(
  page: Page,
  rootId: string,
  id: string,
): Promise<void> {
  await openCommandMenu(page, rootId);
  await page.locator(`[data-cad-command-id="${id}"]`).click();
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-command-menu-open",
    "false",
  );
}

/**
 * Opens a feature dialog through its EXACT command-menu row (Ctrl+K →
 * row click — never a fuzzy query: "helix" ranks the curve command's
 * keywords too, and the top row is not stable across document states).
 * The ids are the checklist's own command targets.
 */
export async function openDialogViaMenu(
  page: Page,
  rootId: string,
  commandId: string,
): Promise<void> {
  await openCommandMenu(page, rootId);
  await page.locator(`[data-cad-command-id="${commandId}"]`).click();
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-command-menu-open",
    "false",
  );
  await expect(page.locator(DIALOG)).toBeVisible();
}

/** Submits the open feature dialog and settles the re-dispatched scene. */
export async function submitDialogAndSettle(
  page: Page,
  rootId: string,
  name: string,
): Promise<string> {
  const before = await dispatchedCount(page, rootId);
  await page.locator(DIALOG).getByRole("button", { name }).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  return waitForRootSettle(page, rootId, { afterDispatch: before });
}

/** Enters sketch mode from the complete workbench's model workspace. */
export async function enterSketchMode(
  page: Page,
  rootId: string = COMPLETE_ROOT,
): Promise<void> {
  await page.locator('[data-testid="complete-mode-toggle"]').click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
}

/** Saves the current drawing as a standalone sketch record. */
export async function saveSketch(
  page: Page,
  rootId: string = COMPLETE_ROOT,
): Promise<void> {
  await page.locator('[data-testid="sketch-save"]').click();
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
}

/** Saves a throwaway line sketch: the sketch-feature command rows gate on
 * a pool of >= 2 sketches (complete-workbench's canAuthorSketchFeatures),
 * so a fresh document needs a second record before the row is enabled. */
export async function saveThrowawaySketch(
  page: Page,
  rootId: string,
): Promise<void> {
  await enterSketchMode(page, rootId);
  await activateSketchTool(page, "line");
  await clickCanvasPoint(page, 40, 40);
  await clickCanvasPoint(page, 45, 45);
  await saveSketch(page, rootId);
}

/** Draws the journey rectangle (two corner picks) and pins the entity. */
export async function drawRectangle(page: Page): Promise<void> {
  await activateSketchTool(page, "rectangle");
  await clickCanvasPoint(page, RECT.x0, RECT.y0);
  await clickCanvasPoint(page, RECT.x1, RECT.y1);
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { kind: string }[];
  expect(entities.filter((entity) => entity.kind === "rectangle").length).toBe(
    1,
  );
}

/** Draws the ±10 profile square (the sweep/loft profile). */
export async function drawProfileSquare(page: Page): Promise<void> {
  await activateSketchTool(page, "rectangle");
  await clickCanvasPoint(page, -10, -10);
  await clickCanvasPoint(page, 10, 10);
}

/** Draws the straight spine (0,0) → (0,40) with the line tool. */
export async function drawPathSpine(page: Page): Promise<void> {
  await activateSketchTool(page, "line");
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 0, 40);
}

/** Draws and extrudes the ⌀6 rod (the sketch extrude's default depth). */
export async function drawAndExtrudeRod(
  page: Page,
  rootId: string,
): Promise<string> {
  await enterSketchMode(page, rootId === OCCT_ROOT ? OCCT_ROOT : COMPLETE_ROOT);
  await activateSketchTool(page, "circle");
  await clickCanvasPoint(page, 0, 0);
  await clickCanvasPoint(page, 3, 0);
  await page.locator('[data-testid="sketch-extrude"]').click();
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  return waitForRootSettle(page, rootId);
}

/** The plain-hole dialog journey on the last extrusion (the bridge verb). */
export async function holeLastExtrusion(
  page: Page,
  rootId: string,
): Promise<string> {
  const before = await dispatchedCount(page, rootId);
  await page.locator('[data-testid="complete-hole"]').click();
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-scene-kind",
    "hole",
  );
  return waitForRootSettle(page, rootId, { afterDispatch: before });
}

/** One undo/redo checkpoint: the last feature leaves and returns. */
export async function undoRedoCheckpoint(
  page: Page,
  rootId: string,
  featureKind: string,
): Promise<void> {
  const entriesBefore = (await readTimeline(page, rootId)).entries.length;
  await page.locator(UNDO_BUTTON).click();
  await page.waitForFunction(
    ({ id, count }) =>
      (
        JSON.parse(
          document.getElementById(id)?.getAttribute("data-feature-timeline") ??
            "{}",
        ) as { entries: unknown[] }
      ).entries.length ===
      count - 1,
    { id: rootId, count: entriesBefore },
  );
  await page.locator(REDO_BUTTON).click();
  await page.waitForFunction(
    ({ id, count, kind }) => {
      const timeline = JSON.parse(
        document.getElementById(id)?.getAttribute("data-feature-timeline") ??
          "{}",
      ) as { entries: readonly { kind: string }[] };
      return (
        timeline.entries.length === count &&
        timeline.entries.some((entry) => entry.kind === kind)
      );
    },
    { id: rootId, count: entriesBefore, kind: featureKind },
  );
}

/**
 * Collects `expected` downloads produced by `run` (bounded poll).
 *
 * HISTORY (probed, this habitat): the camera-series commands wait per frame
 * on `data-rendered-frames`, and that ledger used to advance on document
 * settles only — camera-only applications never re-settled the document, so
 * every frame burned its internal 10s degrade before the capture (~90s for
 * the 8-frame turntable, ~45s for the isometric; output was still correct).
 * The ledger now counts COMMITTED camera renders too (the scene's
 * camera-settle probe → the host's `noteRenderedFrame`), so each frame
 * completes as soon as its camera actually rendered — seconds per series.
 * The budgets stay as bounded caps over the fast path, not a license to
 * degrade again.
 */
export async function collectDownloads(
  page: Page,
  run: () => Promise<void>,
  expected: number,
  budgetMs: number,
): Promise<Download[]> {
  const downloads: Download[] = [];
  const collector = (download: Download): void => {
    downloads.push(download);
  };
  page.on("download", collector);
  try {
    await run();
    await expect
      .poll(() => downloads.length, { timeout: budgetMs })
      .toBe(expected);
  } finally {
    page.off("download", collector);
  }
  return downloads;
}

/** Asserts every download is a PNG, in `names` order, all bytes distinct. */
export async function assertPngs(
  downloads: Download[],
  names: string[],
): Promise<void> {
  const shas = new Set<string>();
  const actual: string[] = [];
  for (const download of downloads) {
    actual.push(download.suggestedFilename());
    const path = await download.path();
    if (path === null) throw new Error("download has no path");
    const bytes = await readFile(path);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    shas.add(createHash("sha256").update(bytes).digest("hex"));
  }
  expect(actual).toEqual(names);
  expect(shas.size).toBe(names.length);
}
