import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";
import {
  HOLE_DEFAULT_DEPTH_MM,
  HOLE_DEFAULT_DIAMETER_MM,
} from "../src/cad-workbench/hole";
import { CHAIN_FILLET_DEFAULT_RADIUS_MM } from "../src/cad-workbench/chain";

/**
 * Phase 26 PHASE-LEVEL e2e — the cross-feature workflow as ONE continuous
 * browser session on the deterministic render harness (production build,
 * SwiftShader, fixed 1280×720 DPR 1, one worker; config-level video
 * captures each journey — the full-workflow test IS the workflow video).
 *
 * ## The workflow (pinned stages, one page, one session)
 *
 * sketch a rectangle → Extrude (V1) → Hole (V2) → pick the corner edge →
 * Fillet (V3) → edit the UPSTREAM extrude depth → the regeneration cascade
 * re-executes every downstream stage (V1'→V2'→V3').
 *
 * ## KERNEL REALITY (the integration decision, disclosed)
 *
 * The chain runs as a SINGLE-KERNEL SESSION on the real OpenCascade worker:
 * the workbench session's Manifold kernel has no fillet
 * (`kernel/unsupported-operation`), and mixed-kernel-per-feature is not a
 * capability — one session boots one worker hosting one kernel. The
 * /workbench-chain page therefore executes extrude+hole+fillet ALL on OCCT
 * (the /worker-fillet precedent's worker entry), and every stage volume is
 * exact to the BREP band (1e-9 relative) — the analytic assertions below
 *
 *   V1 = 20·15·depth;  V2 = V1 − π·r²·holeDepth;  V3 = V2 − r²(1−π/4)·depth
 *
 * ## Failure propagation (pinned)
 *
 * An oversized fillet radius (25 mm outruns both adjacent faces) fails the
 * FILLET feature only: the dispatch rejects, the last-known-valid scene
 * stays up (same volume, same pixels), the structured `kernel/fillet-failed`
 * code lands on the error surface, and the timeline shows
 * extrude=valid, hole=valid, fillet=failed with the diagnostic attached.
 * Fixing the radius re-dispatches → the cascade settles green.
 *
 * ## Feature history (pinned)
 *
 * The timeline shows extrude→hole→fillet in document order with joined
 * statuses; undo/redo walks the WHOLE chain (each action is one atomic
 * transaction): fillet → hole → extrude → empty, and back — the scene
 * follows the document at every step.
 *
 * Machine surfaces: the session settle surface (`data-dispatched`,
 * `data-in-flight`, `data-applied-revision`, `data-current-revision`,
 * `data-volume`, `data-volume-exact`, `data-error`), the chain surfaces
 * (`data-chain-stage`, `data-stage-volumes`, `data-edge-anchors`,
 * `data-selected-edge`, `data-chain-failure`), `data-feature-timeline`,
 * `data-history`, and the canvas settle stamp (`data-cad-rendered-volume`).
 * Click derivation follows the house rule: sketch clicks from the
 * documented `SKETCH_CANVAS` transform, edge picks from the published
 * anchor surface — no guessed pixels.
 */

const ROOT = "#chain-root";
const SKETCH = "#sketch-root";
const VIEWPORT = "#chain-viewport";
const MODE_TOGGLE = '[data-testid="chain-mode-toggle"]';
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const HOLE_BUTTON = '[data-testid="chain-hole"]';
const FILLET_BUTTON = '[data-testid="chain-fillet"]';

/** The sketched rectangle: workplane (10,10) → (30,25) = 20 × 15 mm. */
const RECT = { x0: 10, y0: 10, x1: 30, y1: 25 } as const;

/** The pad's analytic volume and the hole/fillet stage formulas. */
const padVolume = (depthMm: number): number =>
  (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * depthMm;
const holedVolume = (depthMm: number): number =>
  padVolume(depthMm) -
  Math.PI * (HOLE_DEFAULT_DIAMETER_MM / 2) ** 2 * HOLE_DEFAULT_DEPTH_MM;
const filletedVolume = (depthMm: number, radiusMm: number): number =>
  holedVolume(depthMm) - radiusMm * radiusMm * (1 - Math.PI / 4) * depthMm;

/** The OCCT chain is exact BREP: only double-precision noise is allowed. */
const EXACT_BAND = 1e-9;

/** The world corner the workflow fillets: the pad's (30, 25) vertical. */
const CORNER = { x: 30, y: 25, zMid: 5 } as const;

interface StageVolumes {
  readonly extruded: number;
  readonly holed: number | null;
  readonly filleted: number | null;
}

interface EdgeAnchor {
  readonly point: readonly [number, number];
  readonly lengthMm: number;
  readonly centroidMm: readonly [number, number, number];
}

interface TimelineEntry {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly diagnostics: readonly { readonly message: string }[];
}

interface TimelineSurface {
  readonly entries: readonly TimelineEntry[];
  readonly executed: readonly string[];
}

interface ChainFailureSurface {
  readonly stage: string;
  readonly featureId: string;
  readonly code: string;
  readonly message: string;
}

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Activates a sketch tool through the toolbar. */
async function activateTool(page: Page, toolId: string): Promise<void> {
  await page.locator(`[data-sketch-tool-id="${toolId}"]`).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    toolId,
  );
}

