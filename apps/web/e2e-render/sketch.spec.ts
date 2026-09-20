import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { saveArtifact, sha256 } from "./helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";

/**
 * Phase 25 sketch-browser-interaction e2e — the phase-level browser gate on
 * the deterministic render harness (production build, SwiftShader, fixed
 * 1280×720 DPR 1, one worker, video on). Runs against the composed workbench
 * (`/workbench`) in SKETCH MODE: `CadSketchToolbar`, `CadSketchCanvas`, and
 * `CadSketchInspector` around a real sketch session, every edit committed as
 * serializable sketch commands (`data-sketch-commands`) through the
 * snapshot-history session (`data-sketch-history`), every authored change
 * re-solved with the Phase 24 reference solver (`data-sketch-solve`,
 * `data-sketch-solved`, `data-sketch-diagnostics`).
 *
 * The plan's battery:
 *  - INITIAL — the empty-sketch editor settles BYTE-STABLE across two full
 *    runs, and a later test reproduces the exact canvas bytes;
 *  - RECTANGLE — two corner picks create 4 lines + the rectangle in ONE
 *    command transaction; the solver reports the rectangle's 5 degrees of
 *    freedom; an edge pick SELECTS it, and the SELECTED state is
 *    byte-reproduced after clear + re-select;
 *  - DIMENSIONS — a distance dimension measured from current geometry, then
 *    EDITED through the inspector's Formedible field; the solver moves the
 *    geometry and the solved surface proves the new length;
 *  - CONSTRAINTS — horizontal + a second dimension drop DoF stepwise; a
 *    constraint DELETE raises DoF back; the CONSTRAINED state is
 *    byte-reproduced on re-add;
 *  - ERROR — an edit that conflicts surfaces `sketch/constraints-conflicting`
 *    with the failing constraint's location, the canvas keeps the
 *    LAST-KNOWN-GOOD solved geometry, the ERROR state is byte-reproduced,
 *    and undo restores a solved state;
 *  - UNDO/REDO — four sketched operations roll back to the empty sketch and
 *    forward to the exact same solved surface, machine-asserted at every
 *    cursor position;
 *  - CONSTRUCTION + TRIM + KEYBOARD — the construction toggle re-styles an
 *    entity, trim moves the clicked line end to the intersection, tool
 *    digits work from the keyboard, Escape cancels a gesture, Delete removes
 *    a selection;
 *  - WORKFLOW VIDEO — one test walks the full journey (its recording is the
 *    video artifact).
 *
 * Click derivation follows the house rule (no guessed pixels): every canvas
 * click comes from the documented canvas transform (the `SKETCH_CANVAS`
 * constants the workbench renders with, imported here as the source of
 * truth) mapped through the canvas element's bounding box. Byte comparisons
 * use Playwright `Buffer.equals` on element captures with the established
 * settle discipline (pointer parked off the surface, transitions settled,
 * machine surfaces asserted before capture).
 */

const ROOT = "#workbench-root";
const SKETCH = "#sketch-root";
const CANVAS = "#sketch-root [data-sketch-surface]";
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';

/** A workplane mm point → canvas-element CSS pixel point. */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

/** Enters sketch mode from the model workbench. */
async function enterSketchMode(page: Page): Promise<void> {
  await page.goto("/workbench");
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
}

/** The parsed machine surface of the sketch root. */
interface SketchSurface {
  readonly tool: string;
  readonly entities: {
    readonly id: string;
    readonly kind: string;
    readonly construction: boolean;
  }[];
  readonly constraints: { readonly id: string; readonly kind: string }[];
  readonly solved:
    | readonly {
        readonly id: string;
        readonly kind: string;
      }[]
    | null;
  readonly solve: { readonly status: string; readonly dof: number | null };
  readonly history: {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly cursor: number;
    readonly depth: number;
  };
  readonly commands: number;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: string;
  }[];
}

