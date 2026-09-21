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

/** Phase 37 e2e: the spline constraint closure — anywhere line↔spline
 *  tangency, the angle against a spline's end tangent, and pointOnEntity on
 *  the composite boundary entities (polygon, straight slot). The same
 *  machine surfaces the battery above pins: solver DoF, the solved geometry,
 *  and the inspector's dimension editor. */

/** The spline points of a solved spline entity, as workplane mm pairs. */
async function solvedSplinePoints(
  page: Page,
  entityId: string,
): Promise<{ x: number; y: number }[]> {
  const entity = await solvedEntity(page, entityId);
  const points = entity.points as { x: number; y: number }[] | undefined;
  expect(points, `solved spline ${entityId} points`).toBeDefined();
  return points ?? [];
}

test("phase 37: tangent line↔spline solves with one degree of freedom removed", async ({
  page,
}) => {
  await enterSketchMode(page);

  // The arch: control picks (−12,−10) (−9,−2) (−3,−2) (0,−10) — apex
  // C(1/2) = (−6,−4).
  await activateTool(page, "spline");
  await clickCanvas(page, -12, -10);
  await clickCanvas(page, -9, -2);
  await clickCanvas(page, -3, -2);
  await clickCanvas(page, 0, -10);
  // A horizontal line ABOVE the apex (2 mm away — not tangent yet).
  await activateTool(page, "line");
  await clickCanvas(page, -12, -2);
  await clickCanvas(page, 0, -2);

  // Both entities bare: 8 + 4 = 12 dof.
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 12, status: "under-constrained" }),
  );

  // Tangency anywhere on the curve: pick the line, then the curve at its
  // apex. ONE row — the sliding contact is eliminated, not added.
  await activateTool(page, "tangent");
  await clickCanvas(page, -6, -2);
  await clickCanvas(page, -6, -4);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 11, status: "under-constrained" }),
  );

  // The solved system is tangent: some stationary contact (or a chain end)
  // sits ON the solved line with zero residual — the same stationary-root
  // check the unit suite pins, computed from the solved machine surface.
  await expect
    .poll(async () => {
      const [points, line] = await Promise.all([
        solvedSplinePoints(page, "skent_spline-1"),
        solvedEntity(page, "skent_line-1"),
      ]);
      const [p0, p1, p2, p3] = points;
      if (!p0 || !p1 || !p2 || !p3) return Number.NaN;
      const y1 = Number(line.y1);
      const y2 = Number(line.y2);
      // Signed distance controls against the (possibly tilted) line.
      const dx = Number(line.x2) - Number(line.x1);
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      const s = (p: { x: number; y: number }): number =>
        (dx * (p.y - y1) - dy * (p.x - Number(line.x1))) / length;
      const controls = [p0, p1, p2, p3].map(s);
      const q = [0, 1, 2].map(
        (j) => 3 * ((controls[j + 1] ?? 0) - (controls[j] ?? 0)),
      );
      const a = (q[0] ?? 0) - 2 * (q[1] ?? 0) + (q[2] ?? 0);
      const b = 2 * ((q[1] ?? 0) - (q[0] ?? 0));
      const c = q[0] ?? 0;
      const candidates = [controls[0] ?? 0, controls[3] ?? 0];
      const discriminant = b * b - 4 * a * c;
      if (discriminant > 0) {
        const root = Math.sqrt(discriminant);
        for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
          if (t > 0 && t < 1) {
            const u = 1 - t;
            candidates.push(
              u * u * u * (controls[0] ?? 0) +
                3 * u * u * t * (controls[1] ?? 0) +
                3 * u * t * t * (controls[2] ?? 0) +
                t * t * t * (controls[3] ?? 0),
            );
          }
        }
      }
      return Math.min(...candidates.map((value) => Math.abs(value)));
    })
    .toBeLessThan(1e-6);
});

