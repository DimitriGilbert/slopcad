import { expect, test } from "@playwright/test";

/**
 * The Phase 57 configuration journey: author a two-config part on the
 * complete workbench — capture the edited state as a configuration row,
 * move the base away from it, and switch between the two — then export the
 * derived geometry of BOTH configurations through the STL exporter and
 * assert the two files differ (two configs, two geometries).
 *
 * The parameter panel's fields seed at mount (the Formedible defaultValues
 * adoption gate), so the assertions read the machine surfaces and the
 * status bar's volume — the document's truth — never the panel's input
 * display.
 */

const ROOT = "#workbench-complete-root";

test.setTimeout(120_000);

test("authoring a two-config part, switching, and exporting both", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  const root = page.locator(ROOT);
  await expect(root).toBeVisible();
  const panel = page.getByTestId("cad-configuration-panel");
  await expect(panel).toBeVisible();

  // The status bar's volume element carries the derived geometry's truth.
  const volumeOf = async (): Promise<string> => {
    const text = await page.locator("#workbench-complete-volume").textContent();
    const match = text?.match(/([0-9.]+)/);
    return match?.[1] ?? "";
  };

  // The settled base scene (the guide plate, hole 8).
  await expect(page.locator("#workbench-complete-volume")).toHaveText(
    /^[0-9.]+$/,
    { timeout: 15_000 },
  );
  const baseVolume = await volumeOf();
  expect(baseVolume).not.toBe("");

  // Edit a parameter: holeDiameter 8 → 12 (the parameter panel's apply).
  const holeInput = page.getByRole("spinbutton", { name: "holeDiameter" });
  await holeInput.fill("12");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(volumeOf, { timeout: 15_000 }).not.toBe(baseVolume);
  const editedVolume = await volumeOf();

  // Capture the edited state as the "wide" configuration row.
  await page
    .getByRole("textbox", { name: "New configuration name" })
    .fill("wide");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(
    panel.getByRole("radio", { name: "Active configuration: wide" }),
  ).toBeVisible();
  await expect(root).toHaveAttribute("data-configurations", /"name":"wide"/);

  // Move the base away from the captured state: holeDiameter back to 8.
  await page
    .getByRole("radio", { name: "Active configuration: Base document" })
    .click();
  await holeInput.fill("8");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(volumeOf, { timeout: 15_000 }).toBe(baseVolume);

  // Switch to the row: the effective values restore the captured geometry.
  await page.getByRole("radio", { name: "Active configuration: wide" }).click();
  await expect.poll(volumeOf, { timeout: 15_000 }).toBe(editedVolume);
  await expect(root).toHaveAttribute("data-configurations", /"active":"cfg_/);

  // Export the wide configuration's geometry through the STL exporter:
  // the dialog holds the bytes, the download link serves them. The
  // workbench re-renders per rendered frame, so every interaction here is
  // one DOM click or one protocol read — no locator bookkeeping to race.
  // Absence is a valid state (the entry appears on first export), so the
  // read bounds itself and reports null instead of waiting for attach.
  const hrefOf = (): Promise<string | null> =>
    page
      .getAttribute("[data-testid='cad-export-download-stl']", "href", {
        timeout: 2_000,
      })
      .catch(() => null);
  const clickOf = (testId: string): Promise<boolean> =>
    page.evaluate((id) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid='${id}']`,
      );
      if (element === null) return false;
      element.click();
      return true;
    }, testId);

  const exportTrigger = page.getByTestId("complete-export");
  const downloadStl = async (): Promise<Buffer> => {
    // The exporter reads the engine's applied scene; wait out any transient
    // re-apply window on the trigger's enabled state, then open the dialog.
    await expect(exportTrigger).toBeEnabled({ timeout: 30_000 });
    await exportTrigger.click();
    await page.waitForSelector("[data-testid='cad-export-run-stl']", {
      state: "attached",
      timeout: 30_000,
    });
    const previousHref = await hrefOf();
    const clicked = await clickOf("cad-export-run-stl");
    expect(clicked, "the STL export button must exist").toBe(true);
    // The runner holds fresh bytes and re-points the link; wait for the
    // re-point (or the link's first appearance) before serving.
    if (previousHref !== null) {
      await expect.poll(hrefOf, { timeout: 30_000 }).not.toBe(previousHref);
    } else {
      await expect
        .poll(async () => await hrefOf(), { timeout: 30_000 })
        .not.toBeNull();
    }
    const download = page
      .waitForEvent("download", { timeout: 20_000 })
      .catch(() => null);
    await clickOf("cad-export-download-stl");
    const saved = await download;
    expect(saved).not.toBeNull();
    const path = await saved?.path();
    expect(path).toBeTruthy();
    return (await import("node:fs")).readFileSync(path ?? "");
  };
  const wideBytes = await downloadStl();

  // The dialog's overlay hides everything outside it from the a11y tree;
  // close it before driving the switcher again.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // Back to base; export the base geometry. Two configs → two geometries.
  await page
    .getByRole("radio", { name: "Active configuration: Base document" })
    .click();
  await expect.poll(volumeOf, { timeout: 15_000 }).toBe(baseVolume);
  const baseBytes = await downloadStl();

  // The derived geometry differs per configuration (byte-level).
  expect(wideBytes.length).toBeGreaterThan(0);
  expect(baseBytes.length).toBeGreaterThan(0);
  expect(wideBytes.equals(baseBytes)).toBe(false);
});
