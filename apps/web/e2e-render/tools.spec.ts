import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  activateTool,
  clickFaceAnchor,
  dragFaceAnchorToFaceAnchor,
  faceWithNormal,
  readFaceAnchors,
  readRenderedFrames,
  readSelection,
  readSelectionRegeneration,
  readToolSurface,
  saveArtifact,
  sha256,
  waitForRenderedFrames,
  waitForRenderedTranslate,
  waitForSelectionFrame,
  waitForSettledScene,
  type FaceAnchor,
} from "./helpers";

/**
 * Phase 13 headless-tool-system e2e — the phase-level browser gate for the
 * INTERACTION layer. The tools themselves are exercised headless in cad-core
 * unit tests; this spec proves the browser loop: the fixture normalizes
 * pointer/keyboard activity into tool events, the manager drives exactly one
 * active tool, tools issue commands (never direct mutation), and the visible
 * scene follows the honest execution scope:
 *
 *  - SELECT: a click through the tool selector's default-armed select tool
 *    selects a face (selection + highlight settle), byte-identical highlight
 *    discipline from Phase 12 still holds;
 *  - MEASURE: two picks complete the tool; the completion surface carries a
 *    canonical-millimetre dimensional value and the readout renders the
 *    distance WITH its unit;
 *  - TRANSLATE: a drag emits ONE atomic transaction (three `parameter.set`
 *    commands, canonical mm) into `data-command-log`, the fixture re-derives
 *    the render state from the document (the executor stand-in), the plate
 *    VISIBLY moves, and the volume readout is INVARIANT (rigid motion) with
 *    the settle protocol re-stamped;
 *  - ROTATE: a drag emits the angle `parameter.set` (canonical rad) while —
 *    honestly — NO pixel moves: every kernel declares
 *    `transformRotation: false`, so the command lives in the document and
 *    its history only;
 *  - CANCELLATION: Escape mid-drag cancels cleanly — phase `cancelled`,
 *    empty command log, byte-identical canvas (the pinned atomicity rule);
 *  - SINGLE ACTIVE TOOL: switching tools mid-gesture discards the in-flight
 *    state and arms the new tool, still with nothing emitted.
 *
 * Point derivation follows the Phase 12 rule: every clicked point comes from
 * the fixture's face-anchor surface, never a guessed pixel. Screenshot
 * evidence is saved for each interaction state (byte-stable comparisons);
 * video of the principal flow rides the config's `video: "on"`.
 */

const TOP_NORMAL = [0, 0, 1] as const;
const FRONT_WALL_NORMAL = [0, -1, 0] as const;
const RIGHT_WALL_NORMAL = [1, 0, 0] as const;

interface CommandLogEntry {
  readonly formatVersion: number;
  readonly commands: readonly {
    readonly type: string;
    readonly id: string;
    readonly value: {
      readonly dimension: string;
      readonly unit: string;
      readonly value: number;
    };
  }[];
}

/** Waits for the tool to reach a given phase (and the surface to say so). */
async function waitForToolPhase(
  page: Page,
  phase: string,
): Promise<void> {
  await page.waitForFunction((expected) => {
    const root = document.getElementById("render-root");
    return root !== null && root.getAttribute("data-tool-phase") === expected;
  }, phase);
}

async function canvasScreenshot(page: Page): Promise<Buffer> {
  return page.locator("#render-viewport canvas").screenshot();
}