test("phase 37: an angle between a line and a spline's end tangent is measured and edited", async ({
  page,
}) => {
  await enterSketchMode(page);

  // Start tangent P1 − P0 = (3, 6) (63.4349° above x); a horizontal line.
  await activateTool(page, "spline");
  await clickCanvas(page, 2, -10);
  await clickCanvas(page, 5, -4);
  await clickCanvas(page, 11, -4);
  await clickCanvas(page, 14, -10);
  await activateTool(page, "line");
  await clickCanvas(page, 24, -10);
  await clickCanvas(page, 34, -10);

  // The angle tool measures line × start tangent: 63.435°, committing at
  // arity (the pick near the spline's start addresses at = "start").
  await activateTool(page, "angle");
  await clickCanvas(page, 29, -10);
  await clickCanvas(page, 2.4, -9.2);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 11, status: "under-constrained" }),
  );
  const input = page.getByRole("spinbutton");
  await expect(input).toHaveValue("63.435");

  // Edit to 90°: the solved line direction and the solved start tangent
  // become perpendicular.
  await input.fill("90");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(async () => {
      const [points, line] = await Promise.all([
        solvedSplinePoints(page, "skent_spline-1"),
        solvedEntity(page, "skent_line-1"),
      ]);
      const p0 = points[0];
      const p1 = points[1];
      if (!p0 || !p1) return Number.NaN;
      const tx = p1.x - p0.x;
      const ty = p1.y - p0.y;
      const dx = Number(line.x2) - Number(line.x1);
      const dy = Number(line.y2) - Number(line.y1);
      const dot = dx * tx + dy * ty;
      return dot / (Math.hypot(dx, dy) * Math.hypot(tx, ty));
    })
    .toBeCloseTo(0, 6);
});

test("phase 37: pointOnEntity pulls a line endpoint onto a polygon and a slot boundary", async ({
  page,
}) => {
  await enterSketchMode(page);

  // A hexagon (center (8,8), vertex (14,8) → radius 6) and a line whose
  // start sits outside it.
  await activateTool(page, "polygon");
  await clickCanvas(page, 8, 8);
  await clickCanvas(page, 14, 8);
  await activateTool(page, "line");
  await clickCanvas(page, 24, 12);
  await clickCanvas(page, 34, 12);

  // Pin the line's START (the nearest point target at the click) onto the
  // polygon's boundary (the pick lands on vertex 0 of the hexagon).
  await activateTool(page, "pointOnEntity");
  await clickCanvas(page, 24, 12);
  await clickCanvas(page, 14, 8);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 7, status: "under-constrained" }),
  );

  // The solved start sits ON the solved hexagon's perimeter: the min
  // distance over the six edges is zero.
  await expect
    .poll(async () => {
      const [polygon, line] = await Promise.all([
        solvedEntity(page, "skent_polygon-1"),
        solvedEntity(page, "skent_line-1"),
      ]);
      const px = Number(line.x1);
      const py = Number(line.y1);
      const effective =
        polygon.fit === "inscribed"
          ? Number(polygon.radius)
          : Number(polygon.radius) / Math.cos(Math.PI / Number(polygon.sides));
      let min = Number.POSITIVE_INFINITY;
      const sides = Number(polygon.sides);
      for (let k = 0; k < sides; k += 1) {
        const thetaOf = (index: number): [number, number] => [
          Number(polygon.cx) +
            effective *
              Math.cos(
                Number(polygon.rotation) + (Math.PI * 2 * index) / sides,
              ),
          Number(polygon.cy) +
            effective *
              Math.sin(
                Number(polygon.rotation) + (Math.PI * 2 * index) / sides,
              ),
        ];
        const [ax, ay] = thetaOf(k);
        const [bx, by] = thetaOf(k + 1);
        const dx = bx - ax;
        const dy = by - ay;
        const u = Math.max(
          0,
          Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)),
        );
        min = Math.min(min, Math.hypot(ax + u * dx - px, ay + u * dy - py));
      }
      return min;
    })
    .toBeLessThan(1e-6);

  // A straight slot (cap centers (−14,6) → (−4,6), radius 4) and a line
  // whose start sits beyond the slot's left cap. The sketch now carries
  // polygon + line + slot + line = 17 free parameters, 2 constraints.
  await activateTool(page, "slot");
  await clickCanvas(page, -14, 6);
  await clickCanvas(page, -4, 6);
  await clickCanvas(page, -9, 10);
  await activateTool(page, "line");
  await clickCanvas(page, -18, 14);
  await clickCanvas(page, -10, 14);

  // Pin the second line's start onto the slot boundary (the pick lands on
  // the top edge, away from the line).
  await activateTool(page, "pointOnEntity");
  await clickCanvas(page, -18, 14);
  await clickCanvas(page, -9, 10);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-solve",
    JSON.stringify({ diagnostics: 1, dof: 15, status: "under-constrained" }),
  );

  // The solved start sits on the slot's left cap: |‖P − c1‖ − r| = 0.
  await expect
    .poll(async () => {
      const [slot, line] = await Promise.all([
        solvedEntity(page, "skent_slot-1"),
        solvedEntity(page, "skent_line-2"),
      ]);
      const px = Number(line.x1);
      const py = Number(line.y1);
      const distance = Math.hypot(px - Number(slot.x1), py - Number(slot.y1));
      return Math.abs(distance - Number(slot.radius));
    })
    .toBeLessThan(1e-6);
});

