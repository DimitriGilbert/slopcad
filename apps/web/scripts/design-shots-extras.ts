/**
 * Extra evidence shots beyond the scheme matrix: the default scheme's
 * ultrawide self-check (2560, both registers), the scrimmed command
 * palette, the export dialog with its format taxonomy chips, and the
 * login stage — the surfaces the base round proved, re-proven on the
 * final composition.
 *
 * Usage: npx tsx scripts/design-shots-extras.ts <baseUrl> <outDir>
 */
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:3321";
const outDir = process.argv[3] ?? "design-shots";

async function waitWorkbenchSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("workbench-complete-root");
    const volume = root?.getAttribute("data-volume") ?? "";
    const settle = root?.getAttribute("data-cad-rendered-volume") ?? "";
    return volume !== "" && volume === settle;
  });
}

const SHOTS: {
  name: string;
  path: string;
  theme: "dark" | "light";
  viewport?: { width: number; height: number };
  fullPage?: boolean;
  run: (page: Page) => Promise<void>;
}[] = [
  {
    name: "uw-workbench-machinist-dark-2560",
    path: "/workbench-complete",
    theme: "dark",
    viewport: { width: 2560, height: 1080 },
    run: async (page) => {
      await waitWorkbenchSettled(page);
      await page.waitForTimeout(400);
    },
  },
  {
    name: "uw-workbench-machinist-light-2560",
    path: "/workbench-complete",
    theme: "light",
    viewport: { width: 2560, height: 1080 },
    run: async (page) => {
      await waitWorkbenchSettled(page);
      await page.waitForTimeout(400);
    },
  },
  {
    name: "workbench-command-menu-machinist-dark",
    path: "/workbench-complete",
    theme: "dark",
    run: async (page) => {
      await waitWorkbenchSettled(page);
      await page.keyboard.press("Control+k");
      await page
        .getByPlaceholder("Type a command…")
        .waitFor({ state: "visible", timeout: 5_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: "workbench-export-dialog-machinist-dark",
    path: "/workbench-complete",
    theme: "dark",
    run: async (page) => {
      await waitWorkbenchSettled(page);
      await page.getByTestId("complete-export").click();
      await page
        .getByTestId("cad-export-run-stl")
        .waitFor({ state: "visible", timeout: 5_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: "login-machinist-dark",
    path: "/login",
    theme: "dark",
    run: async (page) => {
      // The login stage defaults to its sign-up register.
      await page
        .getByRole("heading", { name: "Create Account" })
        .waitFor({ timeout: 30_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: "login-machinist-light",
    path: "/login",
    theme: "light",
    run: async (page) => {
      await page
        .getByRole("heading", { name: "Create Account" })
        .waitFor({ timeout: 30_000 });
      await page.waitForTimeout(300);
    },
  },
];

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: shot.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript((theme) => {
      localStorage.setItem("slopcad-theme", theme);
      localStorage.setItem("slopcad-scheme", "machinist");
    }, shot.theme);
    const page = await context.newPage();
    await page.goto(baseUrl + shot.path);
    await shot.run(page);
    await page.mouse.move(4, 4);
    await page.evaluate(() => {
      const element = document.activeElement;
      if (element instanceof HTMLElement) element.blur();
    });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${outDir}/${shot.name}.png`,
      fullPage: shot.fullPage === true,
    });
    await context.close();
    console.log(`captured ${shot.name}`);
  }
  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