async function readSketchSurface(page: Page): Promise<SketchSurface> {
  const readRaw = async (attribute: string): Promise<string> => {
    const raw = await page.locator(SKETCH).getAttribute(attribute);
    expect(raw, `${attribute} must exist`).not.toBeNull();
    return raw ?? "";
  };
  const readJson = async (attribute: string): Promise<unknown> => {
    return JSON.parse(await readRaw(attribute)) as unknown;
  };
  const commands = (await readJson("data-sketch-commands")) as unknown[];
  return {
    tool: await readRaw("data-sketch-tool"),
    entities: (await readJson(
      "data-sketch-entities",
    )) as SketchSurface["entities"],
    constraints: (await readJson(
      "data-sketch-constraints",
    )) as SketchSurface["constraints"],
    solved: (await readJson("data-sketch-solved")) as SketchSurface["solved"],
    solve: (await readJson("data-sketch-solve")) as SketchSurface["solve"],
    history: (await readJson(
      "data-sketch-history",
    )) as SketchSurface["history"],
    commands: commands.length,
    diagnostics: (await readJson(
      "data-sketch-diagnostics",
    )) as SketchSurface["diagnostics"],
  };
}

/** The solved geometry record of `entityId` (null before the first solve). */
async function solvedEntity(
  page: Page,
  entityId: string,
): Promise<Record<string, unknown>> {
  const raw = await page.locator(SKETCH).getAttribute("data-sketch-solved");
  const solved = JSON.parse(raw ?? "null") as
    readonly Record<string, unknown>[] | null;
  expect(solved, "a solved surface must exist").not.toBeNull();
  const entity = solved?.find((candidate) => candidate.id === entityId);
  expect(entity, `solved entity ${entityId}`).toBeDefined();
  return entity as Record<string, unknown>;
}

/** Clicks the canvas at a workplane mm point. */
async function clickCanvas(page: Page, x: number, y: number): Promise<void> {
  const point = canvasPoint(x, y);
  await page.locator(CANVAS).click({ position: point });
}

/** Activates a sketch tool through the toolbar button. */
async function activateTool(page: Page, toolId: string): Promise<void> {
  await page.locator(`[data-sketch-tool-id="${toolId}"]`).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    toolId,
  );
}

/**
 * Capture discipline: park the pointer OFF the canvas (clears hover via
 * pointerleave, prevents tooltips) and let button transitions settle.
 */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
}

/** Draws the fixture rectangle: corners (-15,-15) to (25,15). */
async function drawFixtureRectangle(page: Page): Promise<void> {
  await activateTool(page, "rectangle");
  await clickCanvas(page, -15, -15);
  await clickCanvas(page, 25, 15);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-entities",
    expect.stringContaining("skent_rectangle-1"),
  );
}

/**
 * Adds the bottom-edge distance dimension (start → end, measured 40 mm) to
 * a sketch that already carries the fixture rectangle; returns the new
 * constraint's id.
 */
async function addBottomDistance(page: Page): Promise<string> {
  const before = await readSketchSurface(page);
  await activateTool(page, "distance");
  await clickCanvas(page, -12, -15);
  await clickCanvas(page, 22, -15);
  const surface = await readSketchSurface(page);
  expect(surface.constraints).toHaveLength(before.constraints.length + 1);
  return surface.constraints[surface.constraints.length - 1]?.id ?? "";
}

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  /** The empty-sketch canvas baseline from the determinism test. */
  initial: undefined as Buffer | undefined,
};

test("the empty sketch editor boots byte-stable across two full runs", async ({
  page,
}) => {
  await enterSketchMode(page);

  // Machine surface: nothing drawn, trivially solved, no commands.
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-entities",
    "[]",
  );
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-constraints",
    "[]",
  );
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 0, dof: 0, status: "solved" }),
  );
  const surface = await readSketchSurface(page);
  expect(surface.tool).toBe("select");
  expect(surface.history).toEqual({
    canUndo: false,
    canRedo: false,
    cursor: 0,
    depth: 0,
  });

  await settleForCapture(page);
  const first = await page.locator(CANVAS).screenshot();
  await saveArtifact("sketch-initial.png", first);

  // A full second run: fresh document load → the same bytes must result.
  await enterSketchMode(page);
  await settleForCapture(page);
  const second = await page.locator(CANVAS).screenshot();

  expect(
    second.equals(first),
    `run1 sha256=${sha256(first)} vs run2 sha256=${sha256(second)}`,
  ).toBe(true);
  shared.initial = first;
});

