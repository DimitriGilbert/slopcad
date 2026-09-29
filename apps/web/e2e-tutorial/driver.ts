import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { ChapterModule, RawChapterRecord } from "./narration";

import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import {
  COMPLETE_ROOT,
  SKETCH,
  waitForRootSettle,
} from "../e2e-session/helpers";

/**
 * The tutorial driver — the teaching twin of the session helpers. Every
 * interaction a chapter performs goes through here so the recorded video
 * always shows a viewer where to look: a high-visibility cursor that glides
 * to its target (never teleports), a ripple on every click, and pacing
 * dwells that hold each narration cue long enough to read. Pure reads (the
 * session helpers' attribute/timeline surfaces) stay machine-paced — only
 * the pointer-carrying verbs are human-paced.
 */

// ---------------------------------------------------------------------------
// Pacing knobs (env-overridable so local runs can tighten or stretch)
// ---------------------------------------------------------------------------

/** One env-parsed non-negative number with a documented fallback. */
function pacingFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

/** The beat between teaching actions — long enough to see what happened. */
export const TUTORIAL_DWELL_MS = pacingFromEnv("TUTORIAL_DWELL_MS", 600);
/** The minimum on-screen life of one narration cue (readable captions). */
export const TUTORIAL_CUE_HOLD_MS = pacingFromEnv(
  "TUTORIAL_CUE_HOLD_MS",
  1_200,
);
/** The settle beat between the cursor's arrival and its click. */
const CLICK_SETTLE_MS = 140;

// ---------------------------------------------------------------------------
// The cursor overlay (injected into every page of the context)
// ---------------------------------------------------------------------------

/**
 * Injects the tutorial's visible pointer: a fixed-position SVG arrow that
 * tracks `pointermove` (a transform-only update — no layout thrash), an
 * expanding ripple on every `pointerdown`, and a brief pulse on modifier
 * keydowns (the Ctrl+K moment). Everything is namespaced under
 * `data-tutorial-cursor` so the app's own DOM assertions can never match
 * it, and the whole layer is `pointer-events: none` — it can never
 * intercept an interaction.
 */
export async function installCursorOverlay(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    const install = (): void => {
      if (document.getElementById("tutorial-cursor-overlay") !== null) {
        return;
      }
      const root = document.createElement("div");
      root.id = "tutorial-cursor-overlay";
      root.setAttribute("data-tutorial-cursor", "root");
      root.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";

      const cursor = document.createElement("div");
      cursor.setAttribute("data-tutorial-cursor", "pointer");
      cursor.style.cssText =
        "position:fixed;left:0;top:0;width:24px;height:24px;" +
        "pointer-events:none;will-change:transform;" +
        "transform:translate3d(-48px,-48px,0);" +
        "filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55));";
      cursor.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
        'viewBox="0 0 24 24" data-tutorial-cursor="arrow">' +
        '<path d="M5.5 2.8 19.4 13.2l-6.5.9 3 6.1-2.6 1.3-3-6.2-4.8 3z" ' +
        'fill="#ff5c1a" stroke="#ffffff" stroke-width="1.4" ' +
        'stroke-linejoin="round"/></svg>';
      root.appendChild(cursor);
      const arrow = cursor.querySelector("svg");

      const rippleAt = (x: number, y: number, scale: number): void => {
        const ring = document.createElement("div");
        ring.setAttribute("data-tutorial-cursor", "ripple");
        ring.style.cssText =
          `position:fixed;left:${String(x)}px;top:${String(y)}px;` +
          "width:10px;height:10px;margin:-5px 0 0 -5px;" +
          "border:2px solid #ff5c1a;border-radius:50%;pointer-events:none;";
        root.appendChild(ring);
        const ripple = ring.animate(
          [
            { transform: `scale(${String(scale)})`, opacity: 0.95 },
            { transform: `scale(${String(scale * 4)})`, opacity: 0 },
          ],
          { duration: 500, easing: "cubic-bezier(0.2, 0.6, 0.3, 1)" },
        );
        ripple.onfinish = (): void => {
          ring.remove();
        };
        // Software rendering can stall animations: never leak a ring.
        window.setTimeout((): void => {
          ring.remove();
        }, 700);
      };

      window.addEventListener(
        "pointermove",
        (event: PointerEvent): void => {
          cursor.style.transform = `translate3d(${String(event.clientX)}px,${String(
            event.clientY,
          )}px,0)`;
        },
        { passive: true },
      );
      window.addEventListener("pointerdown", (event: PointerEvent): void => {
        rippleAt(event.clientX, event.clientY, 1);
      });
      window.addEventListener("keydown", (event: KeyboardEvent): void => {
        const modifier =
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.key === "Shift" ||
          event.key === "Control" ||
          event.key === "Alt" ||
          event.key === "Meta";
        if (!modifier || arrow === null) return;
        const flash = arrow.animate(
          [
            { transform: "scale(1)", opacity: 1 },
            { transform: "scale(1.45)", opacity: 0.85 },
            { transform: "scale(1)", opacity: 1 },
          ],
          { duration: 260, easing: "ease-out" },
        );
        flash.onfinish = (): void => {
          if (arrow !== null) arrow.style.transform = "";
        };
      });

      document.documentElement.appendChild(root);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", install, { once: true });
    } else {
      install();
    }
  });
}

