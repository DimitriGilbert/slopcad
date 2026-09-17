import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 20 e2e — feature history and robust regeneration on the composed
 * workbench (`/workbench`). The page threads regeneration state across
 * edits (diff → markStale → one `regenerate` pass with the executor
 * stand-in, the suppressed set, the rollback marker, and the prior
 * executor-results registry), and renders the FIRST-CLASS history surface:
 * the timeline strip (feature chips in document order with their joined
 * five-way statuses, the clickable rollback marker between chips, suppress
 * toggles) beside the existing undo/redo pair. Every assertion reads the
 * machine-readable `data-feature-timeline` surface (rollback marker,
 * per-feature joined statuses, the last run's executed sequence) — pixels
 * only ever confirm what the surface already proves:
 *
 *  - BOOT — the timeline lists the features in document order, all valid,
 *    and the composed page is byte-stable across two full runs;
 *  - UPSTREAM EDIT — editing `translate_x` re-executes the translate
 *    feature AND its downstream rotate feature (the declared feature→feature
 *    chain) with a settled scene; undo and redo reproduce the IDENTICAL
 *    executed sequence (the determinism pin, browser side);
 *  - ROLLBACK — clicking the gap between the chips parks everything beyond
 *    the marker (`beyond-rollback`, never executed; an already-valid
 *    upstream does not re-run); clicking the marker removes it and
 *    re-executes exactly what was parked;
 *  - SUPPRESSION — suppressing the upstream feature re-runs its downstream
 *    WITHOUT it (the Phase 6.3 rule); un-suppressing re-runs both;
 *  - FAILURE / RECOVERY — a negative translate component fails the
 *    translate feature (diagnostics on the feature, downstream gated
 *    stale, the scene untouched); correcting the parameter regenerates the
 *    whole chain green;
 *  - BASELINE — the combined history+error state (active rollback marker
 *    AND a failed feature) is byte-stable across two full runs under the
 *    settle discipline;
 *  - VIDEO — the failure→rollback→recovery workflow is captured on video.
 */

const ROOT = "workbench-root";
const TREE = '[data-slot="cad-model-tree"]';
const TRANSLATE_FEATURE = "feat_translate_plate";
const ROTATE_FEATURE = "feat_rotate_plate";

/** One joined-status entry of the machine-readable timeline surface. */
interface TimelineEntrySurface {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly diagnostics: readonly { readonly message: string }[];
}

/** The `data-feature-timeline` view. */
interface TimelineSurface {
  readonly rollback: { readonly afterFeatureId: string | null } | null;
  readonly entries: readonly TimelineEntrySurface[];
  readonly executed: readonly string[];
}

/**
 * A serializable expectation the in-page matcher evaluates against the
 * timeline surface (Playwright predicates must serialize; module-scope
 * constants would not follow a function's source into the page).
 */
interface TimelineExpectation {
  /** The exact executed sequence (`|`-joined comparison in-page). */
  readonly executed?: readonly string[];
  /** The exact marker: `null` demands none, an id demands that anchor. */
  readonly rollbackAfter?: string | null;
  /** Every pair demanded as [featureId, joined status]. */
  readonly statuses?: readonly (readonly [string, string])[];
  /** A feature whose diagnostics must include `text`. */
  readonly diagnosticIncludes?: readonly (readonly [string, string])[];
}

/** A panel field by its label — which IS the parameter name (domain data). */
function panelField(page: Page, name: string): Locator {
  return page.locator(
    '[data-slot="cad-parameter-panel"]',
  ).getByLabel(name, { exact: true });
}

/** The submit button of the panel's Formedible form. */
function applyButton(page: Page): Locator {
  return page.getByRole("button", { name: "Apply" });
}

/** The timeline chip for a feature id. */
function timelineChip(page: Page, featureId: string): Locator {
  return page.locator(
    `[data-testid="timeline-chip"][data-timeline-id="${featureId}"]`,
  );
}

/** A named rollback gap of the timeline strip. */
function rollbackGap(page: Page, label: string): Locator {
  return page.getByRole("button", { name: label, exact: true });
}

async function readTimeline(page: Page): Promise<TimelineSurface> {
  const raw = await page
    .locator(`#${ROOT}`)
    .getAttribute("data-feature-timeline");
  expect(raw, "data-feature-timeline must exist").not.toBeNull();
  return JSON.parse(raw ?? "{}") as TimelineSurface;
}

/**
 * Waits until the timeline surface satisfies the serializable expectation,
 * then returns a fresh read. The matching runs IN THE PAGE over plain data.
 */
async function waitForTimeline(
  page: Page,
  expected: TimelineExpectation,
): Promise<TimelineSurface> {
  await page.waitForFunction(({ check }) => {
    const root = document.getElementById("workbench-root");
    const raw = root?.getAttribute("data-feature-timeline") ?? null;
    if (raw === null) return false;
    const surface = JSON.parse(raw) as {
      rollback: { afterFeatureId: string | null } | null;
      entries: { id: string; status: string; diagnostics: { message: string }[] }[];
      executed: string[];
    };
    if (
      check.executed !== undefined &&
      surface.executed.join("|") !== check.executed.join("|")
    ) {
      return false;
    }
    if (check.rollbackAfter !== undefined) {
      if (
        check.rollbackAfter === null
          ? surface.rollback !== null
          : surface.rollback?.afterFeatureId !== check.rollbackAfter
      ) {
        return false;
      }
    }
    for (const [id, status] of check.statuses ?? []) {
      const entry = surface.entries.find((candidate) => candidate.id === id);
      if (entry === undefined || entry.status !== status) return false;
    }
    for (const [id, text] of check.diagnosticIncludes ?? []) {
      const entry = surface.entries.find((candidate) => candidate.id === id);
      if (
        entry === undefined ||
        !entry.diagnostics.some((diagnostic) => diagnostic.message.includes(text))
      ) {
        return false;
      }
    }
    return true;
  }, { check: expected });
  return readTimeline(page);
}

/** Waits until the command log holds exactly `count` entries. */
async function waitForCommandCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    ({ id, wanted }) => {
      const root = document.getElementById(id);
      if (root === null) return false;
      const log = JSON.parse(
        root.getAttribute("data-command-log") ?? "[]",
      ) as unknown[];
      return log.length === wanted;
    },
    { id: ROOT, wanted: count },
  );
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