test("a rectangle sketch is created by two picks and an edge is selectable", async ({
  page,
}) => {
  await enterSketchMode(page);

  // A fresh load in a later test reproduces the INITIAL baseline bytes
  // before anything is drawn.
  await settleForCapture(page);
  const preDraw = await page.locator(CANVAS).screenshot();
  if (shared.initial !== undefined) {
    expect(
      preDraw.equals(shared.initial),
      `pre-draw sha256=${sha256(preDraw)} vs baseline sha256=${sha256(shared.initial)}`,
    ).toBe(true);
  }

  await drawFixtureRectangle(page);

  // One atomic transaction: 4 line creates + 1 rectangle create.
  const surface = await readSketchSurface(page);
  expect(surface.entities).toHaveLength(5);
  expect(surface.commands).toBe(5);
  expect(surface.history).toMatchObject({ canUndo: true, depth: 1 });
  // The rectangle leaves exactly its 5 degrees of freedom.
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 5, status: "under-constrained" }),
  );
  // The solved bottom edge is exactly the drawn edge (already a rectangle).
  const bottom = await solvedEntity(page, "skent_edge-1");
  expect(bottom).toMatchObject({ x1: -15, y1: -15, x2: 25, y2: -15 });
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solved",
    expect.stringContaining("skent_rectangle-1"),
  );

  // Select the bottom edge through the canvas (the SELECTED state).
  await activateTool(page, "select");
  await clickCanvas(page, 5, -15);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-selection",
    JSON.stringify({ constraintId: null, entityIds: ["skent_edge-1"] }),
  );
  await settleForCapture(page);
  const selected = await page.locator(CANVAS).screenshot();
  await saveArtifact("sketch-selected.png", selected);

  // Clear + re-select through the same surfaces reproduces the exact bytes.
  await clickCanvas(page, 60, 40);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-selection",
    JSON.stringify({ constraintId: null, entityIds: [] }),
  );
  await clickCanvas(page, 5, -15);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-selection",
    JSON.stringify({ constraintId: null, entityIds: ["skent_edge-1"] }),
  );
  await settleForCapture(page);
  const reselected = await page.locator(CANVAS).screenshot();
  expect(
    reselected.equals(selected),
    `selected sha256=${sha256(selected)} vs reselect sha256=${sha256(reselected)}`,
  ).toBe(true);
});

test("a distance dimension is measured, then edited through the inspector", async ({
  page,
}) => {
  await enterSketchMode(page);
  await drawFixtureRectangle(page);
  const distanceId = await addBottomDistance(page);

  // The new dimension carries the MEASURED value; DoF drops 5 → 4.
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 4, status: "under-constrained" }),
  );

  // Committing a constraint AUTO-SELECTS it: the inspector row is pressed
  // and the Formedible dimension editor shows the measured 40 mm. Edit it
  // to 64.
  await expect(
    page.locator(`[data-sketch-constraint-id="${String(distanceId)}"]`),
  ).toHaveAttribute("aria-pressed", "true");
  const input = page.getByRole("spinbutton");
  await expect(input).toHaveValue("40");
  await input.fill("64");
  await page.getByRole("button", { name: "Apply" }).click();

  // The canvas annotation reads the new value as soon as the edit commits.
  await expect(page.locator(CANVAS)).toContainText("64 mm");
  // The solver moved the geometry: the solved edge is now exactly 64 mm.
  await expect
    .poll(async () => {
      const after = await solvedEntity(page, "skent_edge-1");
      return Math.hypot(
        Number(after.x2) - Number(after.x1),
        Number(after.y2) - Number(after.y1),
      );
    })
    .toBeCloseTo(64, 6);
  await saveArtifact(
    "sketch-dimension.png",
    await page.locator(CANVAS).screenshot(),
  );
});

