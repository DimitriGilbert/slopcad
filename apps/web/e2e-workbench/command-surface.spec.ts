import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Phase 60 command-surface audit — the DOM half (the mechanical roadmap
 * -> checklist closure is `scripts/command-surface-audit.mjs`).
 *
 * On the production build, per route, this spec proves the checklist's
 * mapped surfaces actually mount, and — the closure that makes the audit
 * mechanical — that the complete workbench's command menu carries EXACTLY
 * the command entries the checklist names: no shipped-but-undocumented
 * command row, no checklist row the menu stopped shipping. Preconditioned
 * rows may render disabled (an honest structured decline stays
 * reachable); a missing row is an audit failure.
 *
 * The checklist (command-surface.checklist.json) is the single source the
 * roadmap-coverage script and this spec share. Adding a surface = adding
 * a checklist entry + (for panels) its machine selector; adding a
 * roadmap capability without one fails the script.
 */

interface ChecklistEntry {
  readonly id: string;
  readonly phase: number;
  readonly kind: "command" | "command-panel" | "panel";
  readonly route: string;
  readonly target?: string;
  readonly targets?: readonly string[];
}

interface ChecklistDoc {
  readonly epoch: string;
  readonly entries: readonly ChecklistEntry[];
}

const checklist: ChecklistDoc = JSON.parse(
  readFileSync(
    new URL("./command-surface.checklist.json", import.meta.url),
    "utf8",
  ),
) as ChecklistDoc;

const COMPLETE_ROOT = "workbench-complete-root";

/** Workbenches whose menu rows must equal the checklist's command set. */
const MENU_ROUTES = ["/workbench-complete"] as const;

function entriesOf(route: string): ChecklistEntry[] {
  return checklist.entries.filter((entry) => entry.route === route);
}

/** Open the command menu and return every rendered row id. */
async function openMenuAndReadRows(page: Page): Promise<string[]> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(`#${COMPLETE_ROOT}`)).toHaveAttribute(
    "data-command-menu-open",
    "true",
  );
  const rows = page.locator("[data-cad-command-id]");
  const count = await rows.count();
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push((await rows.nth(i).getAttribute("data-cad-command-id")) ?? "");
  }
  return ids;
}

test("checklist closure: the complete workbench menu ships exactly the audited commands", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await expect(page.locator(`#${COMPLETE_ROOT}`)).toBeAttached();
  await expect
    .poll(async () =>
      page
        .locator(`#${COMPLETE_ROOT}`)
        .getAttribute("data-cad-rendered-volume"),
    )
    .not.toBeNull();

  const domIds = await openMenuAndReadRows(page);
  const checklistCommandIds = entriesOf("/workbench-complete")
    .filter(
      (entry) => entry.kind === "command" || entry.kind === "command-panel",
    )
    .map((entry) => entry.target ?? "");

  // No undocumented command: every menu row is a checklist entry...
  const undocumented = domIds.filter((id) => !checklistCommandIds.includes(id));
  expect(undocumented, "menu rows missing from the checklist").toEqual([]);

  // ...and no dead checklist row: every audited command id is in the menu.
  const missing = checklistCommandIds.filter((id) => !domIds.includes(id));
  expect(missing, "checklist commands missing from the menu").toEqual([]);
});

for (const route of MENU_ROUTES) {
  test(`command rows are individually addressable on ${route}`, async ({
    page,
  }) => {
    await page.goto(route);
    await expect(page.locator(`#${COMPLETE_ROOT}`)).toBeAttached();
    const domIds = await openMenuAndReadRows(page);
    for (const entry of entriesOf(route)) {
      if (entry.kind === "panel") continue;
      const row = page.locator(`[data-cad-command-id="${entry.target ?? ""}"]`);
      expect(domIds).toContain(entry.target ?? "");
      await expect(row).toBeAttached();
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(`#${COMPLETE_ROOT}`)).toHaveAttribute(
      "data-command-menu-open",
      "false",
    );
  });
}

test("sketch workspace: the sketch vocabulary panel mounts with its machine surface", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await expect(page.locator(`#${COMPLETE_ROOT}`)).toBeAttached();

  // Run the audited `sketch` command from the menu itself.
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator('[data-cad-command-id="sketch"]').click();
  await expect(page.locator(`#${COMPLETE_ROOT}`)).toHaveAttribute(
    "data-command-menu-open",
    "false",
  );

  const sketchEntry = checklist.entries.find(
    (entry) => entry.id === "sketch-vocabulary-workspace",
  );
  for (const selector of sketchEntry?.targets ?? []) {
    await expect(page.locator(selector)).toBeVisible();
  }
  for (const selector of [
    ...(checklist.entries.find((entry) => entry.id === "sketch-solver-status")
      ?.targets ?? []),
    ...(checklist.entries.find(
      (entry) => entry.id === "sketch-editing-operations",
    )?.targets ?? []),
    ...(checklist.entries.find((entry) => entry.id === "sketch-exchange-import")
      ?.targets ?? []),
  ]) {
    await expect(page.locator(selector)).toBeAttached();
  }

  // No exit step: every test gets a fresh page, and the mode toggle is
  // not part of the sketch surface it toggles into (it hides in sketch
  // mode) — the next test navigates fresh.
});

