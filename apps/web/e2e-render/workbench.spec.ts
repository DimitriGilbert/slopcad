import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  activateTool,
  clickFaceAnchor,
  faceWithNormal,
  readFaceAnchors,
  readRenderedFrames,
  readSelection,
  readSelectionRegeneration,
  readToolSurface,
  saveArtifact,
  waitForRenderedFrames,
  waitForSelectionFrame,
  waitForSettledScene,
} from "./helpers";

/**
 * Phase 14 workbench e2e — the browser proof that the SAME interaction
 * flows run through the `@slopcad/cad-react` provider and hooks, and that
 * the DOMAIN is the thing that changed: every assertion reads the fixture's
 * machine-readable surfaces (`data-command-log` = canonical serialized
 * transactions, `data-hole-diameter` = the document's stored value,
 * `data-history` = the history view, `data-selection`/`data-tool-*` = the
 * Phase 12/13 surfaces), never page-local React state.
 *
 * Flows: parameter edit through useCadParameters (expression-aware) settles
 * a new volume; undo/redo through useCadHistory revert and re-apply it;
 * invalid expressions are refused structurally with nothing issued; tool
 * activation and selection run through useCadTools/useCadSelection.
 *
 * Point derivation follows the Phase 12 rule: every clicked point comes
 * from the fixture's face-anchor surface, never a guessed pixel.
 */

const ROOT = "workbench-root";
const VIEWPORT = "workbench-viewport";
const TOP_NORMAL = [0, 0, 1] as const;
const FRONT_NORMAL = [0, -1, 0] as const;

/** One read of the workbench's Phase 14 surfaces. */
async function readWorkbenchSurface(
  page: Page,
): Promise<{
  readonly holeDiameter: string;
  readonly history: {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly cursor: number;
    readonly depth: number;
  };
  readonly commandLog: readonly unknown[];
  readonly paramError: string;
}> {
  const root = page.locator(`#${ROOT}`);
  const raw = async (attribute: string): Promise<string> => {
    const value = await root.getAttribute(attribute);
    expect(value, `${attribute} must exist`).not.toBeNull();
    return value ?? "";
  };
  const history = JSON.parse(await raw("data-history")) as {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly cursor: number;
    readonly depth: number;
  };
  return {
    holeDiameter: await raw("data-hole-diameter"),
    history,
    commandLog: JSON.parse(await raw("data-command-log")) as readonly unknown[],
    paramError: await raw("data-param-error"),
  };
}

/** Applies a parameter input through the hook surface and waits for it. */
async function editHoleParameter(page: Page, value: string): Promise<void> {
  await page.locator("#param-holeDiameter").fill(value);
  await page.locator("#param-apply").click();
}

async function waitForHoleDiameter(
  page: Page,
  expected: string,
): Promise<void> {
  await page.waitForFunction(
    ({ id, expected: want }) => {
      const root = document.getElementById(id);
      return root !== null && root.getAttribute("data-hole-diameter") === want;
    },
    { id: ROOT, expected },
  );
}

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

test("a parameter edit through the hook commits a transaction and settles a new volume", async ({
  page,
}) => {
  await page.goto("/workbench");
  const defaultVolume = await waitForSettledScene(page, ROOT);
  const framesBefore = await readRenderedFrames(page, ROOT);

  // Boot state: the document's stored value on the surface, nothing issued.
  let surface = await readWorkbenchSurface(page);
  expect(surface.holeDiameter).toBe("8");
  expect(surface.history).toEqual({
    canUndo: false,
    canRedo: false,
    cursor: 0,
    depth: 0,
  });
  expect(surface.commandLog).toEqual([]);

  await editHoleParameter(page, "6");

  // The DOCUMENT changed first: the stored value and the command log move
  // before any pixel settles — the domain is the thing that changed.
  await waitForHoleDiameter(page, "6");
  surface = await readWorkbenchSurface(page);
  expect(surface.paramError).toBe("");
  expect(surface.history.canUndo).toBe(true);
  expect(surface.history.depth).toBe(1);
  expect(surface.commandLog).toHaveLength(1);
  const entry = surface.commandLog[0] as CommandLogEntry;
  expect(entry.commands.map((command) => command.type)).toEqual([
    "parameter.set",
  ]);
  expect(entry.commands[0]?.id).toBe("param_hole_diameter");
  expect(entry.commands[0]?.value).toEqual({
    dimension: "length",
    unit: "mm",
    value: 6,
  });

  // The executor stand-in followed the document: a settled NEW volume.
  await waitForRenderedFrames(page, framesBefore + 1, ROOT);
  const editedVolume = await waitForSettledScene(page, ROOT);
  expect(editedVolume).not.toBe(defaultVolume);
  await saveArtifact(
    "workbench-parameter-edited-fullpage.png",
    await page.screenshot(),
  );
});

test("undo and redo through the history hook revert and re-apply the document", async ({
  page,
}) => {
  await page.goto("/workbench");
  const defaultVolume = await waitForSettledScene(page, ROOT);

  await editHoleParameter(page, "6");
  const editedVolume = await waitForSettledScene(page, ROOT);
  expect(editedVolume).not.toBe(defaultVolume);

  await page.locator("#history-undo").click();

  // The document reverted; undo is a history move, not an issue: the
  // command log keeps its entry, the stored value is back to 8.
  await waitForHoleDiameter(page, "8");
  const surface = await readWorkbenchSurface(page);
  expect(surface.commandLog).toHaveLength(1);
  expect(surface.history.canRedo).toBe(true);
  expect(surface.history.cursor).toBe(0);
  const revertedVolume = await waitForSettledScene(page, ROOT);
  expect(revertedVolume).toBe(defaultVolume);

  await page.locator("#history-redo").click();
  await waitForHoleDiameter(page, "6");
  const redoneVolume = await waitForSettledScene(page, ROOT);
  expect(redoneVolume).toBe(editedVolume);
  await saveArtifact(
    "workbench-undo-redo-fullpage.png",
    await page.screenshot(),
  );
});