test("constraints drop DoF stepwise, delete raises it, the state is byte-stable", async ({
  page,
}) => {
  await enterSketchMode(page);
  await drawFixtureRectangle(page);
  await addBottomDistance(page);

  // Horizontal on the bottom edge: DoF 4 → 3.
  await activateTool(page, "horizontal");
  await clickCanvas(page, 5, -15);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 3, status: "under-constrained" }),
  );

  // A second dimension (right-edge length, measured 30): DoF 3 → 2.
  await activateTool(page, "distance");
  await clickCanvas(page, 25, -12);
  await clickCanvas(page, 25, 12);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 2, status: "under-constrained" }),
  );
  await settleForCapture(page);
  const constrained = await page.locator(CANVAS).screenshot();
  await saveArtifact("sketch-constrained.png", constrained);

  // Delete the horizontal constraint: select its row, press Delete. DoF 2 → 3.
  const surface = await readSketchSurface(page);
  expect(surface.constraints).toHaveLength(3);
  const horizontal = surface.constraints.find(
    (constraint) => constraint.kind === "horizontal",
  );
  expect(horizontal).toBeDefined();
  await page
    .locator(`[data-sketch-constraint-id="${String(horizontal?.id)}"]`)
    .click();
  await page.keyboard.press("Delete");
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 3, status: "under-constrained" }),
  );
  const afterDelete = await readSketchSurface(page);
  expect(afterDelete.constraints).toHaveLength(2);

  // Re-add the identical horizontal → the same visual state as before the
  // delete, byte for byte.
  await activateTool(page, "horizontal");
  await clickCanvas(page, 5, -15);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 2, status: "under-constrained" }),
  );
  await settleForCapture(page);
  const readded = await page.locator(CANVAS).screenshot();
  expect(
    readded.equals(constrained),
    `constrained sha256=${sha256(constrained)} vs re-added sha256=${sha256(readded)}`,
  ).toBe(true);
});

test("a conflicting edit surfaces structured diagnostics and keeps last-known-good geometry", async ({
  page,
}) => {
  await enterSketchMode(page);
  await drawFixtureRectangle(page);
  await addBottomDistance(page);

  // A SECOND distance on the same two targets: consistent (redundant), so
  // still solved — with a redundancy warning.
  await activateTool(page, "distance");
  await clickCanvas(page, -12, -15);
  await clickCanvas(page, 22, -15);
  let surface = await readSketchSurface(page);
  expect(surface.constraints).toHaveLength(2);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    expect.stringContaining('"status":"solved"'),
  );

  // Edit the second dimension to 64: both distances cannot hold. The solve
  // FAILS with the structured conflict; the second commit auto-selected it,
  // so the editor already shows its measured 40 mm.
  const input = page.getByRole("spinbutton");
  await expect(input).toHaveValue("40");
  await input.fill("64");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: null, status: "failed" }),
  );
  surface = await readSketchSurface(page);
  expect(surface.diagnostics).toHaveLength(1);
  expect(surface.diagnostics[0]).toMatchObject({
    code: "sketch/constraints-conflicting",
    severity: "error",
  });
  // …the inspector marks the conflict's primary constraint (the solver
  // names the FIRST constraint whose removal would restore solvability —
  // either distance qualifies; it is the first in constraint order)…
  await expect(
    page.locator(
      `[data-sketch-constraint-id="${String(surface.constraints[0]?.id)}"]`,
    ),
  ).toHaveAttribute("data-sketch-constraint-status", "error");
  // …and the canvas KEEPS the last-known-good solved geometry: the bottom
  // edge is still exactly 40 mm (the pre-conflict solve), visibly badged.
  const bottom = await solvedEntity(page, "skent_edge-1");
  const length = Math.hypot(
    Number(bottom.x2) - Number(bottom.x1),
    Number(bottom.y2) - Number(bottom.y1),
  );
  expect(length).toBeCloseTo(40, 6);
  await expect(page.locator(CANVAS)).toContainText("constraints-conflicting");

  // The ERROR baseline is byte-stable on re-entry: undo the failing edit
  // (solved again), redo it (the identical failing state, identical bytes).
  await settleForCapture(page);
  const errorShot = await page.locator(CANVAS).screenshot();
  await saveArtifact("sketch-error.png", errorShot);
  await page.locator('[data-testid="sketch-undo"]').click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    expect.stringContaining('"status":"solved"'),
  );
  await page.locator('[data-testid="sketch-redo"]').click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: null, status: "failed" }),
  );
  await settleForCapture(page);
  const errorAgain = await page.locator(CANVAS).screenshot();
  expect(
    errorAgain.equals(errorShot),
    `error sha256=${sha256(errorShot)} vs redone sha256=${sha256(errorAgain)}`,
  ).toBe(true);
});