test("complete workbench panels: viz, sections, and the exchange dialogs", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await expect(page.locator(`#${COMPLETE_ROOT}`)).toBeAttached();
  await expect
    .poll(async () =>
      page
        .locator(`#${COMPLETE_ROOT}`)
        .getAttribute("data-cad-rendered-volume"),
    )
    .not.toBeNull();

  // Phase 45/46 panels: standard views, display modes, section toggles.
  for (const id of [
    "camera-standard-views",
    "display-modes",
    "section-clipping",
  ]) {
    const entry = checklist.entries.find((item) => item.id === id);
    const targets = entry?.targets ?? [];
    const first = targets[0] ?? "";
    if (id === "display-modes") {
      expect(await page.locator(first).count()).toBeGreaterThanOrEqual(3);
    } else {
      await expect(page.locator(first).first()).toBeAttached();
    }
  }

  // Phase 56: the import dialog carries the exchange breadth (DXF/SVG-in
  // ride the sketch exchange, surfaced above; DWG/IGES-out are the
  // documented declines, not rows).
  await page.locator('[data-testid="complete-import"]').click();
  await expect(page.locator("[data-cad-import-dialog]")).toBeVisible();
  for (const format of ["stl", "3mf", "obj", "step", "brep", "iges"]) {
    await expect(
      page.locator(`[data-cad-import-format="${format}"]`),
    ).toBeAttached();
  }
  await page.keyboard.press("Escape");

  // The export dialog lists the honest exporter family.
  await page.locator('[data-testid="complete-export"]').click();
  await expect(page.locator("[data-cad-export-dialog]")).toBeVisible();
  for (const format of ["stl", "3mf", "glb"]) {
    await expect(
      page.locator(`[data-testid="cad-export-run-${format}"]`),
    ).toBeAttached();
  }
  await page.keyboard.press("Escape");
});

test("assembly structure panel: occurrences are user-reachable", async ({
  page,
}) => {
  await page.goto("/workbench-assembly");
  const assemblyRoot = page.locator("[data-cad-occurrence-count]").first();
  await expect(assemblyRoot).toBeAttached();
  for (const selector of entriesOf("/workbench-assembly").flatMap(
    (entry) => entry.targets ?? [],
  )) {
    await expect(page.locator(selector)).toBeVisible();
  }
});

test("assembly motion panel: mates, interference, explode, patterns reachable", async ({
  page,
}) => {
  await page.goto("/workbench-assembly-motion");
  await expect(page.locator("[data-cad-hydrated]").first()).toHaveAttribute(
    "data-cad-hydrated",
    "true",
  );
  for (const selector of entriesOf("/workbench-assembly-motion").flatMap(
    (entry) => entry.targets ?? [],
  )) {
    await expect(page.locator(selector).first()).toBeAttached();
  }
});

test("drawings workbench: sheets, annotations, and output panels reachable", async ({
  page,
}) => {
  await page.goto("/drawings");
  await expect(page.locator('[data-testid="drawing-canvas"]')).toBeVisible();

  for (const selector of entriesOf("/drawings").flatMap(
    (entry) => entry.targets ?? [],
  )) {
    await expect(page.locator(selector).first()).toBeVisible();
  }

  // Precondition for the sheet-scoped dialogs (the title block dialog is
  // gated on the sheet furniture existing): the documented journey — the
  // inline "Create sheet" form — mints the first sheet.
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(page.locator('[data-testid="drawing-status"]')).toBeVisible();

  // One dialog-flow proof per dialog family: the named dialogs OPEN.
  for (const [openButton, dialog] of [
    ["drawing-template-open", "drawing-template-dialog"],
    ["drawing-title-open", "drawing-titleblock-dialog"],
    ["drawing-reference-open", "drawing-reference-dialog"],
    ["drawing-revision-open", "drawing-revision-dialog"],
  ] as const) {
    await page.locator(`[data-testid="${openButton}"]`).click();
    await expect(page.locator(`[data-testid="${dialog}"]`)).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
