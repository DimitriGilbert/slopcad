import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { dispatchedCount } from "../../e2e-render/helpers";
import {
  RECT,
  SKETCH,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../../src/cad-workbench/SketchMode";
import { fillLabeledField } from "../feature-verbs";

/** The document workbench keeps the bare route's pinned root id. */
const WORKBENCH_ROOT = "workbench-root";
/** The volume readout the complete composition mounts (root-independent). */
const VOLUME_READOUT = "#workbench-complete-volume";

/** The fresh tutorial identity (a new public-flow sign-up per run). */
const TUTORIAL_USER = {
  name: "Taylor",
  email: `tutorial-e2e-${Date.now()}-${Math.round(Math.random() * 1e6)}@slopcad.dev`,
  password: "supercalifragilistic",
};

/** The pad the chapter models between its two saves (the s26b anchor). */
const PAD_VOLUME =
  (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * EXTRUDE_DEFAULT_DEPTH_MM;

/**
 * Chapter 30 — projects and versions, the whole persistence loop: a fresh
 * public sign-up, a project, a document, save v1, model a pad, save v2,
 * reload from the server, and the version-history walk back to v1 (the
 * s26 and s26b stages, at teaching pace). Signing in here is also what
 * unlocks the tsx-exchange chapter that follows — its import endpoint is
 * session-gated, exactly as s26c rides s26.
 */
export const chapter: ChapterModule = {
  definition: {
    id: "projects-and-versions",
    title: "Projects and versions",
    summary:
      "Sign up, create a project and document, save two versions around a modeled pad, reload, and walk the version history.",
    cues: [
      {
        stepId: "signup",
        text: "Projects start with an account: name, email, password — sign up.",
      },
      {
        stepId: "dashboard",
        text: "The dashboard greets you — the account exists.",
      },
      {
        stepId: "projects",
        text: "Projects group documents. Create one with a name.",
      },
      {
        stepId: "create-project",
        text: "Name it Tutorial journey, describe it, create.",
      },
      {
        stepId: "project",
        text: "Inside: the document list. Name a document and create it.",
      },
      {
        stepId: "create-doc",
        text: "tutorial-plate joins the project — still empty, honestly.",
      },
      {
        stepId: "open",
        text: "Open enters the workbench: unsaved at version zero.",
      },
      {
        stepId: "save-v1",
        text: "First save: version one. An empty document is now history.",
      },
      {
        stepId: "sketch",
        text: "Model the pad: the command menu opens sketch mode.",
      },
      {
        stepId: "extrude",
        text: "Extrude lands the pad — three thousand cubic millimeters.",
      },
      {
        stepId: "save-v2",
        text: "Save again: version two. Two milestones, one document.",
      },
      {
        stepId: "reload",
        text: "Reload: version two returns from the server, not memory.",
      },
      {
        stepId: "history",
        text: "History loads any save: pick v1, the pad leaves.",
      },
      {
        stepId: "recap",
        text: "Sign up, model, save, reload, walk the versions — the whole loop.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    const bar = page.locator('[data-testid="project-persistence-bar"]');

    await driver.step("signup");
    await page.goto("/login");
    const nameField = page.getByLabel("Name");
    await expect(nameField).toBeVisible();
    await driver.humanPoint(nameField);
    await driver.dwell();

    await driver.step("dashboard");
    await fillLabeledField(page, driver, nameField, TUTORIAL_USER.name);
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("Email"),
      TUTORIAL_USER.email,
    );
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("Password"),
      TUTORIAL_USER.password,
    );
    await driver.humanClick(page.getByRole("button", { name: "Sign Up" }));
    const dashboard = page.getByRole("heading", { name: "Dashboard" });
    await expect(dashboard).toBeVisible();
    await driver.humanPoint(dashboard);
    await driver.dwell();

    await driver.step("projects");
    await page.goto("/projects");
    const projectsHeading = page.getByRole("heading", { name: "Projects" });
    await expect(projectsHeading).toBeVisible();
    const projectName = page.getByLabel("Project name");
    await driver.humanPoint(projectName);
    await driver.dwell();

    await driver.step("create-project");
    await fillLabeledField(page, driver, projectName, "Tutorial journey");
    await fillLabeledField(
      page,
      driver,
      page.getByLabel("Description"),
      "the tutorial's project",
    );
    await driver.humanClick(
      page.getByRole("button", { name: "Create project" }),
    );
    const projectLink = page.locator('[data-testid="project-list"] a', {
      hasText: "Tutorial journey",
    });
    await expect(projectLink).toBeVisible();

    await driver.step("project");
    await driver.humanClick(projectLink);
    const projectHeading = page.getByRole("heading", {
      name: "Tutorial journey",
    });
    await expect(projectHeading).toBeVisible();
    await driver.dwell();

    await driver.step("create-doc");
    const documentName = page.getByLabel("Document name");
    await fillLabeledField(page, driver, documentName, "tutorial-plate");
    await driver.humanClick(
      page.getByRole("button", { name: "Create document" }),
    );
    const documentRow = page.locator('[data-testid="document-list"] li', {
      hasText: "tutorial-plate",
    });
    await expect(documentRow).toBeVisible();
    await driver.humanPoint(documentRow);
    await driver.dwell();

    await driver.step("open");
    await driver.humanClick(documentRow.getByRole("link", { name: "Open" }));
    await expect(bar).toHaveAttribute("data-loaded", "true");
    await expect(bar).toHaveAttribute("data-live-version", "0");
    await driver.dismissHint();
    const opened = await waitForRootSettle(page, WORKBENCH_ROOT);
    expect(Number(opened)).toBeGreaterThan(0);
    await driver.humanPoint(bar);
    await driver.dwell();

    await driver.step("save-v1");
    await driver.humanClick(page.locator('[data-testid="persistence-save"]'));
    await expect(bar).toHaveAttribute("data-live-version", "1");
    await expect(bar).toHaveAttribute("data-dirty", "false");
    await driver.humanPoint(bar);
    await driver.dwell();

    await driver.step("sketch");
    await driver.openCommandMenu(WORKBENCH_ROOT);
    await driver.clickCommandRow(WORKBENCH_ROOT, "sketch");
    await expect(page.locator(SKETCH)).toBeVisible();
    await driver.activateSketchTool("rectangle");
    // The session's s26b rectangle, shifted up out of the status bar's
    // band: the persistence bar's height moves the document workbench's
    // fixed canvas transform down, so the lowest rows are pinned there.
    // The pad's volume anchor is placement-independent — same 20 × 15.
    await driver.clickCanvasPoint(RECT.x0, RECT.y0 + 10);
    await driver.clickCanvasPoint(RECT.x1, RECT.y1 + 10);
    const entities = JSON.parse(
      (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ?? "[]",
    ) as { kind: string }[];
    expect(
      entities.filter((entity) => entity.kind === "rectangle").length,
    ).toBe(1);
    await driver.dwell();

    await driver.step("extrude");
    const before = await dispatchedCount(page, WORKBENCH_ROOT);
    await driver.humanClick(page.locator('[data-testid="sketch-extrude"]'));
    await expect(page.locator(`#${WORKBENCH_ROOT}`)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const extruded = await waitForRootSettle(page, WORKBENCH_ROOT, {
      afterDispatch: before,
    });
    expect(volumeNear(Number(extruded), PAD_VOLUME)).toBe(true);
    await driver.pointAtReadout(page.locator(VOLUME_READOUT));
    await driver.dwell();

    await driver.step("save-v2");
    await driver.humanClick(page.locator('[data-testid="persistence-save"]'));
    await expect(bar).toHaveAttribute("data-live-version", "2");
    await driver.humanPoint(bar);
    await driver.dwell();

    await driver.step("reload");
    await page.reload();
    await driver.dismissHint();
    await expect(bar).toHaveAttribute("data-live-version", "2");
    await expect(page.locator(`#${WORKBENCH_ROOT}`)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const reopened = await waitForRootSettle(page, WORKBENCH_ROOT);
    expect(volumeNear(Number(reopened), PAD_VOLUME)).toBe(true);
    const featureRow = page.locator(
      `[data-slot="cad-model-tree"] [data-node-key="feature|feat_extrude"]`,
    );
    await expect(featureRow).toBeVisible();
    await driver.humanPoint(featureRow);
    await driver.dwell();

    await driver.step("history");
    await driver.humanClick(
      page.getByRole("button", { name: "Version history" }),
    );
    const historyDialog = page.getByRole("dialog");
    await expect(historyDialog.getByText("Saved versions")).toBeVisible();
    await driver.humanClick(
      historyDialog.getByRole("button", { name: /^v1 / }),
    );
    await expect(bar).toHaveAttribute("data-live-version", "1");
    await expect(page.locator(`#${WORKBENCH_ROOT}`)).toHaveAttribute(
      "data-scene-kind",
      "plate",
    );
    await expect(
      page.locator(
        `[data-slot="cad-model-tree"] [data-node-key="feature|feat_extrude"]`,
      ),
    ).toHaveCount(0);
    await driver.humanPoint(bar);
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
