import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { waitForSettledScene } from "../e2e-render/helpers";
import { SKETCH_CANVAS } from "../src/cad-workbench/sketch-editor";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";

/**
 * Phase 31 project-workflow e2e — the plan's persistence journey on the
 * REAL production build, through public flows only (no seeding, no auth
 * shortcuts): register a fresh identity on the login surface, create a
 * project, create a document, model a solid (sketch → extrude), SAVE, and
 * after a full page reload REOPEN the persisted document with its content
 * restored — machine surfaces and settled pixels — then walk the version
 * history back to version 1.
 *
 * Every semantic assertion reads the machine surfaces (the persistence
 * bar's `data-*` state, the workbench root's settle protocol, the model
 * tree), with screenshots as artifacts, never as the only evidence. The
 * harness records one video for the whole journey (video-artifact
 * reporter → `e2e-artifacts/projects/`).
 */

const ROOT = "workbench-root";
const TREE = '[data-slot="cad-model-tree"]';
const SAVE_BUTTON = '[data-testid="persistence-save"]';
const PERSISTENCE_BAR = '[data-testid="project-persistence-bar"]';
const STATE_TEXT = '[data-testid="persistence-state"]';
const SKETCH = "#sketch-root";
const EXTRUDE_BUTTON = '[data-testid="sketch-extrude"]';
const MODE_TOGGLE = '[data-testid="workbench-mode-toggle"]';

/** The sketch rectangle this journey draws (workplane mm). */
const RECT = { x0: 10, y0: 10, x1: 30, y1: 25 } as const;

/** Relative volume tolerance (the render suite's documented band). */
const VOLUME_REL_TOLERANCE = 0.005;

/** A unique identity per run: users are created through the public flow. */
const TEST_USER = {
  name: "Project E2E",
  email: `project-e2e-${Date.now()}-${Math.round(Math.random() * 1e6)}@slopcad.dev`,
  password: "supercalifragilistic",
};

/** Saves a screenshot artifact under the projects artifacts directory. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/projects", { recursive: true });
  await writeFile(`e2e-artifacts/projects/${name}`, bytes);
}

/** A point on the sketch canvas for workplane coordinates (documented transform). */
function canvasPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: SKETCH_CANVAS.origin.x + x * SKETCH_CANVAS.scale,
    y: SKETCH_CANVAS.origin.y - y * SKETCH_CANVAS.scale,
  };
}

function volumeNear(observed: number, analytic: number): boolean {
  return (
    Math.abs(observed - analytic) <= Math.abs(analytic) * VOLUME_REL_TOLERANCE
  );
}

/** Activates a sketch tool through the sketch toolbar. */
async function activateSketchTool(page: Page, toolId: string): Promise<void> {
  await page.locator(`[data-sketch-tool-id="${toolId}"]`).click();
  await expect(page.locator(SKETCH)).toHaveAttribute(
    "data-sketch-tool",
    toolId,
  );
}

/** Waits until the workbench root's settle stamp agrees with the volume. */
async function waitForRootSettle(page: Page): Promise<string> {
  return waitForSettledScene(page, ROOT);
}

