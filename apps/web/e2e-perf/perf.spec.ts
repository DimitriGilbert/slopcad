/**
 * The Phase 29 performance specs: two measurements against the production
 * build —
 *
 * 1. the `/perf` fixture's in-page benchmarks (worker/WASM startup,
 *    per-operation round trips, tessellation transfer, projection, graph
 *    invalidation, scene settle, React commit work), collected from the
 *    JSON surface the fixture publishes;
 * 2. the `/render` PRODUCTION page's interaction latencies (first settled
 *    scene, parameter edit → settled frame, click → selection frame) —
 *    measured on the exact page the 87-test render suite pins, so the
 *    budgets guard the real surface, in-page (a MutationObserver watches
 *    the settle attributes; the driver never sits inside a measurement).
 *    The selection probe is hardened against frame-clock starvation on
 *    both sides of the boundary: its in-page waiter keeps a
 *    self-rescheduling requestAnimationFrame alive while pending (a
 *    loaded headless page can stop servicing rAF once idle — the render
 *    suite's documented starvation), and a driver-side watchdog
 *    (see {@link awaitSelectionFrame}) nudges the compositor if the
 *    clock dies anyway. Without these, the waiter parks for its full
 *    30 s deadline and shadows the run's real verdict — e.g. a blown
 *    budget in spec 1 — with an unrelated selection stall.
 *
 * Both specs aggregate with `e2e-perf/helpers` (median + p10/p90,
 * nearest-rank), write the machine-readable record, and enforce the
 * recorded budgets (`e2e-perf/budgets.json` — median over budget fails the
 * suite; the docs record every budget's headroom rationale).
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  faceSelectionKey,
  faceWithNormal,
  readFaceAnchors,
  readSelectionRegeneration,
} from "../e2e-render/helpers";
import {
  driverEnvironment,
  enforceBudgets,
  loadBudgets,
  recordMetrics,
  writeResults,
  type PerfRunRecord,
} from "./helpers";

/** The `/render` param-update loop's diameters (within the fixture's range). */
const RENDER_DIAMETERS: readonly number[] = [
  9, 10, 11, 12, 9.5, 10.5, 8.5, 12.5, 9.5, 10,
];

/** The faces the selection probe alternates between (semantic normals). */
const TOP_NORMAL: readonly [number, number, number] = [0, 0, 1];
const FRONT_WALL_NORMAL: readonly [number, number, number] = [0, -1, 0];

/**
 * The recording mode: `PERF_BASELINE=1 pnpm test:perf` runs the identical
 * measurements but skips the budgets gate (there is nothing to compare
 * against while recording the baseline). Never used by the wired scripts —
 * the normal `pnpm test:perf` always enforces `e2e-perf/budgets.json`.
 */
const BASELINE_MODE = process.env.PERF_BASELINE === "1";

/** The budgets for the metrics starting with `prefix` (all when `null`). */
function budgetSubset(
  budgets: Readonly<Record<string, number>>,
  prefix: string | null,
): Record<string, number> {
  const subset: Record<string, number> = {};
  for (const [metric, budget] of Object.entries(budgets)) {
    if (prefix === null || metric.startsWith(prefix)) subset[metric] = budget;
  }
  return subset;
}

/** One driver-side sleep beat (the watchdog's poll cadence). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Probes the page's frame clock with ONE requestAnimationFrame: resolves
 * within about a frame while the clock is alive; stays pending when the
 * loaded headless browser has stopped servicing rAF entirely (the render
 * suite's documented starvation — its settle waits nudge a frame for the
 * same reason). One-shot on purpose: unlike the fixture's own loops this
 * never reschedules itself, so a healthy page's frame behavior — and the
 * probe's measured window — is untouched. A probe that errors for
 * non-starvation reasons (a navigating page) counts as alive; the in-page
 * waiter's own deadline still governs those.
 */
function frameClockAlive(page: Page): Promise<boolean> {
  return Promise.race([
    page
      .evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              resolve();
            });
          }),
      )
      .then(
        () => true,
        () => true,
      ),
    sleep(250).then(() => false),
  ]);
}

/**
 * The render suite's frame nudge (`forceAnimationFrame`, verbatim
 * mechanism): a clipped 1×1 screenshot forces the compositor through a
 * frame, which flushes pending rAF callbacks — including the demand
 * render whose selection stamp the probe waits for. Reads pixels only;
 * no DOM or style mutation.
 */
async function forceCompositorFrame(page: Page): Promise<void> {
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
}

/**
 * The selection probe's driver-side backstop: awaits the in-page waiter
 * (`armed` — pointerdown → selection-frame stamp, measured entirely
 * in-page; the waiter itself keeps the page's frame clock alive with a
 * pending-only rAF keeper) and nudges the compositor if the clock dies
 * anyway — the keeper can only request frames, so a page whose
 * compositor stopped producing them entirely still needs the render
 * suite's forced frame. In a healthy page the clock probe resolves
 * within a frame, no nudge is ever taken, and the sample is exactly the
 * in-page window. Under starvation the probe hangs, one nudged
 * compositor frame flushes the pending rAF callbacks (the demand render
 * included), and the stamp lands instead of parking the waiter for its
 * full 30 s deadline — so a run whose real verdict is a blown budget
 * (or a green run) never gets shadowed by an unrelated selection stall.
 * The waiter's own 30 s in-page deadline still bounds genuine
 * never-settles, and its error propagates verbatim.
 */