/** Clicks the sketch canvas at a workplane mm point. */
async function clickCanvasPoint(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page.locator(`${SKETCH} [data-sketch-surface]`).click({
    position: canvasPoint(x, y),
  });
}

/** Draws the 20×15 rectangle with the rectangle tool. */
async function drawRectangle(page: Page): Promise<void> {
  await activateTool(page, "rectangle");
  await clickCanvasPoint(page, RECT.x0, RECT.y0);
  await clickCanvasPoint(page, RECT.x1, RECT.y1);
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { kind: string }[];
  expect(entities.filter((entity) => entity.kind === "rectangle").length).toBe(
    1,
  );
}

/** The session's dispatch counter (the airtight pre-settle wait). */
async function dispatchedCount(page: Page): Promise<number> {
  const raw = await page
    .locator(ROOT)
    .getAttribute("data-dispatched")
    .then((value) => value ?? "0");
  return Number(raw);
}

/**
 * Waits until the session's dispatch counter passes `previous` — the
 * pre-settle race guard: the document change, the scene surfaces, and the
 * dispatch effect land in separate commits, so the settle wait may only
 * start once the dispatch itself is in flight.
 */
async function waitForNextDispatch(
  page: Page,
  previous: number,
): Promise<void> {
  await page.waitForFunction(
    ({ id, previous }) => {
      const root = document.getElementById(id);
      return (
        root !== null &&
        Number(root.getAttribute("data-dispatched") ?? "0") > previous
      );
    },
    { id: "chain-root", previous },
  );
}

/** Waits for the next dispatch, then for its settled scene. */
async function settleNextDispatch(
  page: Page,
  previous: number,
): Promise<string> {
  await waitForNextDispatch(page, previous);
  return waitForSettledScene(page, "chain-root");
}

/** Reads the applied scene's per-stage full-precision volumes. */
async function readStageVolumes(page: Page): Promise<StageVolumes> {
  const raw = await page
    .locator(ROOT)
    .getAttribute("data-stage-volumes")
    .then((value) => value ?? "{}");
  const parsed = JSON.parse(raw) as Partial<StageVolumes>;
  expect(typeof parsed.extruded, `stage volumes ${raw}`).toBe("number");
  return parsed as StageVolumes;
}

/** Asserts a stage volume against its analytic value at the exact band. */
function expectExact(actual: number, analytic: number, label: string): void {
  expect(
    Math.abs(actual - analytic) / analytic,
    `${label}: ${String(actual)} vs analytic ${String(analytic)}`,
  ).toBeLessThan(EXACT_BAND);
}

/** Reads the feature timeline surface (entries + last run's sequence). */
async function readTimeline(page: Page): Promise<TimelineSurface> {
  const raw = await page
    .locator(ROOT)
    .getAttribute("data-feature-timeline")
    .then((value) => value ?? "{}");
  return JSON.parse(raw) as TimelineSurface;
}

/** Reads the structured chain failure surface ("" when none). */
async function readChainFailure(
  page: Page,
): Promise<ChainFailureSurface | null> {
  const raw = await page
    .locator(ROOT)
    .getAttribute("data-chain-failure")
    .then((value) => value ?? "");
  return raw === "" ? null : (JSON.parse(raw) as ChainFailureSurface);
}

/**
 * Finds the corner vertical edge at the world corner — the fillet target —
 * straight from the published anchors (centroid, kernel-measured length).
 */