/** The absolute page point for a workplane mm coordinate. */
async function canvasAbsolutePoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ readonly x: number; readonly y: number }> {
  const box = await page.locator(CANVAS).boundingBox();
  if (box === null) throw new Error("the canvas must have a bounding box");
  return {
    x: box.x + canvasPoint(x, y).x,
    y: box.y + canvasPoint(x, y).y,
  };
}

/** Pointer drag across the canvas: press, two moves, release. */
async function dragOnCanvas(
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<void> {
  const a = await canvasAbsolutePoint(page, from.x, from.y);
  const b = await canvasAbsolutePoint(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await page.mouse.move(b.x, b.y);
  await page.mouse.up();
}

/** The parsed per-entity dof machine surface. */
async function readEntityDof(page: Page): Promise<Record<string, number>> {
  return JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-entity-dof")) ?? "{}",
  ) as Record<string, number>;
}

test("phase 37 ops: a drag keeps a held dimension and the solver settles", async ({
  page,
}) => {
  await enterSketchMode(page);

  // A 40 mm horizontal line, then a distance dimension between its ends.
  await activateTool(page, "line");
  await clickCanvas(page, -18, -10);
  await clickCanvas(page, 22, -10);
  await activateTool(page, "distance");
  await clickCanvas(page, -18, -10);
  await clickCanvas(page, 22, -10);
  const dimensioned = await readSketchSurface(page);
  expect(dimensioned.constraints).toHaveLength(1);
  expect(dimensioned.constraints[0]?.kind).toBe("distance");

  // The dimension's drawn presentation rides the machine surface and the
  // canvas overlay carries its node.
  const dimensions = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-dimensions")) ?? "[]",
  ) as { readonly id: string; readonly kind: string; readonly text: string }[];
  expect(dimensions).toHaveLength(1);
  expect(dimensions[0]?.kind).toBe("linear");
  expect(dimensions[0]?.text).toBe("40 mm");
  await expect(
    page.locator(`[data-sketch-dimension-id="${String(dimensions[0]?.id)}"]`),
  ).toHaveCount(1);

  // Drag the line's END beyond its old position. The dimension must HOLD:
  // the settled solve satisfies the 40 mm again, with the leftover freedom
  // surfaced as under-constrained (3 dof), never failed.
  await activateTool(page, "select");
  await dragOnCanvas(page, { x: 22, y: -10 }, { x: 22, y: 14 });
  await expect
    .poll(async () => {
      const surface = await readSketchSurface(page);
      return surface.solve.status;
    })
    .toBe("under-constrained");
  await expect
    .poll(async () => {
      const end = await solvedEntity(page, "skent_line-1");
      return Math.hypot(
        Number(end.x2) - Number(end.x1),
        Number(end.y2) - Number(end.y1),
      );
    })
    .toBeCloseTo(40, 6);
  const settled = await readSketchSurface(page);
  expect(settled.solve.dof).toBe(3);
});