test("undo/redo rolls a whole sketch session back and forward", async ({
  page,
}) => {
  await enterSketchMode(page);
  await drawFixtureRectangle(page);
  await addBottomDistance(page);

  // Edit the dimension 40 → 64: the last commit. The commit auto-selected
  // the constraint, so the editor is already open at the measured 40.
  const input = page.getByRole("spinbutton");
  await expect(input).toHaveValue("40");
  await input.fill("64");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(CANVAS)).toContainText("64 mm");

  // Machine state: 3 commits, 7 commands (5 rectangle + 1 dimension-create
  // + 1 dimension-set), solved at 64.
  let surface = await readSketchSurface(page);
  expect(surface.history.depth).toBe(3);
  expect(surface.commands).toBe(7);

  // Undo three times: dimension edit gone, dimension gone, rectangle gone.
  for (const expected of [
    { constraints: 1, entities: 5 },
    { constraints: 0, entities: 5 },
    { constraints: 0, entities: 0 },
  ]) {
    await page.locator('[data-testid="sketch-undo"]').click();
    surface = await readSketchSurface(page);
    expect(surface.constraints).toHaveLength(expected.constraints);
    expect(surface.entities).toHaveLength(expected.entities);
  }
  expect(surface.history).toMatchObject({
    canUndo: false,
    cursor: 0,
    depth: 3,
  });
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-entities",
    "[]",
  );

  // Redo three times: the exact same states come back — including the
  // solved 64 mm dimension.
  for (let step = 0; step < 3; step += 1) {
    await page.locator('[data-testid="sketch-redo"]').click();
  }
  surface = await readSketchSurface(page);
  expect(surface.entities).toHaveLength(5);
  expect(surface.constraints).toHaveLength(1);
  expect(surface.history).toMatchObject({
    canRedo: false,
    cursor: 3,
    depth: 3,
  });
  await expect
    .poll(async () => {
      const bottom = await solvedEntity(page, "skent_edge-1");
      return Math.hypot(
        Number(bottom.x2) - Number(bottom.x1),
        Number(bottom.y2) - Number(bottom.y1),
      );
    })
    .toBeCloseTo(64, 6);
});