test("the feature timeline boots byte-stable, in document order, all valid", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);
  const surface = await readTimeline(page);
  expect(surface.rollback).toBeNull();
  expect(
    surface.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
    })),
  ).toEqual([
    { id: TRANSLATE_FEATURE, kind: "translate", status: "valid" },
    { id: ROTATE_FEATURE, kind: "rotate", status: "valid" },
  ]);
  // The boot run executed the whole document, in evaluation order.
  expect(surface.executed).toEqual([TRANSLATE_FEATURE, ROTATE_FEATURE]);
  await expect(page.getByTestId("timeline-summary")).toHaveText("2 executed");
  const shotFirst = await page.screenshot();

  // A full second run: the same composed page, so the same settled bytes.
  await page.reload();
  await waitForSettledScene(page, ROOT);
  const shotSecond = await page.screenshot();
  expect(
    shotSecond.equals(shotFirst),
    `run1 sha256=${sha256(shotFirst)} vs run2 sha256=${sha256(shotSecond)}`,
  ).toBe(true);
  await saveArtifact("cad-history-boot-run1.png", shotFirst);
  await saveArtifact("cad-history-boot-run2.png", shotSecond);
});

test("an upstream parameter edit regenerates the downstream chain deterministically", async ({
  page,
}) => {
  await page.goto("/workbench");
  const volume = await waitForSettledScene(page, ROOT);

  // The upstream edit: one canonical parameter.set, then the threaded loop
  // re-executes the translate feature AND its downstream rotate feature.
  await panelField(page, "translate_x").fill("4");
  await applyButton(page).click();
  await waitForCommandCount(page, 1);
  const edited = await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE, ROTATE_FEATURE],
    rollbackAfter: null,
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
  // The settled geometry: the fixture's scene follows the hole parameter
  // only, so a translate edit leaves the settled volume exactly as it was
  // (the settle stamp still proves the pixels belong to the numbers).

  // Undo reverts the parameter: the same chain re-executes, deterministically.
  await page.locator("#history-undo").click();
  const undone = await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE, ROTATE_FEATURE],
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
  expect(await waitForSettledScene(page, ROOT)).toBe(volume);

  // Redo re-applies the edit: the identical executed sequence once more —
  // the same change applied twice yields the same outcome sequence.
  await page.locator("#history-redo").click();
  const redone = await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE, ROTATE_FEATURE],
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
  expect(redone.executed).toEqual(edited.executed);
  expect(redone.executed).toEqual(undone.executed);
  expect(await waitForSettledScene(page, ROOT)).toBe(volume);
});