async function awaitSelectionFrame(
  page: Page,
  armed: Promise<number>,
): Promise<number> {
  let armedSettled = false;
  const tracked = armed.then(
    (ms: number): number => {
      armedSettled = true;
      return ms;
    },
    (error: unknown): number => {
      armedSettled = true;
      throw error;
    },
  );
  while (!armedSettled) {
    if (await frameClockAlive(page)) {
      await sleep(50);
    } else {
      await forceCompositorFrame(page);
    }
  }
  return tracked;
}

test("the /perf fixture's in-page benchmarks hold their budgets", async ({
  page,
}) => {
  await page.goto("/perf");
  await page.waitForFunction(
    () =>
      document.getElementById("perf-root")?.getAttribute("data-perf-phase") ===
      "done",
    undefined,
    { timeout: 120_000, polling: 100 },
  );
  const raw = await page
    .locator("#perf-root")
    .getAttribute("data-perf-results");
  expect(raw, "the perf fixture must publish results").not.toBeNull();
  if (raw === null) throw new Error("unreachable: results checked above");
  const parsed: unknown = JSON.parse(raw);
  expect(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "the published results must be a JSON object",
  ).toBe(true);
  const published = parsed as {
    readonly samples: Readonly<Record<string, readonly number[]>>;
    readonly environment?: Readonly<Record<string, unknown>>;
    readonly geometry?: Readonly<Record<string, unknown>>;
  };
  expect(
    Object.keys(published.samples).length,
    "the perf fixture must publish metrics",
  ).toBeGreaterThan(0);

  let record: PerfRunRecord = {
    runAt: new Date().toISOString(),
    driver: driverEnvironment(),
    browser: published.environment ?? null,
    geometry: published.geometry ?? null,
    metrics: {},
    budgets: [],
  };
  record = recordMetrics(record, published.samples);
  if (BASELINE_MODE) {
    console.log("  PERF_BASELINE=1: recording, budgets not enforced.");
  } else {
    const inPage = budgetSubset(loadBudgets(), null);
    for (const metric of Object.keys(inPage)) {
      if (metric.startsWith("render.")) delete inPage[metric];
    }
    record = { ...record, budgets: enforceBudgets(record.metrics, inPage) };
  }
  await writeResults(record);
});

