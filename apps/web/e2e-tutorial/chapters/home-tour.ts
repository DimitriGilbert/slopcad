import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { COMPLETE_ROOT, waitForRootSettle } from "../../e2e-session/helpers";

/**
 * Chapter 1 — the front door. What slopcad is, what the home page promises,
 * where the three surfaces live, and the door into the workbench (the s01
 * stage's surfaces, walked at teaching pace and narrated as instruction).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "home-tour",
    title: "The front door",
    summary:
      "What slopcad is, what the home page shows you, and where the workbench lives.",
    cues: [
      {
        stepId: "welcome",
        text: "Welcome to slopcad. Before any modeling, a quick map of where everything lives.",
      },
      {
        stepId: "claim",
        text: "The headline is the promise: parametric CAD whose document always tells the truth.",
      },
      {
        stepId: "live-viewport",
        text: "The right panel renders the guide plate live — your browser is the CAD engine.",
      },
      {
        stepId: "cta",
        text: "This button, Open the workbench, is the door to the modeling cockpit.",
      },
      {
        stepId: "cards",
        text: "Three cards below index the app: Workbench, Components, and Docs.",
      },
      {
        stepId: "components-card",
        text: "Components opens reusable parametric parts, rebuilt live by the kernel.",
      },
      {
        stepId: "docs-card",
        text: "Docs holds every guide, generated from the constants the test gates prove.",
      },
      {
        stepId: "api-light",
        text: "The dot beside the buttons is the API light. Green means the server answers.",
      },
      {
        stepId: "enter",
        text: "Come through the door. The workbench loads the boot plate document.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await page.goto("/");

    await driver.step("welcome");
    await driver.dwell();

    await driver.step("claim");
    const headline = page.getByRole("heading", {
      name: "Parametric CAD with a document that tells the truth.",
    });
    await expect(headline).toBeVisible();
    await driver.humanPoint(headline);
    await driver.dwell();

    await driver.step("live-viewport");
    const heroViewport = page.locator("canvas").first();
    await expect(heroViewport).toBeVisible();
    await driver.humanPoint(heroViewport);
    await driver.dwell();

    await driver.step("cta");
    const openWorkbench = page.getByRole("link", {
      name: "Open the workbench",
    });
    await expect(openWorkbench).toBeVisible();
    await driver.humanPoint(openWorkbench);
    await driver.dwell();

    await driver.step("cards");
    for (const title of ["Workbench", "Components", "Docs"]) {
      await driver.humanPoint(
        page.getByRole("heading", { name: title, exact: true }),
      );
    }
    await driver.dwell();

    await driver.step("components-card");
    await driver.humanPoint(
      page.getByRole("heading", { name: "Components", exact: true }),
    );
    await driver.dwell();

    await driver.step("docs-card");
    await driver.humanPoint(
      page.getByRole("heading", { name: "Docs", exact: true }),
    );
    await driver.dwell();

    await driver.step("api-light");
    const apiLight = page.getByText(/^api: (connected|disconnected)$/);
    await expect(apiLight).toBeVisible({ timeout: 10_000 });
    await driver.humanPoint(apiLight);
    await driver.dwell();

    await driver.step("enter");
    await driver.humanClick(openWorkbench);
    await driver.dismissHint();
    await waitForRootSettle(page, COMPLETE_ROOT);
  },
};
