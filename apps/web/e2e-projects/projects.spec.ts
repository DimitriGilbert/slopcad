import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { SettleAnchor } from "../e2e-render/helpers";

import { dispatchedCount, waitForSettledScene } from "../e2e-render/helpers";
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

/**
 * Registers a fresh session user through the public sign-up API.
 * `page.request` shares the browser context's cookie jar, so the session
 * cookie is live for the pages that follow.
 */
async function registerSessionUser(page: Page): Promise<void> {
  const response = await page.request.post("/api/auth/sign-up/email", {
    data: {
      name: "Save Race E2E",
      email: `save-race-e2e-${Date.now()}-${Math.round(Math.random() * 1e6)}@slopcad.dev`,
      password: "supercalifragilistic",
    },
  });
  expect(response.status()).toBeLessThan(400);
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
async function waitForRootSettle(
  page: Page,
  anchor?: SettleAnchor,
): Promise<string> {
  return waitForSettledScene(page, ROOT, anchor);
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
  // then verify the scene settled at the analytic volume. The settle is
  // ANCHORED on the dispatch counter captured before the Extrude click:
  // the bridge's document commit and the scene's dispatch effect land in
  // separate commits, so an unanchored wait could accept the pre-extrude
  // settled state.
  // The document workbench runs the complete composition now: sketch mode
  // enters through its command menu, not a dedicated mode toggle.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-command-menu-open",
    "true",
  );
  await page.locator('[data-cad-command-id="sketch"]').click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-command-menu-open",
    "false",
  );
  await expect(page.locator(SKETCH)).toBeVisible();
  await activateSketchTool(page, "rectangle");
  const surface = page.locator(`${SKETCH} [data-sketch-surface]`);
  const first = canvasPoint(RECT.x0, RECT.y0);
  const second = canvasPoint(RECT.x1, RECT.y1);
  await surface.click({ position: first });
  await surface.click({ position: second });
  const beforeExtrude = await dispatchedCount(page, ROOT);
  await page.locator(EXTRUDE_BUTTON).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "extrude",
  );
  const extrudedVolume = await waitForRootSettle(page, {
    afterDispatch: beforeExtrude,
  });
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

/**
 * The save-race pin (Phase 35 hardening): Save serializes the document at
 * CLICK time, and an edit that lands while the request is in flight must
 * keep the surface dirty after the response settles — the persisted
 * version contains the dispatched state, not the response-time state, so
 * marking the later edit as saved would silently lose it on reload.
 *
 * Determinism: the save round trip is HELD by a route interception until
 * the in-flight edit has visibly settled, so the ordering (edit lands
 * before the response) is forced, not raced.
 */
test("an edit that lands during an in-flight save keeps the surface dirty", async ({
  page,
}) => {
  await registerSessionUser(page);

  // The journey's preamble: one project, one fresh document, opened.
  await page.goto("/projects");
  await page.getByLabel("Project name").fill("Save race");
  await page.getByRole("button", { name: "Create project" }).click();
  const projectLink = page.locator('[data-testid="project-list"] a', {
    hasText: "Save race",
  });
  await expect(projectLink).toBeVisible();
  await projectLink.click();
  await page.getByLabel("Document name").fill("save-race-plate");
  await page.getByRole("button", { name: "Create document" }).click();
  const documentRow = page.locator('[data-testid="document-list"] li', {
    hasText: "save-race-plate",
  });
  await expect(documentRow).toBeVisible();
  await documentRow.getByRole("link", { name: "Open" }).click();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-loaded",
    "true",
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

  // EDIT 1 — the panel's parameter edit makes the surface dirty.
  const holeField = page.getByLabel("holeDiameter", { exact: true });
  await holeField.fill("12");
  await page.getByRole("button", { name: "Apply" }).click();
  await waitForRootSettle(page);
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-dirty",
    "true",
  );

  // HOLD the save round trip: the server's response is not delivered
  // until the in-flight edit below has settled.
  let saveHeld = false;
  let releaseSave: (() => void) | undefined;
  await page.route("**/api/trpc/**", async (route) => {
    if (route.request().url().includes("documents.save")) {
      saveHeld = true;
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    }
    await route.continue();
  });

  // SAVE 2 (dispatched at hole = 12) — the bar honestly shows saving…
  await page.locator(SAVE_BUTTON).click();
  await expect(page.locator(STATE_TEXT)).toHaveText("saving…");
  await expect
    .poll(() => saveHeld, { message: "the save request must be held" })
    .toBe(true);

  // EDIT 2 — lands while the save is in flight (dispatched state ≠ live).
  await holeField.fill("14");
  await page.getByRole("button", { name: "Apply" }).click();
  await waitForRootSettle(page);

  // Release the round trip: version 2 lands with the DISPATCHED state.
  releaseSave?.();
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-live-version",
    "2",
  );

  // The pin: the in-flight edit is NOT the persisted state — the surface
  // must stay dirty and Save must stay enabled after the settle.
  await expect(page.locator(PERSISTENCE_BAR)).toHaveAttribute(
    "data-dirty",
    "true",
  );
  await expect(page.locator(STATE_TEXT)).toHaveText("unsaved changes");
  await expect(page.locator(SAVE_BUTTON)).toBeEnabled();
  await saveArtifact(
    "save-race-dirty-after-in-flight-edit.png",
    await page.screenshot(),
  );
});