test("the /render production page's interaction latencies hold their budgets", async ({
  page,
}) => {
  await page.goto("/render");

  // The first settled scene, from navigation start (performance.now()'s
  // origin) to the first settle observation — one sample per page load;
  // run-to-run spread comes from suite repeats (documented in the docs).
  const firstSettleMs = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const root = document.getElementById("render-root");
        if (root === null) {
          reject(new Error("#render-root never appeared"));
          return;
        }
        const settled = (): boolean => {
          const inFlight = root.getAttribute("data-in-flight");
          const applied = root.getAttribute("data-applied-revision");
          const current = root.getAttribute("data-current-revision");
          const volume = root.getAttribute("data-volume");
          const rendered = root.getAttribute("data-cad-rendered-volume");
          return (
            inFlight === "0" &&
            applied !== null &&
            applied !== "" &&
            applied === current &&
            volume !== null &&
            volume !== "" &&
            rendered === volume
          );
        };
        const deadline = Date.now() + 30_000;
        const poll = (): void => {
          if (settled()) {
            resolve(performance.now());
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error("the /render scene never settled"));
            return;
          }
          setTimeout(poll, 10);
        };
        poll();
      }),
  );

  // Parameter edits: the input event → settled frame, entirely in-page
  // (Reflect.set + input event for the React-controlled input; a
  // MutationObserver on the settle attributes resolves the measurement).
  const paramUpdateSamples: number[] = [];
  for (const diameter of RENDER_DIAMETERS) {
    const elapsed = await page.evaluate(
      (value: number) =>
        new Promise<number>((resolve, reject) => {
          const root = document.getElementById("render-root");
          const input = document.getElementById("param-holeDiameter");
          if (root === null || !(input instanceof HTMLInputElement)) {
            reject(new Error("the parameter input never appeared"));
            return;
          }
          const started = performance.now();
          const settled = (): boolean => {
            const inFlight = root.getAttribute("data-in-flight");
            const applied = root.getAttribute("data-applied-revision");
            const current = root.getAttribute("data-current-revision");
            const volume = root.getAttribute("data-volume");
            const rendered = root.getAttribute("data-cad-rendered-volume");
            return (
              inFlight === "0" &&
              applied !== null &&
              applied !== "" &&
              applied === current &&
              volume !== null &&
              volume !== "" &&
              rendered === volume
            );
          };
          const observer = new MutationObserver(() => {
            if (settled()) {
              cleanup();
              resolve(performance.now() - started);
            }
          });
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`the ${String(value)} mm edit never settled`));
          }, 30_000);
          function cleanup(): void {
            clearTimeout(timer);
            observer.disconnect();
          }
          observer.observe(root, {
            attributes: true,
            attributeFilter: [
              "data-in-flight",
              "data-applied-revision",
              "data-current-revision",
              "data-volume",
              "data-cad-rendered-volume",
            ],
          });
          const proto = window.HTMLInputElement.prototype;
          const set = Reflect.set(proto, "value", String(value), input);
          if (!set) {
            cleanup();
            reject(new Error("setting #param-holeDiameter value failed"));
            return;
          }
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      diameter,
    );
    paramUpdateSamples.push(elapsed);
  }

  // Selection: a REAL click at a face anchor → the selection-frame settle
  // stamp, in-page from the canvas pointerdown (MutationObserver on
  // data-cad-selection-frame; the driver only delivers the click — the
  // waiter's own rAF keeper keeps the frame clock alive while pending,
  // with the driver-side watchdog as backstop, all outside the measured
  // window). The anchors are re-read BEFORE EVERY click — the param
  // updates above rebuilt the synthetic face space, so anchors from an
  // earlier state would address pixels that no longer belong to that
  // face.
  const canvas = page.locator("#render-viewport canvas");
  const box = await canvas.boundingBox();
  expect(box, "canvas bounding box").not.toBeNull();
  if (box === null) throw new Error("unreachable: box checked above");
  const selectionSamples: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const anchors = await readFaceAnchors(page);
    const target = faceWithNormal(
      anchors,
      i % 2 === 0 ? TOP_NORMAL : FRONT_WALL_NORMAL,
    );
    const revision = await readSelectionRegeneration(page);
    const expectedKey = faceSelectionKey(revision, target.faceIndex);
    const armed = page.evaluate(
      ({ expected }) =>
        new Promise<number>((resolve, reject) => {
          const root = document.getElementById("render-root");
          const queried = document.querySelector("#render-viewport canvas");
          if (root === null || !(queried instanceof HTMLCanvasElement)) {
            reject(new Error("the viewport canvas never appeared"));
            return;
          }
          const canvas = queried;
          let pressedAt: number | null = null;
          // The frame-clock keeper: a pending measurement deserves a live
          // frame clock. A loaded headless page can stop servicing
          // requestAnimationFrame entirely once it goes idle (the render
          // suite's documented starvation); the demand frame that must
          // carry the selection stamp is then never scheduled and the
          // waiter parks for its full deadline. While this waiter is
          // pending, a self-rescheduling rAF keeps the clock alive — the
          // same service a real user's active tab provides. It never
          // touches the measured timestamps (pointerdown → stamp) and
          // stops within one frame of cleanup.
          let done = false;
          const keepFrameClock = (): void => {
            if (done) return;
            requestAnimationFrame(keepFrameClock);
          };
          const onPointerDown = (): void => {
            pressedAt = performance.now();
          };
          const observer = new MutationObserver(() => {
            if (
              root.getAttribute("data-cad-selection-frame") === expected &&
              pressedAt !== null
            ) {
              cleanup();
              resolve(performance.now() - pressedAt);
            }
          });
          const timer = setTimeout(() => {
            cleanup();
            reject(
              new Error(`the selection frame never reached "${expected}"`),
            );
          }, 30_000);
          function cleanup(): void {
            done = true;
            clearTimeout(timer);
            observer.disconnect();
            canvas.removeEventListener("pointerdown", onPointerDown, {
              capture: true,
            });
          }
          observer.observe(root, {
            attributes: true,
            attributeFilter: ["data-cad-selection-frame"],
          });
          canvas.addEventListener("pointerdown", onPointerDown, {
            capture: true,
            once: true,
          });
          requestAnimationFrame(keepFrameClock);
        }),
      { expected: expectedKey },
    );
    await page.mouse.click(
      box.x + target.anchor.point[0],
      box.y + target.anchor.point[1],
    );
    selectionSamples.push(await awaitSelectionFrame(page, armed));
  }

  let record: PerfRunRecord = {
    runAt: new Date().toISOString(),
    driver: driverEnvironment(),
    browser: null,
    geometry: null,
    metrics: {},
    budgets: [],
  };
  record = recordMetrics(record, {
    "render.firstScene.loadToSettledMs": [firstSettleMs],
    "render.paramUpdate.inputToSettledMs": paramUpdateSamples,
    "render.selection.pointerToSelectionFrameMs": selectionSamples,
  });
  if (BASELINE_MODE) {
    console.log("  PERF_BASELINE=1: recording, budgets not enforced.");
  } else {
    record = {
      ...record,
      budgets: [
        ...record.budgets,
        ...enforceBudgets(
          record.metrics,
          budgetSubset(loadBudgets(), "render."),
        ),
      ],
    };
  }
  await writeResults(record);
});