test("the select tool drives selection through the tool system", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const surface = await readToolSurface(page);
  // Boot configuration: exactly one active tool, the select tool.
  expect(surface.toolId).toBe("select");
  expect(surface.phase).toBe("active");
  expect(surface.toolState).toEqual({ stage: "ready" });
  expect(surface.commandLog).toEqual([]);

  const anchors = await readFaceAnchors(page);
  const revision = await readSelectionRegeneration(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);

  await clickFaceAnchor(page, top.anchor);
  await waitForSelectionFrame(
    page,
    `face|body_plate|${String(revision)}|${String(top.faceIndex)}`,
  );
  const selected = await readSelection(page);
  expect(selected).toEqual([
    {
      kind: "face",
      bodyId: "body_plate",
      regeneration: revision,
      faceIndex: top.faceIndex,
    },
  ]);
  // The tool system itself is unchanged by a selection op: still active, no
  // commands (selection ops are session-data operations, not transactions).
  const afterSelect = await readToolSurface(page);
  expect(afterSelect.phase).toBe("active");
  expect(afterSelect.commandLog).toEqual([]);

  // The highlight is real pixel evidence (byte-stable discipline).
  const canvas = await canvasScreenshot(page);
  await saveArtifact("tool-select-highlight.png", canvas);
  expect(canvas.length).toBeGreaterThan(0);
});

test("the measure tool completes with a dimensional distance and unit readout", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const front = faceWithNormal(anchors, FRONT_WALL_NORMAL);

  await activateTool(page, "measure");
  await clickFaceAnchor(page, top.anchor);
  let surface = await readToolSurface(page);
  expect(surface.toolState).toEqual({
    stage: "awaiting-second",
    from: expect.anything(),
  });
  expect(surface.commandLog).toEqual([]);

  await clickFaceAnchor(page, front.anchor);
  await waitForToolPhase(page, "completed");
  surface = await readToolSurface(page);
  const completion = surface.completion as {
    readonly toolId: string;
    readonly detail: {
      readonly kind: string;
      readonly distance: {
        readonly dimension: string;
        readonly unit: string;
        readonly value: number;
      };
      readonly from: readonly number[];
      readonly to: readonly number[];
    };
  };
  expect(completion.toolId).toBe("measure");
  expect(completion.detail.kind).toBe("measurement");
  expect(completion.detail.distance.dimension).toBe("length");
  // The distance is a Phase 4 dimensional value in the canonical unit.
  expect(completion.detail.distance.unit).toBe("mm");
  expect(completion.detail.distance.value).toBeGreaterThan(0);
  expect(completion.detail.from).not.toEqual(completion.detail.to);
  // The readout renders the distance WITH its unit, consistent with the data.
  expect(surface.measure).toBe(
    `${completion.detail.distance.value.toFixed(3)} mm`,
  );
  await expect(page.locator("#measure-readout")).toHaveText(surface.measure);
  // Full-page evidence: the readout lives in the fixture's panel.
  await saveArtifact("tool-measure-readout-fullpage.png", await page.screenshot());
});

test("the translate tool commits one atomic transaction and visibly moves the plate", async ({
  page,
}) => {
  await page.goto("/render");
  const volume = await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const front = faceWithNormal(anchors, FRONT_WALL_NORMAL);
  const before = await canvasScreenshot(page);
  const framesBefore = await readRenderedFrames(page);

  await activateTool(page, "translate");
  // Front anchor → top anchor: the drag LIFTS the plate into full view
  // (top→front would sink it, pushing the wall anchors off the canvas).
  await dragFaceAnchorToFaceAnchor(page, front.anchor, top.anchor);
  await waitForToolPhase(page, "completed");
  const surface = await readToolSurface(page);

  // Exactly ONE transaction, three canonical-millimetre parameter.sets on
  // the translate feature's x/y/z parameters.
  const log = surface.commandLog as CommandLogEntry[];
  expect(log).toHaveLength(1);
  const transaction = log[0];
  expect(transaction === undefined).toBe(false);
  if (transaction === undefined) throw new Error("unreachable: log checked above");
  expect(transaction.commands.map((command) => command.type)).toEqual([
    "parameter.set",
    "parameter.set",
    "parameter.set",
  ]);
  expect(transaction.commands.map((command) => command.id)).toEqual([
    "param_translate_x",
    "param_translate_y",
    "param_translate_z",
  ]);
  for (const command of transaction.commands) {
    expect(command.value.dimension).toBe("length");
    expect(command.value.unit).toBe("mm");
    expect(Number.isFinite(command.value.value)).toBe(true);
  }
  // The applied offset equals the committed components and is non-degenerate.
  const [tx, ty, tz] = surface.translate as readonly number[];
  expect([tx, ty, tz]).toEqual(transaction.commands.map((command) => command.value.value));
  expect(tx !== 0 || ty !== 0 || tz !== 0).toBe(true);

  // The executor stand-in re-rendered the moved plate: a NEW frame.
  await waitForRenderedFrames(page, framesBefore + 1);
  await waitForSettledScene(page);
  const after = await canvasScreenshot(page);
  expect(
    after.equals(before),
    `translate must move pixels (before ${sha256(before)} vs after ${sha256(after)})`,
  ).toBe(false);
  await saveArtifact("tool-translate-moved.png", after);

  // Rigid motion is volume-invariant: the settled volume is unchanged.
  await expect(page.locator("#render-volume")).toHaveText(volume);
});