// ---------------------------------------------------------------------------
// Human pacing
// ---------------------------------------------------------------------------

/** A resolved viewport point (CSS px, page coordinates). */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/** The last place the pointer came to rest, per page (glide distances). */
const lastPointer = new WeakMap<Page, ViewportPoint>();

/** An explicit hold for narration beats. */
export async function dwell(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Glides the pointer to `(x, y)` with a distance-based step count — the
 * glide is the point: the viewer sees WHERE the cursor is heading. A first
 * move with no history starts from the viewport center.
 */
export async function humanMove(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  const from = lastPointer.get(page) ?? { x: 640, y: 360 };
  const distance = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(8, Math.ceil(distance / 12));
  await page.mouse.move(x, y, { steps });
  lastPointer.set(page, { x, y });
}

/** Resolves a click/point target to a viewport point (a locator's center). */
async function resolveTarget(
  target: Locator | ViewportPoint,
): Promise<ViewportPoint> {
  if ("x" in target && "y" in target) return target;
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) {
    throw new Error("the tutorial pointer target has no bounding box");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The teaching click: glide to the target, a short settle so the arrival
 * registers, then the click itself — the overlay's ripple fires from the
 * real `pointerdown` automatically.
 */
export async function humanClick(
  page: Page,
  target: Locator | ViewportPoint,
): Promise<void> {
  const point = await resolveTarget(target);
  await humanMove(page, point.x, point.y);
  await dwell(page, CLICK_SETTLE_MS);
  await page.mouse.down();
  await page.mouse.up();
  lastPointer.set(page, point);
}

/**
 * The teaching point: the same glide as a click, but the pointer only
 * arrives and rests — for narrating "here it is" without changing state.
 */
export async function humanPoint(
  page: Page,
  target: Locator | ViewportPoint,
): Promise<void> {
  const point = await resolveTarget(target);
  await humanMove(page, point.x, point.y);
  await dwell(page, CLICK_SETTLE_MS);
}

// ---------------------------------------------------------------------------
// The narration timeline (wall-clock stamps, one ledger for the run)
// ---------------------------------------------------------------------------

/** The driver-internal mutable shape behind {@link RawChapterRecord}. */
interface OpenStep {
  chapterId: string;
  stepId: string;
  t0: number;
  t1: number;
}

interface OpenChapter {
  id: string;
  title: string;
  t0: number;
  t1: number;
  steps: OpenStep[];
}

const recordedChapters: OpenChapter[] = [];
let openChapter: OpenChapter | null = null;

/** One rendered frame (bounded — software rendering can starve rAF). */
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        window.requestAnimationFrame(finish);
        window.setTimeout(finish, 500);
      }),
  );
}

/**
 * Opens a chapter's timeline: the stamp lands on a rendered frame boundary
 * so the chapter marker tracks what the video encoder actually captured.
 * The chapter's own navigation happens after this — arriving IS part of the
 * chapter's opening beat.
 */