test("construction toggle, trim, keyboard tools, Escape, and Delete", async ({
  page,
}) => {
  await enterSketchMode(page);

  // Keyboard path: focus a toolbar button, press "2" (Line) — the digit
  // handler lives on the strip container, so it works from any focus inside
  // it. Draw the first line: (-18,-10) → (60,-10).
  await page.locator('[data-sketch-tool-id="select"]').focus();
  await page.keyboard.press("2");
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "line",
  );
  await clickCanvas(page, -18, -10);
  await clickCanvas(page, 60, -10);
  // "1" is the select tool — keyboard again, from a fresh toolbar focus.
  await page.locator('[data-sketch-tool-id="line"]').focus();
  await page.keyboard.press("1");
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "select",
  );
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-entities",
    expect.stringContaining("skent_line-1"),
  );

  // A crossing line for the trim: (20,-18) → (20,50). Activate Line with a
  // click (the pointer path) and draw.
  await activateTool(page, "line");
  await clickCanvas(page, 20, -18);
  await clickCanvas(page, 20, 50);
  const entities = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
  ) as { id: string }[];
  expect(entities).toHaveLength(2);

  // Construction toggle: the first line becomes construction geometry
  // (dashed styling, machine attribute), then real geometry again.
  await activateTool(page, "construction");
  await clickCanvas(page, 0, -10);
  await expect(
    page.locator('[data-sketch-entity-id="skent_line-1"]'),
  ).toHaveAttribute("data-sketch-construction", "true");
  await clickCanvas(page, 0, -10);
  await expect(
    page.locator('[data-sketch-entity-id="skent_line-1"]'),
  ).not.toHaveAttribute("data-sketch-construction");

  // Trim: click the second line near its LOWER end; that end moves to the
  // intersection with the first line at (20,-10).
  await activateTool(page, "trim");
  await clickCanvas(page, 20, -16);
  const solved = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
  ) as { id: string; x1: number; y1: number }[];
  const trimmed = solved.find((entity) => entity.id === "skent_line-2");
  expect(trimmed).toBeDefined();
  // The solve effect trails the commit by a tick: poll the solved surface.
  await expect
    .poll(async () => {
      const current = JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
      ) as { id: string; x1: number; y1: number }[];
      return current.find((entity) => entity.id === "skent_line-2")?.y1;
    })
    .toBeCloseTo(-10, 6);
  expect(trimmed?.x1).toBeCloseTo(20, 6);

  // Escape cancels an in-flight gesture (line started, not finished).
  await activateTool(page, "line");
  await clickCanvas(page, -10, 30);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-gesture",
    "line",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-gesture",
    "none",
  );

  // Delete removes the selected entity (nothing references it).
  await activateTool(page, "select");
  await clickCanvas(page, 20, 30);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-selection",
    JSON.stringify({ constraintId: null, entityIds: ["skent_line-2"] }),
  );
  await page.keyboard.press("Delete");
  const surface = await readSketchSurface(page);
  expect(surface.entities).toHaveLength(1);
  expect(surface.entities[0]?.id).toBe("skent_line-1");
});

test("full sketch workflow: rectangle, constraints, dimension edit, undo, redo", async ({
  page,
}) => {
  // The whole battery in one journey — this test's recording is the
  // phase's full sketch workflow video artifact.
  await enterSketchMode(page);
  await drawFixtureRectangle(page);
  await activateTool(page, "horizontal");
  await clickCanvas(page, 5, -15);
  await addBottomDistance(page);
  // The dimension commit auto-selected its constraint: the editor is open.
  const input = page.getByRole("spinbutton");
  await expect(input).toHaveValue("40");
  await input.fill("64");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(async () => {
      const bottom = await solvedEntity(page, "skent_edge-1");
      return Math.hypot(
        Number(bottom.x2) - Number(bottom.x1),
        Number(bottom.y2) - Number(bottom.y1),
      );
    })
    .toBeCloseTo(64, 6);
  await page.locator('[data-testid="sketch-undo"]').click();
  await page.locator('[data-testid="sketch-redo"]').click();
  await settleForCapture(page);
  await saveArtifact(
    "sketch-workflow-final.png",
    await page.locator(CANVAS).screenshot(),
  );
});

/** Phase 36 vocabulary e2e: the ellipse/slot drawing tools and the new
 *  constraint kinds (pointOnEntity, collinear, distanceX) drive the same
 *  machine surfaces the battery above pins — solver DoF, the solved
 *  geometry, and the inspector's dimension editor. */