test("phase 37 ops: under-constrained geometry renders blue ink", async ({
  page,
}) => {
  await enterSketchMode(page);
  await activateTool(page, "line");
  await clickCanvas(page, -18, -10);
  await clickCanvas(page, 22, -10);
  // Free line: four directions, all blue by the ink convention.
  const dof = await readEntityDof(page);
  expect(dof["skent_line-1"]).toBe(4);
  await expect(
    page.locator('[data-sketch-entity-id="skent_line-1"]'),
  ).toHaveAttribute("stroke", expect.stringMatching(/sky-600/));
  // The drag ink exists for machines even when idle (absent when idle).
  await expect(page.locator(CANVAS)).not.toHaveAttribute(
    "data-sketch-dragging",
  );
});

test("phase 37 ops: offset via the keyboard path, then undo", async ({
  page,
}) => {
  await enterSketchMode(page);
  await activateTool(page, "line");
  await clickCanvas(page, -10, 0);
  await clickCanvas(page, 20, 0);

  // Keyboard path for a Phase 37 tool: "q" sits at index 10 (first Edit
  // cluster tool = offset).
  await page.locator('[data-sketch-tool-id="line"]').focus();
  await page.keyboard.press("q");
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "offset",
  );
  await clickCanvas(page, 5, 0);
  await clickCanvas(page, 5, 8);
  const surface = await readSketchSurface(page);
  expect(surface.entities).toHaveLength(2);
  await expect
    .poll(async () => {
      const solved = JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
      ) as { id: string; kind: string; y1?: number }[];
      const copy = solved.find(
        (entity) => entity.id !== "skent_line-1" && entity.kind === "line",
      );
      return copy?.y1;
    })
    .toBeCloseTo(8, 6);

  // Undo removes the offset copy as one history step.
  await page.locator('[data-testid="sketch-undo"]').click();
  const undone = await readSketchSurface(page);
  expect(undone.entities).toHaveLength(1);
});

test("phase 37 ops: offset to the NEGATIVE side puts the copy on the clicked side", async ({
  page,
}) => {
  await enterSketchMode(page);
  await activateTool(page, "line");
  await clickCanvas(page, -10, 0);
  await clickCanvas(page, 20, 0);

  // Same keyboard path as the positive-side offset, but the target click
  // sits 8 mm BELOW the line: the copy must land at y = −8, on the clicked
  // side — never mirrored to the line's left (positive) normal.
  await page.locator('[data-sketch-tool-id="line"]').focus();
  await page.keyboard.press("q");
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    "offset",
  );
  await clickCanvas(page, 5, 0);
  await clickCanvas(page, 5, -8);
  const surface = await readSketchSurface(page);
  expect(surface.entities).toHaveLength(2);
  await expect
    .poll(async () => {
      const solved = JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
      ) as { id: string; kind: string; y1?: number }[];
      const copy = solved.find(
        (entity) => entity.id !== "skent_line-1" && entity.kind === "line",
      );
      return copy?.y1;
    })
    .toBeCloseTo(-8, 6);
});

test("phase 37 ops: offset past collapse refuses and commits nothing", async ({
  page,
}) => {
  await enterSketchMode(page);
  // A r = 6 circle at (20, 20); offsetting inward PAST the center would
  // collapse the rim, so the op must decline and leave the sketch alone.
  await activateTool(page, "circle");
  await clickCanvas(page, 20, 20);
  await clickCanvas(page, 26, 20);
  const before = await readSketchSurface(page);
  expect(before.entities).toHaveLength(1);

  await activateTool(page, "offset");
  await clickCanvas(page, 26, 20); // pick the rim
  await clickCanvas(page, 20, 20); // target the center: collapse
  const after = await readSketchSurface(page);
  expect(after.entities).toHaveLength(1);
  expect(after.history.depth).toBe(before.history.depth);
  await expect(page.getByTestId("sketch-status-message")).toHaveAttribute(
    "data-sketch-status-severity",
    "error",
  );
});

