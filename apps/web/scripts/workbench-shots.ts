/**
 * Workbench-shot harness: the cockpit's MEANINGFUL STATES across the full
 * scheme matrix — four colour schemes × both registers, from a BUILT
 * server, with software WebGL so the viewport really renders.
 *
 * `design-shots.ts` shoots the workbench at boot only. The workbench is
 * not a page, it is a state machine, and a re-skin has to be judged in
 * the states an operator actually sits in:
 *
 *   boot      the empty document behind its onboarding card
 *   palette   the command menu open over the cockpit (Ctrl/Cmd+K)
 *   dialog    a feature create dialog open over the cockpit — the forms
 *             surface, which nothing else in the matrix shows
 *   modeled   a real body created through the command menu + its dialog
 *   selected  that body selected in the model tree — the selection chain
 *             lit end to end (tree row, properties, measurement, DRO)
 *   collapsed both rails collapsed to `--rail-w-icon` — the icon-rail
 *             state, which is the layout at every width below 1280 and
 *             one toggle away above it
 *   sketch    the SKETCH workspace, reached the product's own way (the
 *             getting-started card's "Start a sketch") — the editor's
 *             tool strip, its canvas, its inspector and its status band
 *   sketch-family the dimension FAMILY open over that strip: the six
 *             dimension verbs that used to be six words in a wrapping
 *             row. Skipped where the family does not exist (a baseline
 *             capture of an older tree), never faked
 *
 * `modeled` is also shot at the 768 drawer band, the width the floor
 * contract pins.
 *
 * Nothing is injected: every state is reached by driving the product's
 * own command surface, so a moved command id or dialog contract fails the
 * harness instead of producing a pretty lie.
 *
 * Usage: npx tsx scripts/workbench-shots.ts <baseUrl> <outDir> [nameFilter]
 */
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:3321";
const outDir = process.argv[3] ?? "workbench-shots";
const nameFilter = process.argv[4] ?? "";

const SCHEMES = ["machinist", "drafting", "studios", "ember"] as const;
const REGISTERS = ["dark", "light"] as const;

/** The complete workbench's route and its machine-readable root. */
const ROUTE = "/workbench-complete";
const ROOT_ID = "workbench-complete-root";

/** Waits for the settle protocol: the rendered frame matches the document. */
async function waitSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    (rootId) => {
      const root = document.getElementById(rootId);
      const volume = root?.getAttribute("data-volume") ?? "";
      const settled = root?.getAttribute("data-cad-rendered-volume") ?? "";
      return volume !== "" && volume === settled;
    },
    ROOT_ID,
    { timeout: 120_000 },
  );
}

async function openCommandMenu(page: Page): Promise<void> {
  await page.getByTestId("complete-command-menu-trigger").click();
  await page.waitForFunction(
    (rootId) =>
      document
        .getElementById(rootId)
        ?.getAttribute("data-command-menu-open") === "true",
    ROOT_ID,
    { timeout: 30_000 },
  );
}

async function shoot(page: Page, name: string, taken: string[]): Promise<void> {
  if (!name.includes(nameFilter)) return;
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  taken.push(name);
  console.log(`captured ${name}`);
}