test("the rollback marker parks downstream features; removing it re-executes them", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // Click the gap between the two chips: the marker parks the rotate
  // feature (beyond-rollback). Nothing is due in the executed zone, so
  // nothing re-runs — parking is exclusion, not invalidation. The tree
  // keeps showing rotate's durable state: stale (due).
  await rollbackGap(page, "Roll back after translate").click();
  const parked = await waitForTimeline(page, {
    executed: [],
    rollbackAfter: TRANSLATE_FEATURE,
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "beyond-rollback"],
    ],
  });
  expect(parked.entries.map((entry) => entry.status)).toEqual([
    "valid",
    "beyond-rollback",
  ]);
  await expect(timelineChip(page, ROTATE_FEATURE)).toHaveAttribute(
    "data-timeline-status",
    "beyond-rollback",
  );
  await expect(
    page.locator(`${TREE} [data-node-key="feature|${ROTATE_FEATURE}"]`),
  ).toHaveAttribute("data-status", "stale");
  await expect(page.getByTestId("timeline-summary")).toHaveText(
    "rollback · 0 executed · 1 parked",
  );
  await expect(page.getByTestId("rollback-marker")).toHaveCount(1);

  // Removing the marker re-executes exactly what was parked (stale is due);
  // the valid upstream feature is not due and does not re-run.
  await rollbackGap(page, "Remove rollback point — Roll back after translate").click();
  const unrolled = await waitForTimeline(page, {
    executed: [ROTATE_FEATURE],
    rollbackAfter: null,
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
  expect(unrolled.entries.map((entry) => entry.status)).toEqual([
    "valid",
    "valid",
  ]);
  await expect(page.getByTestId("rollback-marker")).toHaveCount(0);
});

test("suppressing the upstream feature re-runs its downstream without it", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // Suppress translate: it is skipped (never executed, no gating) and the
  // rotate feature RE-RUNS without it — the Phase 6.3 rule.
  await page.getByRole("button", { name: "Suppress translate" }).click();
  const suppressed = await waitForTimeline(page, {
    executed: [ROTATE_FEATURE],
    statuses: [
      [TRANSLATE_FEATURE, "suppressed"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
  expect(suppressed.rollback).toBeNull();
  await expect(timelineChip(page, TRANSLATE_FEATURE)).toHaveAttribute(
    "data-timeline-status",
    "suppressed",
  );

  // Un-suppress: the feature is due again (suppressed ≠ valid), and because
  // it executed, its downstream re-runs with it.
  await page.getByRole("button", { name: "Include translate" }).click();
  await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE, ROTATE_FEATURE],
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
});

test("a failed feature is visible, gates its downstream, and recovers", async ({
  page,
}) => {
  await page.goto("/workbench");
  const volume = await waitForSettledScene(page, ROOT);

  // The failure: the fixture's executor stand-in refuses a negative
  // translate component. The translate feature is FAILED with diagnostics;
  // its downstream is gated stale; the scene is untouched.
  await panelField(page, "translate_x").fill("-2");
  await applyButton(page).click();
  await waitForCommandCount(page, 1);
  await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE],
    statuses: [
      [TRANSLATE_FEATURE, "failed"],
      [ROTATE_FEATURE, "stale"],
    ],
    diagnosticIncludes: [[TRANSLATE_FEATURE, "negative"]],
  });
  expect(await waitForSettledScene(page, ROOT)).toBe(volume);
  const failedTreeRow = page.locator(
    `${TREE} [data-node-key="feature|${TRANSLATE_FEATURE}"]`,
  );
  await expect(failedTreeRow).toHaveAttribute("data-status", "failed");
  await expect(failedTreeRow).toContainText("negative");
  await expect(page.getByTestId("timeline-summary")).toHaveText("1 executed");

  // The recovery: correcting the parameter regenerates the whole chain green.
  await panelField(page, "translate_x").fill("1");
  await applyButton(page).click();
  await waitForCommandCount(page, 2);
  await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE, ROTATE_FEATURE],
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
  await expect(failedTreeRow).toHaveAttribute("data-status", "valid");
  await expect(page.getByTestId("timeline-summary")).toHaveText("2 executed");
});