test("an invalid expression is refused structurally and issues nothing", async ({
  page,
}) => {
  await page.goto("/workbench");
  const volume = await waitForSettledScene(page, ROOT);
  const framesBefore = await readRenderedFrames(page, ROOT);

  await editHoleParameter(page, "holeDiameter *");

  await page.waitForFunction(() => {
    const root = document.getElementById("workbench-root");
    return (
      root !== null && root.getAttribute("data-param-error") !== ""
    );
  });
  const surface = await readWorkbenchSurface(page);
  expect(surface.paramError).toBe("expression/unexpected-end-of-input");
  await expect(page.locator("#param-error")).toHaveText(
    "expression/unexpected-end-of-input",
  );
  // Nothing was issued and nothing moved: document, history, and pixels.
  expect(surface.holeDiameter).toBe("8");
  expect(surface.commandLog).toEqual([]);
  expect(surface.history.depth).toBe(0);
  expect(await readRenderedFrames(page, ROOT)).toBe(framesBefore);
  expect(await waitForSettledScene(page, ROOT)).toBe(volume);
});

test("tool activation and selection run through the tool and selection hooks", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);
  const anchors = await readFaceAnchors(page, VIEWPORT);
  const revision = await readSelectionRegeneration(page, ROOT);
  const top = faceWithNormal(anchors, TOP_NORMAL);
  const front = faceWithNormal(anchors, FRONT_NORMAL);

  // MEASURE through useCadTools: two picks, one dimensional completion.
  await activateTool(page, "measure", ROOT);
  let tools = await readToolSurface(page, ROOT);
  expect(tools.toolId).toBe("measure");
  expect(tools.phase).toBe("active");
  expect(tools.toolState).toEqual({ stage: "awaiting-first" });

  await clickFaceAnchor(page, top.anchor, [], VIEWPORT);
  tools = await readToolSurface(page, ROOT);
  expect(tools.toolState).toEqual({
    stage: "awaiting-second",
    from: expect.anything(),
  });

  await clickFaceAnchor(page, front.anchor, [], VIEWPORT);
  await page.waitForFunction(() => {
    const root = document.getElementById("workbench-root");
    return root !== null && root.getAttribute("data-tool-phase") === "completed";
  });
  tools = await readToolSurface(page, ROOT);
  const completion = tools.completion as {
    readonly toolId: string;
    readonly detail: {
      readonly kind: string;
      readonly distance: { readonly unit: string; readonly value: number };
    };
  };
  expect(completion.toolId).toBe("measure");
  expect(completion.detail.kind).toBe("measurement");
  expect(completion.detail.distance.unit).toBe("mm");
  expect(completion.detail.distance.value).toBeGreaterThan(0);
  await expect(page.locator("#workbench-measure-readout")).toHaveText(
    `${completion.detail.distance.value.toFixed(3)} mm`,
  );

  // SELECT through useCadTools + useCadSelection: a click replaces the
  // selection and the highlight settles.
  await activateTool(page, "select", ROOT);
  await clickFaceAnchor(page, top.anchor, [], VIEWPORT);
  await waitForSelectionFrame(
    page,
    `face|body_plate|${String(revision)}|${String(top.faceIndex)}`,
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

  // Clear through the selection hook.
  await page.locator("#selection-clear").click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-selection",
    "[]",
  );
  await saveArtifact(
    "workbench-tool-selection-fullpage.png",
    await page.screenshot(),
  );
});

test("the principal hook-driven flow is captured on video", async ({
  page,
}) => {
  await page.goto("/workbench");
  await waitForSettledScene(page, ROOT);
  const anchors = await readFaceAnchors(page, VIEWPORT);
  // Boot-state sanity check: the anchor surface must exist before the flow
  // starts (the click points are re-derived after the edit below).
  expect(Object.keys(anchors).length).toBeGreaterThan(0);

  // Edit → select → undo: the phase-level authoring loop, all through hooks.
  await editHoleParameter(page, "6");
  await waitForSettledScene(page, ROOT);
  // The bore diameter changed the geometry: the anchor map is re-derived
  // from the NEW projection (never a guessed pixel — nor a stale one).
  const movedAnchors = await readFaceAnchors(page, VIEWPORT);
  const movedRevision = await readSelectionRegeneration(page, ROOT);
  const movedTop = faceWithNormal(movedAnchors, TOP_NORMAL);
  await activateTool(page, "select", ROOT);
  await clickFaceAnchor(page, movedTop.anchor, [], VIEWPORT);
  await waitForSelectionFrame(
    page,
    `face|body_plate|${String(movedRevision)}|${String(movedTop.faceIndex)}`,
    ROOT,
  );
  await page.locator("#history-undo").click();
  await waitForHoleDiameter(page, "8");
  await waitForSettledScene(page, ROOT);

  const video = page.video();
  expect(video, "the page must be recorded").not.toBeNull();
  const path = await video?.path();
  expect(path, "a video file must be attached").toBeTruthy();
});