async function cornerEdgeOrdinal(page: Page): Promise<{
  readonly ordinal: string;
  readonly anchor: EdgeAnchor;
}> {
  const raw = await page
    .locator(ROOT)
    .getAttribute("data-edge-anchors")
    .then((value) => value ?? "{}");
  const anchors = JSON.parse(raw) as Record<string, EdgeAnchor>;
  for (const [ordinal, anchor] of Object.entries(anchors)) {
    const vertical =
      Math.abs(anchor.centroidMm[2] - CORNER.zMid) < 1e-6 &&
      Math.abs(anchor.centroidMm[0] - CORNER.x) < 1e-6 &&
      Math.abs(anchor.centroidMm[1] - CORNER.y) < 1e-6;
    if (vertical) {
      return { ordinal, anchor };
    }
  }
  throw new Error(
    `No corner vertical edge in the anchor surface: ${raw.slice(0, 400)}`,
  );
}

/** Fills one parameter through the panel and applies it. */
async function editParameter(
  page: Page,
  name: string,
  value: string,
): Promise<void> {
  await page.getByLabel(name, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Apply" }).click();
}

/** Enters sketch mode from a fresh chain page. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.goto("/workbench-chain");
  await expect(page.locator(ROOT)).toHaveAttribute("data-chain-stage", "empty");
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
}

/**
 * Runs the sketch → extrude → hole journey: the settled pad (V1), then the
 * settled holed solid (V2), asserting each stage's exact analytic volume.
 */
async function runToHoledState(page: Page): Promise<void> {
  await enterSketchMode(page);
  await drawRectangle(page);
  const beforeExtrude = await dispatchedCount(page);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-sketch-mode", "model");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-chain-stage",
    "extrude",
  );
  await settleNextDispatch(page, beforeExtrude);
  let stages = await readStageVolumes(page);
  expectExact(stages.extruded, padVolume(EXTRUDE_DEFAULT_DEPTH_MM), "V1");

  const beforeHole = await dispatchedCount(page);
  await page.locator(HOLE_BUTTON).click();
  await expect(page.locator(ROOT)).toHaveAttribute("data-chain-stage", "hole");
  await settleNextDispatch(page, beforeHole);
  stages = await readStageVolumes(page);
  expectExact(
    stages.extruded,
    padVolume(EXTRUDE_DEFAULT_DEPTH_MM),
    "V1 after hole",
  );
  expectExact(stages.holed ?? 0, holedVolume(EXTRUDE_DEFAULT_DEPTH_MM), "V2");
}

/**
 * Runs the whole build-up to the filleted state: pad, hole, corner-edge
 * pick, fillet at the default radius — the cascade's starting point.
 */
async function runToFilletedState(page: Page): Promise<void> {
  await runToHoledState(page);

  // EDGE PICK: the projected anchor of the target snapshot's corner
  // vertical — the pick IS the snapshot ordinal (no guessed pixels).
  const { ordinal, anchor } = await cornerEdgeOrdinal(page);
  await page.locator(VIEWPORT).click({
    position: { x: anchor.point[0], y: anchor.point[1] },
  });
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-selected-edge",
    ordinal,
  );

  // FILLET: the action commits radius + ordinal + body + feature in ONE
  // transaction; the chain re-dispatches and settles at V3.
  const beforeFillet = await dispatchedCount(page);
  await page.locator(FILLET_BUTTON).click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-chain-stage",
    "fillet",
  );
  await settleNextDispatch(page, beforeFillet);
  const stages = await readStageVolumes(page);
  expectExact(
    stages.filleted ?? 0,
    filletedVolume(EXTRUDE_DEFAULT_DEPTH_MM, CHAIN_FILLET_DEFAULT_RADIUS_MM),
    "V3",
  );

  // FEATURE HISTORY: the timeline shows the chain in document order, green.
  const timeline = await readTimeline(page);
  expect(timeline.entries.map((entry) => entry.kind)).toEqual([
    "extrude",
    "hole",
    "fillet",
  ]);
  expect(timeline.entries.map((entry) => entry.status)).toEqual([
    "valid",
    "valid",
    "valid",
  ]);
  // The commit's domain run executed exactly the NEW feature (the robust
  // loop: unchanged upstream keeps the valid state it already earned).
  expect(timeline.executed).toEqual(["feat_fillet1"]);
}