test("persistence: register, create project and document, model, save, reload, reopen, walk history", async ({
  page,
}) => {
  // REGISTER — the public sign-up flow; Better Auth sets the session cookie.
  await page.goto("/login");
  await page.getByLabel("Name").fill(TEST_USER.name);
  await page.getByLabel("Email").fill(TEST_USER.email);
  await page.getByLabel("Password").fill(TEST_USER.password);
  await page.getByRole("button", { name: "Sign Up" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // CREATE PROJECT — the Formedible form; the router creates an owned row.
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.getByLabel("Project name").fill("Persistence journey");
  await page.getByLabel("Description").fill("Phase 31 browser evidence");
  await page.getByRole("button", { name: "Create project" }).click();
  const projectLink = page.locator('[data-testid="project-list"] a', {
    hasText: "Persistence journey",
  });
  await expect(projectLink).toBeVisible();
  await saveArtifact(
    "projects-list-after-create.png",
    await page.screenshot({ fullPage: true }),
  );

  // CREATE DOCUMENT — inside the owned project.
  await projectLink.click();
  await expect(
    page.getByRole("heading", { name: "Persistence journey" }),
  ).toBeVisible();
  await page.getByLabel("Document name").fill("carrier-plate");
  await page.getByRole("button", { name: "Create document" }).click();
  const documentRow = page.locator('[data-testid="document-list"] li', {
    hasText: "carrier-plate",
  });
  await expect(documentRow).toBeVisible();
  await saveArtifact(
    "project-detail-after-create.png",
    await page.screenshot({ fullPage: true }),
  );

  // OPEN — the document enters the real workbench through the store's
  // replaceSession door once its persisted state is known (nothing saved
  // yet: version 0, the authored boot document, honestly "unsaved").
  await documentRow.getByRole("link", { name: "Open" }).click();
  await expect(page.locator(PERSISTENCE_BAR)).toBeVisible();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-loaded",
    "true",
  );
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-live-version",
    "0",
  );
  await expect(page.getByTestId("persistence-document-name")).toHaveText(
    "carrier-plate",
  );
  await waitForRootSettle(page);

  // SAVE 1 — the boot document becomes version 1; the bar turns clean.
  await page.locator(SAVE_BUTTON).click();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-live-version",
    "1",
  );
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-dirty",
    "false",
  );
  await expect(page.locator(STATE_TEXT)).toHaveText("saved v1");

  // MODEL — sketch a rectangle and extrude it (the sketch → solid bridge),
  // then verify the scene settled at the analytic volume.
  await page.locator(MODE_TOGGLE).click();
  await expect(page.locator(SKETCH)).toBeVisible();
  await activateSketchTool(page, "rectangle");
  const surface = page.locator(`${SKETCH} [data-sketch-surface]`);
  const first = canvasPoint(RECT.x0, RECT.y0);
  const second = canvasPoint(RECT.x1, RECT.y1);
  await surface.click({ position: first });
  await surface.click({ position: second });
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  const extrudedVolume = await waitForRootSettle(page);
  const analytic =
    (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;
  expect(
    volumeNear(Number(extrudedVolume), analytic),
    `extruded ${extrudedVolume} vs analytic ${String(analytic)}`,
  ).toBe(true);
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-dirty",
    "true",
  );
  await saveArtifact(
    "workbench-extruded-before-save.png",
    await page.screenshot(),
  );

  // SAVE 2 — the extruded document becomes version 2.
  await page.locator(SAVE_BUTTON).click();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-live-version",
    "2",
  );
  await expect(page.locator(STATE_TEXT)).toHaveText("saved v2");

  // RELOAD + REOPEN — the page reloads; the persisted document re-enters
  // the store and the scene follows the document's newest solid feature.
  await page.reload();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-loaded",
    "true",
  );
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-live-version",
    "2",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  const reopenedVolume = await waitForRootSettle(page);
  expect(
    volumeNear(Number(reopenedVolume), analytic),
    `reopened ${reopenedVolume} vs analytic ${String(analytic)}`,
  ).toBe(true);

  // The restored CONTENT, not just pixels: the persisted feature graph is
  // on the model tree and the bar reports a clean, saved state.
  await expect(
    page.locator(`${TREE} [data-node-key="feature|feat_extrude"]`),
  ).toBeVisible();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-dirty",
    "false",
  );
  await saveArtifact(
    "workbench-reopened-after-reload.png",
    await page.screenshot(),
  );

  // VERSION HISTORY — the popover lists both saves; opening version 1
  // restores the pre-extrude document (plate scene, plate volume).
  await page.getByRole("button", { name: "Version history" }).click();
  const historyDialog = page.getByRole("dialog");
  await expect(historyDialog.getByText("Saved versions")).toBeVisible();
  const v2Row = historyDialog.getByRole("button", { name: /^v2 / });
  const v1Row = historyDialog.getByRole("button", { name: /^v1 / });
  await expect(v2Row).toBeVisible();
  await expect(v1Row).toBeVisible();
  await saveArtifact("version-history-popover.png", await page.screenshot());
  await v1Row.click();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-live-version",
    "1",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "plate",
  );
  const v1Volume = await waitForRootSettle(page);
  expect(
    volumeNear(Number(v1Volume), Number(extrudedVolume)) === false,
    `version 1 (${String(v1Volume)}) must not carry the extruded volume (${extrudedVolume})`,
  ).toBe(true);
  await expect(
    page.locator(`${TREE} [data-node-key="feature|feat_extrude"]`),
  ).toHaveCount(0);
  await saveArtifact(
    "workbench-reopened-version-1.png",
    await page.screenshot(),
  );
});