test("phase 37 dimensions: distanceX draws its line along the measured x separation", async ({
  page,
}) => {
  await enterSketchMode(page);
  // A slanted line: Δx between its ends is 30, Δy is 12.
  await activateTool(page, "line");
  await clickCanvas(page, 0, 0);
  await clickCanvas(page, 30, 12);
  await activateTool(page, "distanceX");
  await clickCanvas(page, 0, 0);
  await clickCanvas(page, 30, 12);
  const dimensions = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-dimensions")) ?? "[]",
  ) as {
    readonly kind: string;
    readonly text: string;
    readonly dimensionLine: {
      readonly from: readonly [number, number];
      readonly to: readonly [number, number];
    };
  }[];
  expect(dimensions).toHaveLength(1);
  const dimension = dimensions[0];
  expect(dimension?.kind).toBe("linear");
  expect(dimension?.text).toBe("Δx 30 mm");
  // The drawn dimension line spans the x separation HORIZONTALLY (Δy of
  // the line itself is 12, so a vertical line here would be the old swap).
  const line = dimension?.dimensionLine;
  expect(line?.from[1]).toBeCloseTo(line?.to[1] ?? Number.NaN, 6);
  expect((line?.to[0] ?? 0) - (line?.from[0] ?? 0)).toBeCloseTo(30, 6);
});

test("phase 37 ops: mirror about a line, and extend to a boundary", async ({
  page,
}) => {
  await enterSketchMode(page);
  // Target line (0,0)→(20,0); axis line x=30.
  await activateTool(page, "line");
  await clickCanvas(page, 0, 0);
  await clickCanvas(page, 20, 0);
  await activateTool(page, "line");
  await clickCanvas(page, 30, -15);
  await clickCanvas(page, 30, 15);

  await activateTool(page, "mirror");
  await clickCanvas(page, 30, 0);
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-gesture",
    "mirror",
  );
  await clickCanvas(page, 10, 0);
  await expect
    .poll(async () => {
      const solved = JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
      ) as { id: string; kind: string; x1?: number; x2?: number }[];
      const copy = solved.find((entity) => entity.id === "skent_mirror-1");
      return copy === undefined ? null : (copy.x1 ?? null);
    })
    .toBeCloseTo(60, 6);
  const mirrored = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
  ) as { id: string; x1?: number; x2?: number }[];
  const copy = mirrored.find((entity) => entity.id === "skent_mirror-1");
  expect(copy?.x2).toBeCloseTo(40, 6);

  // Extend: a short line short of a wall grows to it.
  await activateTool(page, "line");
  await clickCanvas(page, 0, 40);
  await clickCanvas(page, 20, 40);
  await activateTool(page, "line");
  await clickCanvas(page, -15, 30);
  await clickCanvas(page, -15, 50);
  await activateTool(page, "extend");
  await clickCanvas(page, 0.5, 40);
  await expect
    .poll(async () => {
      const solved = JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
      ) as { id: string; x1?: number }[];
      return solved.find((entity) => entity.id === "skent_line-3")?.x1;
    })
    .toBeCloseTo(-15, 6);
});

test("phase 37 ops: the rectangular array applies from the inspector form", async ({
  page,
}) => {
  await enterSketchMode(page);
  // A hexagon commits selected: two picks.
  await activateTool(page, "polygon");
  await clickCanvas(page, 0, 0);
  await clickCanvas(page, 15, 0);
  await activateTool(page, "rectArray");
  const apply = page.getByRole("button", { name: "Apply" });
  await expect(apply).toBeVisible();
  await apply.click();
  await expect
    .poll(async () => {
      const surface = await readSketchSurface(page);
      return surface.entities.filter((entity) => entity.kind === "polygon")
        .length;
    })
    .toBe(6);
  const surface = await readSketchSurface(page);
  // The 3×2 defaults: five grid copies, one transaction, all undoable.
  expect(surface.history.depth).toBe(2);
  expect(surface.commands).toBe(6);
});

test("phase 37 ops: convert declines honestly without a topology view", async ({
  page,
}) => {
  await enterSketchMode(page);
  const section = page.locator("[data-sketch-convert-section]");
  await expect(section).toContainText("No topology view");
  await activateTool(page, "convert");
  const status = JSON.parse(
    (await page.locator(SKETCH).getAttribute("data-sketch-tool-status")) ??
      "{}",
  ) as { readonly message: string };
  expect(status.message).toContain("no topology view");
  expect(
    (await page.locator(SKETCH).getAttribute("data-sketch-convert")) ?? "",
  ).toBe("");
});