test("the full cross-feature workflow in one continuous session: sketch → extrude → hole → fillet → parameter edit → regenerate, with failure propagation and recovery", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await runToFilletedState(page);

  // SCREENSHOT: the settled filleted scene (stage 3 of the workflow).
  const filletedShot = await page.locator(`${VIEWPORT} canvas`).screenshot();
  await saveArtifact("workflow-stage-3-fillet.png", filletedShot);

  // PARAMETER EDIT CASCADE: edit the UPSTREAM extrude depth — every
  // downstream stage re-executes (the whole chain IS the dispatch), and
  // all three stage volumes land on their new analytic values.
  const beforeCascade = await dispatchedCount(page);
  await editParameter(page, "extrudeDepth", "12");
  await settleNextDispatch(page, beforeCascade);
  const cascaded = await readStageVolumes(page);
  expectExact(cascaded.extruded, padVolume(12), "V1'");
  expectExact(cascaded.holed ?? 0, holedVolume(12), "V2'");
  expectExact(
    cascaded.filleted ?? 0,
    filletedVolume(12, CHAIN_FILLET_DEFAULT_RADIUS_MM),
    "V3'",
  );
  // The domain pass re-executed the whole chain (the executed sequence).
  const cascadeTimeline = await readTimeline(page);
  expect(cascadeTimeline.executed).toEqual([
    "feat_extrude",
    "feat_hole1",
    "feat_fillet1",
  ]);
  expect(cascadeTimeline.entries.map((entry) => entry.status)).toEqual([
    "valid",
    "valid",
    "valid",
  ]);

  // SCREENSHOT: the cascaded scene (stage 4). Its canvas bytes are the
  // byte-stability reference for the recovery scene below (identical
  // geometry, independent OCCT rebuilds).
  const cascadeShot = await page.locator(`${VIEWPORT} canvas`).screenshot();
  await saveArtifact("workflow-stage-4-cascade.png", cascadeShot);

  // FAILURE PROPAGATION: an oversized radius fails the FILLET feature —
  // probed, OCCT answers IsDone = false and the adapter maps that to
  // kernel/fillet-failed. The dispatch rejects: the last-known-valid scene
  // stays visible (same full-precision volume), the structured failure
  // lands on the machine surfaces, and the timeline shows the failed
  // feature with its diagnostic while upstream stays valid.
  await editParameter(page, "filletRadius1", "25");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-error",
    /kernel\/fillet-failed/,
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-in-flight", "0");
  const failure = await readChainFailure(page);
  expect(failure).not.toBeNull();
  expect(failure?.stage).toBe("fillet");
  expect(failure?.featureId).toBe("feat_fillet1");
  expect(failure?.code).toBe("kernel/fillet-failed");
  expectExact(
    Number(
      await page
        .locator(ROOT)
        .getAttribute("data-volume-exact")
        .then((value) => value ?? "0"),
    ),
    filletedVolume(12, CHAIN_FILLET_DEFAULT_RADIUS_MM),
    "the last-known-valid scene after the failure",
  );
  const failureTimeline = await readTimeline(page);
  expect(failureTimeline.entries.map((entry) => entry.status)).toEqual([
    "valid",
    "valid",
    "failed",
  ]);
  // The failure verdict's domain run executed exactly the judged feature.
  expect(failureTimeline.executed).toEqual(["feat_fillet1"]);
  const filletEntry = failureTimeline.entries[2];
  expect(filletEntry?.diagnostics.length ?? 0).toBeGreaterThan(0);
  expect(filletEntry?.diagnostics[0]?.message).toContain(
    "kernel/fillet-failed",
  );

  // SCREENSHOT: the failed state — the diagnostics visible, the scene
  // untouched (stage 5).
  const failureShot = await page.locator(`${VIEWPORT} canvas`).screenshot();
  await saveArtifact("workflow-stage-5-failure.png", failureShot);
  expect(failureShot.equals(cascadeShot)).toBe(true);

  // RECOVERY: fix the radius — the re-dispatch settles and the cascade
  // runs green again: error surfaces cleared, statuses valid, the same
  // analytic V3', and the SAME canvas bytes as the cascaded scene (two
  // independent rebuilds of identical geometry).
  const beforeRecovery = await dispatchedCount(page);
  await editParameter(
    page,
    "filletRadius1",
    String(CHAIN_FILLET_DEFAULT_RADIUS_MM),
  );
  await settleNextDispatch(page, beforeRecovery);
  const recovered = await readStageVolumes(page);
  expectExact(
    recovered.filleted ?? 0,
    filletedVolume(12, CHAIN_FILLET_DEFAULT_RADIUS_MM),
    "the recovered V3'",
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-error", "");
  await expect(page.locator(ROOT)).toHaveAttribute("data-chain-failure", "");
  const recoveryTimeline = await readTimeline(page);
  expect(recoveryTimeline.entries.map((entry) => entry.status)).toEqual([
    "valid",
    "valid",
    "valid",
  ]);
  expect(recoveryTimeline.executed).toEqual(["feat_fillet1"]);

  // SCREENSHOT: the recovered scene (stage 6) — byte-identical to the
  // cascaded scene's canvas.
  const recoveryShot = await page.locator(`${VIEWPORT} canvas`).screenshot();
  await saveArtifact("workflow-stage-6-recovery.png", recoveryShot);
  expect(
    recoveryShot.equals(cascadeShot),
    `recovery sha256=${sha256(recoveryShot)} vs cascade sha256=${sha256(cascadeShot)}`,
  ).toBe(true);
});