test("the history+error state is a byte-stable screenshot baseline", async ({
  page,
}) => {
  // The combined state: an ACTIVE rollback marker (rotate parked) AND a
  // failed upstream feature — the history surface and the error state in
  // one honest frame. Recreated twice from a fresh load.
  const capture = async (): Promise<Buffer> => {
    await page.goto("/workbench");
    await waitForSettledScene(page, ROOT);
    await rollbackGap(page, "Roll back after translate").click();
    await waitForTimeline(page, {
      rollbackAfter: TRANSLATE_FEATURE,
      statuses: [[ROTATE_FEATURE, "beyond-rollback"]],
    });
    await panelField(page, "translate_x").fill("-2");
    await applyButton(page).click();
    await waitForCommandCount(page, 1);
    await waitForTimeline(page, {
      executed: [TRANSLATE_FEATURE],
      rollbackAfter: TRANSLATE_FEATURE,
      statuses: [
        [TRANSLATE_FEATURE, "failed"],
        [ROTATE_FEATURE, "beyond-rollback"],
      ],
    });
    await settleForCapture(page);
    return page.screenshot();
  };

  const first = await capture();
  const second = await capture();
  expect(
    second.equals(first),
    `run1 sha256=${sha256(first)} vs run2 sha256=${sha256(second)}`,
  ).toBe(true);
  await saveArtifact("cad-history-error.png", first);
});

test("the failure, rollback, and recovery workflow is captured on video", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);

  // The workflow capture holds each state for an operator beat (the same
  // settle discipline as the screenshot baselines) so the screencast
  // provably contains every phase, not just the endpoints. The clipped
  // screenshot is the established paint flush: under SwiftShader, DOM-only
  // state changes can otherwise sit unpainted until the next compositor
  // frame, and the video would skip the phase entirely.
  const beat = async (): Promise<void> => {
    await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
    await page.waitForTimeout(400);
    await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
    await settleForCapture(page);
  };

  // Failure: negative component, failed feature, gated downstream.
  await panelField(page, "translate_x").fill("-2");
  await applyButton(page).click();
  await waitForCommandCount(page, 1);
  await waitForTimeline(page, {
    statuses: [
      [TRANSLATE_FEATURE, "failed"],
      [ROTATE_FEATURE, "stale"],
    ],
  });
  await beat();

  // History in the same workflow: roll the timeline back past the rotate
  // feature (the failed feature is due, so it re-attempts and fails again;
  // the gated rotate parks), then un-roll (rotate re-executes).
  await rollbackGap(page, "Roll back after translate").click();
  await waitForTimeline(page, {
    rollbackAfter: TRANSLATE_FEATURE,
    statuses: [
      [TRANSLATE_FEATURE, "failed"],
      [ROTATE_FEATURE, "beyond-rollback"],
    ],
  });
  await beat();
  await rollbackGap(page, "Remove rollback point — Roll back after translate").click();
  // Un-rolling EXPOSES the gated rotate feature (stale, due) while the
  // failed upstream re-attempts and fails again — honest gating, no
  // downstream execution through a failed input.
  await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE],
    rollbackAfter: null,
    statuses: [
      [TRANSLATE_FEATURE, "failed"],
      [ROTATE_FEATURE, "stale"],
    ],
  });
  await beat();

  // Recovery: fix the parameter; the whole chain regenerates green.
  await panelField(page, "translate_x").fill("1");
  await applyButton(page).click();
  await waitForCommandCount(page, 2);
  await waitForTimeline(page, {
    executed: [TRANSLATE_FEATURE, ROTATE_FEATURE],
    statuses: [
      [TRANSLATE_FEATURE, "valid"],
      [ROTATE_FEATURE, "valid"],
    ],
  });
  await beat();

  const video = page.video();
  expect(video, "the page must be recorded").not.toBeNull();
  const path = await video?.path();
  expect(path, "a video file must be attached").toBeTruthy();
});