test("the rotate tool commits the angle command and honestly moves nothing", async ({
  page,
}) => {
  await page.goto("/render");
  const volume = await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  // The gesture must start OFF the body's center axis: the rotation radial
  // is measured from the body's bounds center, and the top-face anchor sits
  // on it (a degenerate radial the tool refuses). Start on the right wall.
  const right = faceWithNormal(anchors, RIGHT_WALL_NORMAL);
  const front = faceWithNormal(anchors, FRONT_WALL_NORMAL);
  const before = await canvasScreenshot(page);
  const framesBefore = await readRenderedFrames(page);

  await activateTool(page, "rotate");
  await dragFaceAnchorToFaceAnchor(page, right.anchor, front.anchor);
  await waitForToolPhase(page, "completed");
  const surface = await readToolSurface(page);

  // ONE transaction, ONE parameter.set, canonical radians.
  const log = surface.commandLog as CommandLogEntry[];
  expect(log).toHaveLength(1);
  const transaction = log[0];
  expect(transaction === undefined).toBe(false);
  if (transaction === undefined) throw new Error("unreachable: log checked above");
  const [command] = transaction.commands;
  expect(command?.type).toBe("parameter.set");
  expect(command?.id).toBe("param_rotate_z");
  expect(command?.value.dimension).toBe("angle");
  expect(command?.value.unit).toBe("rad");
  expect(command?.value.value === 0).toBe(false);

  // The capability gate: transformRotation is false everywhere and no
  // document executor exists — no new frame, byte-identical pixels.
  expect(await readRenderedFrames(page)).toBe(framesBefore);
  expect(
    (await canvasScreenshot(page)).equals(before),
    "rotate must NOT move pixels until a kernel executes rotations",
  ).toBe(true);
  await saveArtifact("tool-rotate-scoped.png", await canvasScreenshot(page));
  await expect(page.locator("#render-volume")).toHaveText(volume);
});

test("Escape cancels a live drag and emits nothing (atomicity rule)", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const right = faceWithNormal(anchors, RIGHT_WALL_NORMAL);
  const before = await canvasScreenshot(page);

  await activateTool(page, "translate");
  // Start the drag: down on the top face, hover toward the right wall.
  const canvas = page.locator("#render-viewport canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("unreachable: box checked above");
  await page.mouse.move(box.x + top.anchor.point[0], box.y + top.anchor.point[1]);
  await page.mouse.down();
  await page.mouse.move(
    box.x + right.anchor.point[0],
    box.y + right.anchor.point[1],
    { steps: 5 },
  );
  // The in-flight vector is visible tool state and NOTHING has been issued.
  let surface = await readToolSurface(page);
  expect(
    (surface.toolState as { readonly stage: string }).stage,
  ).toBe("dragging");
  expect(surface.commandLog).toEqual([]);

  await page.keyboard.press("Escape");
  await waitForToolPhase(page, "cancelled");
  surface = await readToolSurface(page);
  expect(surface.phase).toBe("cancelled");
  expect(surface.completion).toBeNull();
  expect(surface.commandLog).toEqual([]);
  expect(surface.translate).toEqual([0, 0, 0]);
  expect(
    (await canvasScreenshot(page)).equals(before),
    "a cancelled drag must leave the scene untouched",
  ).toBe(true);

  // Re-arming after cancellation completes a full gesture: lifecycle recovers.
  await activateTool(page, "translate");
  await dragFaceAnchorToFaceAnchor(page, top.anchor, right.anchor);
  await waitForToolPhase(page, "completed");
  surface = await readToolSurface(page);
  expect(surface.commandLog).toHaveLength(1);
});

