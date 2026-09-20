import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  awaitWorkbenchReady,
  collectTabStops,
  ROOT,
  tabStopKey,
} from "./helpers";

/**
 * Phase 30 keyboard-only journey through the complete workbench — the
 * plan's "keyboard-only workflow works" gate. A pointer is never clicked:
 * every activation is Tab/Enter/Escape/digit/Ctrl+K, exactly the surfaces
 * the CAD ergonomics already document (digit tool switching, the Ctrl+K
 * palette, Enter/Space activation, Escape cancel). Programmatic
 * `.focus()` placement stands in for "arrived here by Tab" where the
 * journey re-targets mid-flow; the tab-order itself is asserted
 * separately from a real Tab walk, not from these placements.
 *
 * The journey: open and settle → the status bar's live regions are wired
 * → the tab order runs toolbar → timeline → history → commands → file →
 * mode → viewport → parameter fields, skipping disabled controls → a
 * digit arms a tool and Escape cancels it → Ctrl+K opens the palette,
 * focus lands in its input, and a run command switches to sketch mode
 * (and Model exits back) → a tree row is selected from the keyboard → a
 * parameter edit commits `parameter.set` from the keyboard → Undo
 * keyboard-activates → both io dialogs open, release focus on Escape, and
 * restore focus to their trigger → and an import dialog launched from the
 * palette — the route where the primitives' default restore cannot work,
 * because the palette unmounts on run — still restores focus to the
 * workbench's import trigger through the wired finalFocus ref.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/workbench-complete");
  await awaitWorkbenchReady(page, test.info().project.name);
});

test("status bar live regions are wired in the composed page", async ({
  page,
}) => {
  const status = page.getByTestId("cad-status-bar-status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  const error = page.getByTestId("cad-status-bar-error");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).toHaveAttribute("aria-live", "assertive");
});

test("focus order runs row-to-docks and skips disabled controls", async ({
  page,
}) => {
  // Fresh-open history: both undo and redo start disabled (nothing
  // committed yet), which the walk must skip.
  const historyRaw = await page
    .locator(`#${ROOT}`)
    .getAttribute("data-history");
  const canUndo =
    (JSON.parse(historyRaw ?? "{}") as { canUndo?: boolean }).canUndo === true;

  const stops = await collectTabStops(page, 80);
  const keys = stops.map(tabStopKey);
  const indexOf = (predicate: (key: string) => boolean): number =>
    keys.findIndex(predicate);

  // The toolbar's tools lead the workbench (after the app header), in
  // their registry order — read from the DOM, not assumed.
  const registry = await page
    .locator('[data-slot="cad-toolbar"] button[data-tool-id]')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-tool-id") ?? ""),
    );
  expect(registry.length, "the toolbar mounts its tools").toBeGreaterThan(0);
  const firstTool = keys.findIndex((key) =>
    registry.includes(key.toLowerCase()),
  );
  expect(
    firstTool,
    "a toolbar tool is reachable by Tab",
  ).toBeGreaterThanOrEqual(0);
  const toolKeys = keys
    .slice(firstTool, firstTool + registry.length)
    .map((key) => key.toLowerCase());
  expect(toolKeys).toEqual(registry);

  // The scheme picker is part of the app header's walk (before the
  // workbench root's own surfaces).
  const schemePicker = indexOf((key) => key === "scheme-picker");
  expect(
    schemePicker,
    "the scheme picker is reachable by Tab",
  ).toBeGreaterThanOrEqual(0);
  expect(schemePicker).toBeLessThan(firstTool);

  // A named timeline control closes the walk: the feature band is its
  // own full-width row BELOW the workspace, so the document's history
  // controls follow the docks' fields (the gaps and suppress toggles
  // are real, named buttons).

  // History (when enabled), commands, file actions, mode toggle — in
  // that order.
  let cursor = firstTool;
  if (canUndo) {
    const undo = indexOf((key) => key === "Undo");
    const redo = indexOf((key) => key === "Redo");
    expect(undo).toBeGreaterThan(cursor);
    expect(redo).toBeGreaterThan(undo);
    cursor = redo;
  }
  const commands = indexOf((key) => key === "complete-command-menu-trigger");
  expect(commands).toBeGreaterThan(cursor);
  const importIndex = indexOf((key) => key === "complete-import");
  const exportIndex = indexOf((key) => key === "complete-export");
  const sketch = indexOf((key) => key === "complete-mode-toggle");
  expect(importIndex).toBeGreaterThan(commands);
  expect(exportIndex).toBeGreaterThan(importIndex);
  expect(sketch).toBeGreaterThan(exportIndex);

  // The viewport region is keyboard-focusable after the command row…
  const viewport = indexOf((key) => key === "CAD viewport");
  expect(viewport).toBeGreaterThan(sketch);

  // …and the parameter fields close the workspace (fresh plate document:
  // translate_x/y/z then rotate_z).
  const translateX = indexOf((key) => key.startsWith("translate_x"));
  expect(translateX).toBeGreaterThan(viewport);

  // The feature band's timeline controls follow the workspace: the band
  // is its own full-width row below it, after the docks' fields.
  const timeline = keys
    .slice(translateX + 1)
    .filter((key) => /^(Suppress|Include|Roll back)/.test(key));
  expect(
    timeline.length,
    "a named timeline control follows the workspace",
  ).toBeGreaterThan(0);

  // Disabled controls never appear as tab stops: on a fresh open the
  // hole action (no extrusion yet) and the history buttons are disabled.
  expect(keys).not.toContain("complete-hole");
  await expect(page.getByTestId("complete-hole")).toBeDisabled();
  if (!canUndo) {
    expect(keys).not.toContain("Undo");
    expect(keys).not.toContain("Redo");
  }
});

test("digit keys arm a tool and Escape cancels it from the viewport", async ({
  page,
}) => {
  const tools = page.locator('[data-slot="cad-toolbar"] button[data-tool-id]');
  const secondTool = tools.nth(1);
  const secondToolId = await secondTool.getAttribute("data-tool-id");

  await tools.first().focus();
  await page.keyboard.press("2");
  const root = page.locator(`#${ROOT}`);
  await expect(root).toHaveAttribute("data-tool-id", secondToolId ?? "");
  await expect(root).toHaveAttribute("data-tool-phase", "active");

  // Escape on the focused viewport cancels the live activation.
  await page.locator('[aria-label="CAD viewport"]').focus();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => root.getAttribute("data-tool-phase"))
    .not.toBe("active");
});

test("Ctrl+K opens the palette, focus enters its input, a run switches mode", async ({
  page,
}) => {
  const root = page.locator(`#${ROOT}`);
  await page.keyboard.press("Control+k");
  await expect(root).toHaveAttribute("data-command-menu-open", "true");

  // Initial focus: the palette's input (the dialog's first focusable).
  const input = page.getByPlaceholder("Type a command…");
  await expect(input).toBeFocused();

  await page.keyboard.type("sketch");
  await page.keyboard.press("Enter");
  await expect(root).toHaveAttribute("data-command-menu-open", "false");
  await expect(root).toHaveAttribute("data-sketch-mode", "sketch");

  // Back out of sketch mode from the keyboard: the Model toggle.
  await page.getByTestId("workbench-mode-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(root).toHaveAttribute("data-sketch-mode", "model");
});

test("a tree row selects from the keyboard and the property panel answers", async ({
  page,
}) => {
  const rows = page.locator('[data-slot="cad-model-tree"] [role="treeitem"]');
  const firstRow = rows.first();
  await firstRow.focus();
  await page.keyboard.press("Enter");

  const root = page.locator(`#${ROOT}`);
  await expect
    .poll(async () => {
      const value = await root.getAttribute("data-selection-key");
      return value === null || value === "" ? "empty" : "selected";
    })
    .toBe("selected");
  await expect(
    page
      .locator('[data-slot="cad-property-panel"] [data-cad-property-section]')
      .first(),
  ).toBeVisible();
});

test("a parameter edit commits parameter.set from the keyboard", async ({
  page,
}) => {
  const field = page.getByLabel("translate_x", { exact: true });
  await field.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");

  const root = page.locator(`#${ROOT}`);
  const commandLogHasParameterSet = async (): Promise<boolean> => {
    const raw = await root.getAttribute("data-command-log");
    return (JSON.parse(raw ?? "[]") as { commands: { type: string }[] }[]).some(
      (entry) =>
        entry.commands.some((command) => command.type === "parameter.set"),
    );
  };
  await expect.poll(commandLogHasParameterSet).toBe(true);

  // Undo keyboard-activates and rewinds the history cursor.
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const raw = await root.getAttribute("data-history");
      return (
        (JSON.parse(raw ?? "{}") as { canUndo?: boolean }).canUndo === true
      );
    })
    .toBe(false);
});

async function openDialogByKeyboard(
  page: Page,
  triggerId: string,
  dialogSelector: string,
): Promise<void> {
  const trigger = page.getByTestId(triggerId);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator(dialogSelector);
  await expect(dialog).toBeVisible();
  // Initial focus sits INSIDE the modal (the intentional trap).
  const inside = await page.evaluate((selector) => {
    const dialogElement = document.querySelector(selector ?? "");
    return (
      dialogElement !== null && dialogElement.contains(document.activeElement)
    );
  }, dialogSelector);
  expect(inside, "focus starts inside the dialog").toBe(true);
}

test("import dialog: keyboard open, Escape close, focus restores to trigger", async ({
  page,
}) => {
  await openDialogByKeyboard(
    page,
    "complete-import",
    "[data-cad-import-dialog]",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-cad-import-dialog]")).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const element = document.activeElement;
      return element instanceof HTMLElement
        ? element.getAttribute("data-testid")
        : null;
    }),
  ).toBe("complete-import");
});

test("export dialog: keyboard open, Escape close, focus restores to trigger", async ({
  page,
}) => {
  await openDialogByKeyboard(
    page,
    "complete-export",
    "[data-cad-export-dialog]",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-cad-export-dialog]")).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const element = document.activeElement;
      return element instanceof HTMLElement
        ? element.getAttribute("data-testid")
        : null;
    }),
  ).toBe("complete-export");
});

test("palette-launched import dialog restores focus to the trigger, not the palette", async ({
  page,
}) => {
  // Neutral starting focus: with the page blurred, the dialog primitive's
  // default restore target cannot be the import trigger — only the wired
  // finalFocus ref can land focus there.
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  const root = page.locator(`#${ROOT}`);

  await page.keyboard.press("Control+k");
  await expect(root).toHaveAttribute("data-command-menu-open", "true");
  await expect(page.getByPlaceholder("Type a command…")).toBeFocused();

  await page.keyboard.type("import");
  await page.keyboard.press("Enter");
  await expect(root).toHaveAttribute("data-command-menu-open", "false");
  const dialog = page.locator("[data-cad-import-dialog]");
  await expect(dialog).toBeVisible();
  // Initial focus sits INSIDE the modal (the intentional trap).
  expect(
    await page.evaluate(() => {
      const dialogElement = document.querySelector("[data-cad-import-dialog]");
      return (
        dialogElement !== null && dialogElement.contains(document.activeElement)
      );
    }),
    "focus starts inside the dialog",
  ).toBe(true);

  // The palette unmounted when the command ran — Escape must land on the
  // original trigger through the wired finalFocus ref, never on the
  // unmounted palette or the primitive's default restore target.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const element = document.activeElement;
      return element instanceof HTMLElement
        ? element.getAttribute("data-testid")
        : null;
    }),
  ).toBe("complete-import");
});

/** Loads one in-memory file into the import dialog's file input. */
async function importFileNamed(page: Page, name: string): Promise<void> {
  await page.getByTestId("cad-import-file").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("no geometry here"),
  });
}

test("a refused import surfaces its structured error in an alert region", async ({
  page,
}) => {
  await openDialogByKeyboard(
    page,
    "complete-import",
    "[data-cad-import-dialog]",
  );
  await importFileNamed(page, "not-a-model.txt");
  const alert = page.locator('[data-cad-import-error][role="alert"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("unsupported file type: not-a-model.txt");
  // Escape still closes, and focus still restores.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-cad-import-dialog]")).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const element = document.activeElement;
      return element instanceof HTMLElement
        ? element.getAttribute("data-testid")
        : null;
    }),
  ).toBe("complete-import");
});