test("feature history stays correct across the chain: timeline order and statuses, undo and redo through every stage", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await runToFilletedState(page);
  expect(await page.locator(ROOT).getAttribute("data-history")).toBe(
    JSON.stringify({ canUndo: true, canRedo: false, cursor: 3, depth: 3 }),
  );

  // UNDO through the chain, one transaction at a time: the scene follows
  // the document — fillet → hole → extrude → empty.
  const beforeUndo1 = await dispatchedCount(page);
  await page.locator("#history-undo").click();
  await settleNextDispatch(page, beforeUndo1);
  await expect(page.locator(ROOT)).toHaveAttribute("data-chain-stage", "hole");
  expectExact(
    (await readStageVolumes(page)).holed ?? 0,
    holedVolume(EXTRUDE_DEFAULT_DEPTH_MM),
    "undo1 → V2",
  );
  let timeline = await readTimeline(page);
  expect(timeline.entries.map((entry) => entry.kind)).toEqual([
    "extrude",
    "hole",
  ]);

  const beforeUndo2 = await dispatchedCount(page);
  await page.locator("#history-undo").click();
  await settleNextDispatch(page, beforeUndo2);
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-chain-stage",
    "extrude",
  );
  expectExact(
    (await readStageVolumes(page)).extruded,
    padVolume(EXTRUDE_DEFAULT_DEPTH_MM),
    "undo2 → V1",
  );

  await page.locator("#history-undo").click();
  // The empty document dispatches nothing: the stage surface flips with
  // the document while the dispatch counter holds.
  await expect(page.locator(ROOT)).toHaveAttribute("data-chain-stage", "empty");
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-history",
    JSON.stringify({ canUndo: false, canRedo: true, cursor: 0, depth: 3 }),
  );

  // REDO back up the chain: extrude → hole → fillet, each settling at its
  // analytic volume.
  const beforeRedo1 = await dispatchedCount(page);
  await page.locator("#history-redo").click();
  await settleNextDispatch(page, beforeRedo1);
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-chain-stage",
    "extrude",
  );
  expectExact(
    (await readStageVolumes(page)).extruded,
    padVolume(EXTRUDE_DEFAULT_DEPTH_MM),
    "redo1 → V1",
  );

  const beforeRedo2 = await dispatchedCount(page);
  await page.locator("#history-redo").click();
  await settleNextDispatch(page, beforeRedo2);
  await expect(page.locator(ROOT)).toHaveAttribute("data-chain-stage", "hole");
  expectExact(
    (await readStageVolumes(page)).holed ?? 0,
    holedVolume(EXTRUDE_DEFAULT_DEPTH_MM),
    "redo2 → V2",
  );

  const beforeRedo3 = await dispatchedCount(page);
  await page.locator("#history-redo").click();
  await settleNextDispatch(page, beforeRedo3);
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-chain-stage",
    "fillet",
  );
  expectExact(
    (await readStageVolumes(page)).filleted ?? 0,
    filletedVolume(EXTRUDE_DEFAULT_DEPTH_MM, CHAIN_FILLET_DEFAULT_RADIUS_MM),
    "redo3 → V3",
  );
  timeline = await readTimeline(page);
  expect(timeline.entries.map((entry) => entry.status)).toEqual([
    "valid",
    "valid",
    "valid",
  ]);
  expect(timeline.executed).toEqual(["feat_fillet1"]);
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-history",
    JSON.stringify({ canUndo: true, canRedo: false, cursor: 3, depth: 3 }),
  );
});

test("the settled filleted chain scene reproduces byte-identically in a second context", async ({
  browser,
}) => {
  test.setTimeout(360_000);

  const journey = async (): Promise<Buffer> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await runToFilletedState(page);
      return await page.locator(`${VIEWPORT} canvas`).screenshot();
    } finally {
      await context.close();
    }
  };

  const first = await journey();
  await saveArtifact("workflow-repro-1.png", first);
  const second = await journey();
  await saveArtifact("workflow-repro-2.png", second);
  expect(
    second.equals(first),
    `repro sha256=${sha256(second)} vs first=${sha256(first)}`,
  ).toBe(true);
});