test("only one tool is active: switching mid-gesture discards the in-flight state", async ({
  page,
}) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const right = faceWithNormal(anchors, RIGHT_WALL_NORMAL);

  await activateTool(page, "translate");
  const canvas = page.locator("#render-viewport canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("unreachable: box checked above");
  await page.mouse.move(box.x + top.anchor.point[0], box.y + top.anchor.point[1]);
  await page.mouse.down();
  await page.mouse.move(
    box.x + right.anchor.point[0],
    box.y + right.anchor.point[1],
    { steps: 3 },
  );
  expect(
    (await readToolSurface(page).then((s) => s.toolState) as {
      readonly stage: string;
    }).stage,
  ).toBe("dragging");

  // Mid-drag switch: cancel + reset + activate, still nothing emitted.
  await activateTool(page, "measure");
  const surface = await readToolSurface(page);
  expect(surface.toolId).toBe("measure");
  expect(surface.phase).toBe("active");
  expect(surface.toolState).toEqual({ stage: "awaiting-first" });
  expect(surface.commandLog).toEqual([]);
  await page.mouse.up();
  // The up belongs to measure now: it anchors the FIRST measurement point...
  await expect(page.locator("#measure-readout")).toHaveText("—", {
    ignoreCase: false,
  });
  // ...and the abandoned translate gesture emitted nothing.
  expect((await readToolSurface(page)).commandLog).toEqual([]);
});

test("the principal tool flow is captured on video", async ({ page }) => {
  await page.goto("/render");
  await waitForSettledScene(page);
  const anchors = await readFaceAnchors(page);
  const revision = await readSelectionRegeneration(page);
  const top: FaceAnchor = faceWithNormal(anchors, TOP_NORMAL).anchor;
  const front: FaceAnchor = faceWithNormal(anchors, FRONT_WALL_NORMAL).anchor;
  const topIndex = faceWithNormal(anchors, TOP_NORMAL).faceIndex;

  // Select → measure → translate → rotate: the principal interaction flow.
  await clickFaceAnchor(page, top);
  await waitForSelectionFrame(
    page,
    `face|body_plate|${String(revision)}|${String(topIndex)}`,
  );
  await activateTool(page, "measure");
  await clickFaceAnchor(page, top);
  await clickFaceAnchor(page, front);
  await waitForToolPhase(page, "completed");
  await activateTool(page, "translate");
  // Front anchor → top anchor: the drag LIFTS the plate (kept well in
  // frame), so the rotate gesture that follows still finds every wall
  // anchor on the model.
  await dragFaceAnchorToFaceAnchor(page, front, top);
  await waitForToolPhase(page, "completed");
  await waitForRenderedTranslate(page);
  await waitForSettledScene(page);
  // The plate has MOVED: the anchor map is re-derived from the moved
  // projection, so the rotate gesture aims at where the walls are NOW.
  const movedAnchors = await readFaceAnchors(page);
  const movedRight = faceWithNormal(movedAnchors, RIGHT_WALL_NORMAL);
  const movedFront = faceWithNormal(movedAnchors, FRONT_WALL_NORMAL);
  await activateTool(page, "rotate");
  await dragFaceAnchorToFaceAnchor(page, movedRight.anchor, movedFront.anchor);
  await waitForToolPhase(page, "completed");

  const video = page.video();
  expect(video, "the page must be recorded").not.toBeNull();
  const path = await video?.path();
  expect(path, "a video file must be attached").toBeTruthy();
});
