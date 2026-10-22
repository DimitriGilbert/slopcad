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
 *   modeled   a real body created through the command menu + its dialog
 *   selected  that body selected in the model tree — the selection chain
 *             lit end to end (tree row, properties, measurement, DRO)
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

  if (states.includes("modeled") || states.includes("selected")) {
    // A real body, authored through the product's own affordance: the
    // onboarding card's "Add a box" opens the box feature dialog (the
    // command menu's vocabulary carries operations, not primitives).
    await page.getByTestId("workbench-sketch-hint-primitive").click();
    await page
      .locator("[role='dialog']")
      .getByRole("button", { name: "Create" })
      .click({ timeout: 30_000 });
    await waitSettled(page);
    if (states.includes("modeled")) {
      await shoot(page, `workbench-modeled-${suffix}`, taken);
    }

    if (states.includes("selected")) {
      // The selection chain: a body row picked in the model tree.
      const bodyRow = page.locator("[data-node-key^='body|']").first();
      await bodyRow.click({ timeout: 30_000 });
      await waitSettled(page);
      await shoot(page, `workbench-selected-${suffix}`, taken);
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
        ["boot", "palette", "modeled", "selected"],
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