export async function beginChapter(
  page: Page,
  id: string,
  title: string,
): Promise<void> {
  if (openChapter !== null) {
    throw new Error(
      `beginChapter("${id}") while chapter "${openChapter.id}" is still open — a step is missing endChapter()`,
    );
  }
  await nextFrame(page);
  openChapter = { id, title, t0: Date.now(), t1: 0, steps: [] };
}

/**
 * Marks the start of one narration cue's beat. The PREVIOUS cue is held for
 * at least {@link TUTORIAL_CUE_HOLD_MS} first, so every caption is readable
 * — the timestamps stay real, the pacing makes them watchable.
 */
export async function step(page: Page, stepId: string): Promise<void> {
  if (openChapter === null) {
    throw new Error(`step("${stepId}") called before beginChapter()`);
  }
  const previous = openChapter.steps[openChapter.steps.length - 1];
  if (previous !== undefined) {
    const remaining = TUTORIAL_CUE_HOLD_MS - (Date.now() - previous.t0);
    if (remaining > 0) await dwell(page, remaining);
  }
  const stamp = Date.now();
  if (previous !== undefined) previous.t1 = stamp;
  openChapter.steps.push({
    chapterId: openChapter.id,
    stepId,
    t0: stamp,
    t1: stamp,
  });
}

/** Closes the chapter, holding the final cue for its readable life first. */
export async function endChapter(page: Page): Promise<void> {
  if (openChapter === null) {
    throw new Error("endChapter() called before beginChapter()");
  }
  const last = openChapter.steps[openChapter.steps.length - 1];
  if (last !== undefined) {
    const remaining = TUTORIAL_CUE_HOLD_MS - (Date.now() - last.t0);
    if (remaining > 0) await dwell(page, remaining);
  }
  const stamp = Date.now();
  if (last !== undefined) last.t1 = stamp;
  openChapter.t1 = stamp;
  recordedChapters.push(openChapter);
  openChapter = null;
}

/** The chapters recorded so far, in run order (the raw timeline). */
export function chapterTimelines(): readonly RawChapterRecord[] {
  return recordedChapters;
}

// ---------------------------------------------------------------------------
// Human-paced workbench verbs (the session helpers' shapes, pointer-first)
// ---------------------------------------------------------------------------

/**
 * Dismisses the complete workbench's getting-started hint with a visible
 * click — bounded, so a hint-free load never stalls (the session helper's
 * discipline, human-paced).
 */
async function humanDismissHint(page: Page): Promise<void> {
  const dismiss = page.locator('[data-testid="workbench-sketch-hint-dismiss"]');
  try {
    await dismiss.waitFor({ state: "visible", timeout: 3_000 });
    await humanClick(page, dismiss);
    await dwell(page, 150);
  } catch {
    // The hint did not mount on this load (already dismissed this session).
  }
}

/** Opens the command menu with a visible click on its trigger button. */
async function humanOpenCommandMenu(page: Page, rootId: string): Promise<void> {
  await humanClick(
    page,
    page.locator('[data-testid="complete-command-menu-trigger"]'),
  );
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-command-menu-open",
    "true",
  );
}

/** Clicks one command-menu row with a glide; the menu must close on it. */
async function humanClickCommandRow(
  page: Page,
  rootId: string,
  commandId: string,
): Promise<void> {
  await humanClick(page, page.locator(`[data-cad-command-id="${commandId}"]`));
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-command-menu-open",
    "false",
  );
}

/** Arms a sketch tool through its toolbar button (the session helper, paced). */
async function humanActivateSketchTool(
  page: Page,
  toolId: string,
): Promise<void> {
  await humanClick(page, page.locator(`[data-sketch-tool-id="${toolId}"]`));
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    toolId,
  );
}

/**
 * Clicks the sketch canvas at a workplane mm point with a visible glide —
 * the same mm→px mapping the session helpers' `clickCanvasPoint` uses
 * (SKETCH_CANVAS's documented transform), resolved onto the surface's
 * bounding box to land in viewport coordinates.
 */
