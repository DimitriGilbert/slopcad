/**
 * Design-shot harness (design-final): captures the judged surfaces across
 * the FULL scheme matrix — four color schemes (machinist, drafting,
 * studios, ember) × both registers (dark, light) — from a BUILT server
 * (the production nitro output served by `node .output/server/index.mjs`),
 * waiting for each surface's settle protocol first. Every surface also
 * gets the workbench floor proof (1280 and the 768 drawer band), the
 * selection chain (midflow), the component spec sheet, and the docs
 * manual, plus the scheme picker itself, open.
 *
 * Usage: npx tsx scripts/design-shots.ts <baseUrl> <outDir> [nameFilter]
 *
 * `nameFilter` keeps only the shots whose name contains it, so one surface
 * can be re-shot across the whole matrix while it is being worked on
 * without paying for the full grid every time.
 */
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:3321";
const outDir = process.argv[3] ?? "design-shots";
const nameFilter = process.argv[4] ?? "";

/** The four shipped schemes (see theme.ts / globals.css). */
const SCHEMES = ["machinist", "drafting", "studios", "ember"] as const;
const REGISTERS = ["dark", "light"] as const;

/** Wait for the complete workbench's settle protocol. */
async function waitWorkbenchSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("workbench-complete-root");
    const volume = root?.getAttribute("data-volume") ?? "";
    const settle = root?.getAttribute("data-cad-rendered-volume") ?? "";
    return volume !== "" && volume === settle;
  });
}

/** Wait for the component preview's settle protocol. */
async function waitComponentSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("component-preview-root");
    const volume = root?.getAttribute("data-volume") ?? "";
    const settle = root?.getAttribute("data-cad-rendered-volume") ?? "";
    return volume !== "" && volume === settle;
  });
}

/** Wait for every docs live example to report ok, and finish animations. */
async function waitDocsReady(page: Page): Promise<void> {
  await page
    .getByTestId("docs-render-status")
    .waitFor({ state: "visible", timeout: 30_000 });
  // Every live example must report ok. The count is deliberately NOT
  // pinned here: the docs manual grows, and a shot harness that fails
  // because a ninth example shipped is a harness that stops being run.
  await page.waitForFunction(() => {
    const statuses = Array.from(
      document.querySelectorAll('[data-testid="docs-example-status"]'),
    );
    return statuses.length > 0 && statuses.every((n) => n.textContent === "ok");
  });
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => animation.finish());
  });
}

type Shot = {
  name: string;
  path: string;
  scheme: (typeof SCHEMES)[number];
  theme: (typeof REGISTERS)[number];
  wait: (page: Page) => Promise<void>;
  viewport?: { width: number; height: number };
  fullPage?: boolean;
  /** Skip the blur step — for shots whose SUBJECT is the focus ring. */
  keepFocus?: boolean;
};

const SHOTS: Shot[] = [];

// The scheme matrix: workbench at the two judged widths, the component
// spec sheet, and the docs manual — every scheme, both registers.
for (const scheme of SCHEMES) {
  for (const theme of REGISTERS) {
    for (const viewport of [
      { width: 1280, height: 800, tag: "1280" },
      { width: 768, height: 900, tag: "768" },
    ]) {
      SHOTS.push({
        name: `workbench-${scheme}-${theme}-${viewport.tag}`,
        path: "/workbench-complete",
        scheme,
        theme,
        viewport: { width: viewport.width, height: viewport.height },
        wait: waitWorkbenchSettled,
      });
    }
    SHOTS.push({
      name: `component-nema17-${scheme}-${theme}`,
      path: "/components/nema17-mount",
      scheme,
      theme,
      viewport: { width: 1280, height: 800 },
      wait: waitComponentSettled,
    });
    // The design-system spec sheet: every token and primitive in every
    // state. The judged proof that ONE ramp serves all four schemes.
    SHOTS.push({
      name: `design-system-${scheme}-${theme}`,
      path: "/design",
      scheme,
      theme,
      viewport: { width: 1280, height: 800 },
      wait: async (page) => {
        await page
          .getByTestId("design-system")
          .waitFor({ state: "visible", timeout: 30_000 });
      },
      fullPage: true,
    });
    SHOTS.push({
      name: `docs-${scheme}-${theme}`,
      path: "/docs",
      scheme,
      theme,
      viewport: { width: 1280, height: 800 },
      wait: waitDocsReady,
      fullPage: true,
    });
    // The front door: the live-render hero, the claim, the surface index.
    SHOTS.push({
      name: `home-${scheme}-${theme}`,
      path: "/",
      scheme,
      theme,
      viewport: { width: 1280, height: 800 },
      wait: async (page) => {
        await page
          .getByText(/^(api: connected|api: disconnected|api: checking)$/)
          .waitFor({ timeout: 30_000 });
        await page.waitForFunction(() => {
          const canvas = document.querySelector("main canvas, canvas");
          return canvas !== null;
        });
      },
    });
    // The public viewer at rest: the share surface's load state, which is
    // what every cold shared link shows first.
    SHOTS.push({
      name: `viewer-${scheme}-${theme}`,
      path: "/viewer",
      scheme,
      theme,
      viewport: { width: 1280, height: 800 },
      wait: async (page) => {
        await page
          .getByTestId("viewer-surface")
          .waitFor({ state: "visible", timeout: 30_000 });
      },
    });
    // (The old `workbench-midflow-*` shot clicked `body|body_plate` in the
    // tree at boot. The complete workbench now boots an EMPTY document
    // behind its onboarding card, so there is no body to select and no
    // such node to click — the shot had been shooting nothing. A selection
    // shot returns with the workbench step, driven by a real authored
    // flow rather than by a body that used to exist at boot.)
  }
}

// The focus treatment, caught in the act: the one thing on the spec sheet
// that cannot be shown at rest. Tabbed to the first tool button, so the
// 2px outline at its 1px offset is in the bytes.
SHOTS.push({
  name: "design-system-focus-machinist-dark",
  path: "/design",
  scheme: "machinist",
  theme: "dark",
  viewport: { width: 1280, height: 800 },
  wait: async (page) => {
    await page
      .getByTestId("design-system")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Idle" }).focus();
  },
  keepFocus: true,
});

// The scheme picker itself, open — machinist dark, the default world.
SHOTS.push({
  name: "scheme-picker-open-machinist-dark",
  path: "/workbench-complete",
  scheme: "machinist",
  theme: "dark",
  viewport: { width: 1280, height: 800 },
  wait: async (page) => {
    await waitWorkbenchSettled(page);
    await page.getByTestId("scheme-picker").click();
    await page
      .getByTestId("scheme-option-studios")
      .waitFor({ state: "visible", timeout: 5_000 });
  },
});

// (The front door used to be shot in the default scheme only. It is a
// judged surface, so it now rides the full matrix above with the others.)

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const planned = SHOTS.filter((shot) => shot.name.includes(nameFilter));
  for (const shot of planned) {
    const context = await browser.newContext({
      viewport: shot.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(
      ({ storedScheme, storedTheme }) => {
        localStorage.setItem("slopcad-scheme", storedScheme);
        localStorage.setItem("slopcad-theme", storedTheme);
      },
      { storedScheme: shot.scheme, storedTheme: shot.theme },
    );
    const page = await context.newPage();
    await page.goto(baseUrl + shot.path);
    await shot.wait(page);
    await page.mouse.move(4, 4);
    if (shot.keepFocus !== true) {
      await page.evaluate(() => {
        const element = document.activeElement;
        if (element instanceof HTMLElement) element.blur();
      });
    }
    await page.waitForTimeout(400);
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