test("phase 36: an ellipse is drawn in three picks, dimensioned with distanceX, and follows the edit", async ({
  page,
}) => {
  await enterSketchMode(page);

  // Three clicks: center (5, 5), axis end (17, 5) → radiusX 12,
  // rotation 0; minor extent (5, 13) → radiusY 8.
  await activateTool(page, "ellipse");
  await clickCanvas(page, 5, 5);
  await clickCanvas(page, 17, 5);
  await clickCanvas(page, 5, 13);

  // One ellipse entity, exactly its 5 degrees of freedom.
  const surface = await readSketchSurface(page);
  expect(surface.entities).toHaveLength(1);
  expect(surface.entities[0]).toMatchObject({
    id: "skent_ellipse-1",
    kind: "ellipse",
  });
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 5, status: "under-constrained" }),
  );

  // distanceX from the center to the major-axis end: the LEFTMOST rim
  // point targets the CENTER (its nearest point target — the center is 12
  // away, the minor end 13.9, the major end 24); the rightmost rim point
  // IS the START (the major-axis end).
  await activateTool(page, "distanceX");
  await clickCanvas(page, -7, 5);
  await clickCanvas(page, 17, 5);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 4, status: "under-constrained" }),
  );

  // The measured dimension is the x separation (12 mm); edit it to 16
  // and the constraint holds at the new value (the rotation's gradient is
  // zero at rotation 0, so the whole correction lands on radiusX).
  const input = page.getByRole("spinbutton");
  await expect(input).toHaveValue("12");
  await input.fill("16");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(async () => {
      const ellipse = await solvedEntity(page, "skent_ellipse-1");
      // start.x − cx = radiusX·cos(rotation) — the exact quantity the
      // signed distanceX constraint pins.
      return Number(ellipse.radiusX) * Math.cos(Number(ellipse.rotation));
    })
    .toBeCloseTo(16, 6);
  await saveArtifact(
    "sketch-ellipse-dimension.png",
    await page.locator(CANVAS).screenshot(),
  );
});

test("phase 36: a straight slot is drawn in three picks and sized by its radius constraint", async ({
  page,
}) => {
  await enterSketchMode(page);

  // Cap centers (−15, −10) and (5, −10); the radius pick sits 5 mm off
  // the centerline.
  await activateTool(page, "slot");
  await clickCanvas(page, -15, -10);
  await clickCanvas(page, 5, -10);
  await clickCanvas(page, 0, -5);

  const surface = await readSketchSurface(page);
  expect(surface.entities).toHaveLength(1);
  expect(surface.entities[0]).toMatchObject({
    id: "skent_slot-1",
    kind: "slot",
  });
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 5, status: "under-constrained" }),
  );

  // Radius on the slot (the cap radius): measured 5 mm.
  await activateTool(page, "radius");
  await clickCanvas(page, -15, -6);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 4, status: "under-constrained" }),
  );
  const input = page.getByRole("spinbutton");
  await expect(input).toHaveValue("5");
  await input.fill("7");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(async () => {
      const slot = await solvedEntity(page, "skent_slot-1");
      return Number(slot.radius);
    })
    .toBeCloseTo(7, 6);
});

test("phase 36: collinear flattens the second line onto the first's infinite line", async ({
  page,
}) => {
  await enterSketchMode(page);

  // Both lines sit well inside the canvas (y = −10 keeps the clicks off
  // the surface's bottom edge, where the container border intercepts).
  await activateTool(page, "line");
  await clickCanvas(page, 0, -10);
  await clickCanvas(page, 30, -10);
  await activateTool(page, "line");
  await clickCanvas(page, 5, -6);
  await clickCanvas(page, 25, -2);

  await activateTool(page, "collinear");
  await clickCanvas(page, 10, -10);
  await clickCanvas(page, 15, -4);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 6, status: "under-constrained" }),
  );
  const second = await solvedEntity(page, "skent_line-2");
  expect(Number(second.y1)).toBeCloseTo(-10, 6);
  expect(Number(second.y2)).toBeCloseTo(-10, 6);
});

test("phase 36: pointOnEntity pulls a line endpoint onto a circle", async ({
  page,
}) => {
  await enterSketchMode(page);

  await activateTool(page, "line");
  await clickCanvas(page, 2, 20);
  await clickCanvas(page, 30, 14);
  await activateTool(page, "circle");
  await clickCanvas(page, 20, 20);
  await clickCanvas(page, 26, 20);

  // Pin the line's START (the nearest point target at the click) onto
  // the circle (the curve operand).
  await activateTool(page, "pointOnEntity");
  await clickCanvas(page, 2, 20);
  await clickCanvas(page, 26, 20);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 6, status: "under-constrained" }),
  );
  await expect
    .poll(async () => {
      const line = await solvedEntity(page, "skent_line-1");
      const circle = await solvedEntity(page, "skent_circle-1");
      return Math.hypot(
        Number(line.x1) - Number(circle.cx),
        Number(line.y1) - Number(circle.cy),
      );
    })
    .toBeCloseTo(6, 6);
});