async function humanClickCanvasPoint(
  page: Page,
  xMm: number,
  yMm: number,
): Promise<void> {
  const box = await page
    .locator(`${SKETCH} [data-sketch-surface]`)
    .boundingBox();
  if (box === null) throw new Error("the sketch surface is not mounted");
  const px = SKETCH_CANVAS.origin.x + xMm * SKETCH_CANVAS.scale;
  const py = SKETCH_CANVAS.origin.y - yMm * SKETCH_CANVAS.scale;
  await humanClick(page, { x: box.x + px, y: box.y + py });
}

/** Enters sketch mode through the top-bar Sketch button (paced). */
async function humanEnterSketchMode(
  page: Page,
  rootId: string = COMPLETE_ROOT,
): Promise<void> {
  await humanClick(page, page.locator('[data-testid="complete-mode-toggle"]'));
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(`#${rootId}`)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
}

/** The chapter-bound teaching surface: pacing, pointing, and the timeline. */
export interface TutorialDriver {
  /** Marks the start of one narration cue's beat (holds the previous cue). */
  step(stepId: string): Promise<void>;
  /** An explicit hold; defaults to {@link TUTORIAL_DWELL_MS}. */
  dwell(ms?: number): Promise<void>;
  /** Glides the pointer onto a target and rests there — no click. */
  humanPoint(target: Locator | ViewportPoint): Promise<void>;
  /** Glides to the target, settles, and clicks it. */
  humanClick(target: Locator | ViewportPoint): Promise<void>;
  /** Opens the command menu via its visible trigger button. */
  openCommandMenu(rootId: string): Promise<void>;
  /** Clicks one command-menu row with a glide (menu closes on it). */
  clickCommandRow(rootId: string, commandId: string): Promise<void>;
  /** Arms a sketch tool through its toolbar button. */
  activateSketchTool(toolId: string): Promise<void>;
  /** Clicks the sketch canvas at a workplane mm point. */
  clickCanvasPoint(xMm: number, yMm: number): Promise<void>;
  /** Enters sketch mode through the top-bar Sketch button. */
  enterSketchMode(): Promise<void>;
  /** Dismisses the getting-started hint with a visible click, bounded. */
  dismissHint(): Promise<void>;
  /**
   * Arrives at the complete workbench for teaching: navigates, dismisses
   * the hint human-paced, and waits the settled first scene (the session
   * `openComplete` shape, pointer-first).
   */
  arriveAtWorkbench(): Promise<string>;
}

/** Binds the page into the chapter-facing driver. */
export function createTutorialDriver(page: Page): TutorialDriver {
  return {
    async step(stepId: string): Promise<void> {
      await step(page, stepId);
    },
    async dwell(ms: number = TUTORIAL_DWELL_MS): Promise<void> {
      await dwell(page, ms);
    },
    async humanPoint(target: Locator | ViewportPoint): Promise<void> {
      await humanPoint(page, target);
    },
    async humanClick(target: Locator | ViewportPoint): Promise<void> {
      await humanClick(page, target);
    },
    async openCommandMenu(rootId: string): Promise<void> {
      await humanOpenCommandMenu(page, rootId);
    },
    async clickCommandRow(rootId: string, commandId: string): Promise<void> {
      await humanClickCommandRow(page, rootId, commandId);
    },
    async activateSketchTool(toolId: string): Promise<void> {
      await humanActivateSketchTool(page, toolId);
    },
    async clickCanvasPoint(xMm: number, yMm: number): Promise<void> {
      await humanClickCanvasPoint(page, xMm, yMm);
    },
    async enterSketchMode(): Promise<void> {
      await humanEnterSketchMode(page);
    },
    async dismissHint(): Promise<void> {
      await humanDismissHint(page);
    },
    async arriveAtWorkbench(): Promise<string> {
      await page.goto("/workbench-complete");
      await humanDismissHint(page);
      return waitForRootSettle(page, COMPLETE_ROOT);
    },
  };
}

/**
 * Plays one chapter: opens its timeline, hands the page plus the bound
 * driver to its script, and closes the timeline with the final cue held.
 */
export async function playChapter(
  page: Page,
  chapter: ChapterModule,
): Promise<void> {
  const driver = createTutorialDriver(page);
  await beginChapter(page, chapter.definition.id, chapter.definition.title);
  await chapter.run(page, driver);
  await endChapter(page);
}
