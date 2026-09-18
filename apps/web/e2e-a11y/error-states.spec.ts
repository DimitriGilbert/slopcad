import { expect, test } from "@playwright/test";

import { ROOT, awaitWorkbenchReady } from "./helpers";

/**
 * Phase 30 error-state accessibility checks (the browser-level complement
 * to the unit contracts): a refused parameter edit surfaces its structured
 * failure in a live alert region AND flips the field's aria-invalid —
 * the message reaches assistive technology the moment it appears, and
 * never travels by color alone.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/workbench-complete");
  await awaitWorkbenchReady(page, test.info().project.name);
});

test("a refused parameter edit announces its field error via alert", async ({
  page,
}) => {
  // Nothing may be issued by a refused edit: pin the command log first.
  const root = page.locator(`#${ROOT}`);
  const logBefore = await root.getAttribute("data-command-log");

  // Clearing a required number field and submitting refuses the edit;
  // the Formedible field error renders in a role=alert region.
  const field = page.getByLabel("translate_x", { exact: true });
  await field.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  const apply = page.getByRole("button", { name: "Apply" });
  await apply.focus();
  await page.keyboard.press("Enter");

  const fieldError = page
    .locator('[data-slot="cad-parameter-panel"] [role="alert"]')
    .first();
  await expect(fieldError).toBeVisible();
  await expect(fieldError).toContainText("Enter a number.");
  // The invalid state is on the input itself, not only the message.
  await expect(field).toHaveAttribute("aria-invalid", "true");

  expect(await root.getAttribute("data-command-log")).toBe(logBefore);
});