async function walk(
  browser: Browser,
  scheme: (typeof SCHEMES)[number],
  register: (typeof REGISTERS)[number],
  width: number,
  states: readonly string[],
  taken: string[],
): Promise<void> {
  const suffix = `${scheme}-${register}-${String(width)}`;
  const context = await browser.newContext({
    viewport: { width, height: width === 768 ? 900 : 800 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(
    ({ storedScheme, storedTheme }) => {
      localStorage.setItem("slopcad-scheme", storedScheme);
      localStorage.setItem("slopcad-theme", storedTheme);
    },
    { storedScheme: scheme, storedTheme: register },
  );
  const page = await context.newPage();
  await page.goto(baseUrl + ROUTE);
  await waitSettled(page);

  if (states.includes("boot")) {
    await shoot(page, `workbench-boot-${suffix}`, taken);
  }

  if (states.includes("palette")) {
    await openCommandMenu(page);
    await shoot(page, `workbench-palette-${suffix}`, taken);
    await page.keyboard.press("Escape");
  }

  if (
    states.includes("dialog") ||
    states.includes("modeled") ||
    states.includes("selected")
  ) {
    // A real body, authored through the product's own affordance: the
    // onboarding card's "Add a box" opens the box feature dialog (the
    // command menu's vocabulary carries operations, not primitives).
    await page.getByTestId("workbench-sketch-hint-primitive").click();
    const dialog = page.getByTestId("feature-form-dialog");
    await dialog.waitFor({ timeout: 30_000 });
    if (states.includes("dialog")) {
      await shoot(page, `workbench-dialog-${suffix}`, taken);
    }
    await dialog
      .getByRole("button", { name: "Create" })
      .click({ timeout: 30_000 });
    await waitSettled(page);
    if (states.includes("modeled")) {
      await shoot(page, `workbench-modeled-${suffix}`, taken);
    }

    if (states.includes("selected") || states.includes("collapsed")) {
      // The selection chain: a body row picked in the model tree.
      const bodyRow = page.locator("[data-node-key^='body|']").first();
      await bodyRow.click({ timeout: 30_000 });
      await waitSettled(page);
      if (states.includes("selected")) {
        await shoot(page, `workbench-selected-${suffix}`, taken);
      }
    }

    if (states.includes("collapsed")) {
      // The rails' collapsed state, reached through the product's own
      // toggles — the same two controls an operator presses.
      await page.getByTestId("workbench-toggle-tree").click();
      await page.getByTestId("workbench-toggle-panels").click();
      await shoot(page, `workbench-collapsed-${suffix}`, taken);
    }
  }

  // The sketch workspace, entered the way the product teaches it: the
  // getting-started card's own verb. It gets its OWN context (see main):
  // that card retires the moment the document carries a feature, so it
  // cannot share a walk with the modelling states.
  if (states.includes("sketch") || states.includes("sketch-family")) {
    await page.getByTestId("workbench-sketch-hint-start").click();
    await page.waitForFunction(
      (rootId) =>
        document.getElementById(rootId)?.getAttribute("data-sketch-mode") ===
        "sketch",
      ROOT_ID,
      { timeout: 30_000 },
    );
    await page.locator("#sketch-root").waitFor({ timeout: 30_000 });
    if (states.includes("sketch")) {
      await shoot(page, `workbench-sketch-${suffix}`, taken);
    }
    if (states.includes("sketch-family")) {
      // The dimension family's chevron — absent in a pre-step-4 tree,
      // where the six dimension verbs are six separate word buttons.
      const family = page.getByTestId("sketch-family-dimension");
      if ((await family.count()) > 0) {
        await family.click();
        await page.waitForTimeout(200);
        await page.screenshot({
          path: `${outDir}/workbench-sketch-family-${suffix}.png`,
        });
        taken.push(`workbench-sketch-family-${suffix}`);
        console.log(`captured workbench-sketch-family-${suffix}`);
        await page.keyboard.press("Escape");
      }
    }
  }

  await context.close();
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const taken: string[] = [];
  for (const scheme of SCHEMES) {
    for (const register of REGISTERS) {
      await walk(
        browser,
        scheme,
        register,
        1280,
        ["boot", "palette", "dialog", "modeled", "selected", "collapsed"],
        taken,
      );
      // Its own context: the getting-started card is the product's own
      // way into a sketch, and it retires the moment the document carries
      // a feature — so the sketch states cannot ride the modelling walk.
      await walk(
        browser,
        scheme,
        register,
        1280,
        ["sketch", "sketch-family"],
        taken,
      );
      await walk(browser, scheme, register, 768, ["modeled"], taken);
    }
  }
  await browser.close();
  console.log(`${String(taken.length)} shots in ${outDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
