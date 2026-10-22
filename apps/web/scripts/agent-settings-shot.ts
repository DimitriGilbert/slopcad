/**
 * Agent-settings shot harness: drives the REAL workbench on a dev or
 * built server to the open agent settings dialog and screenshots it, so
 * the reworked provider/model surface can be judged like every other
 * cockpit surface. The catalog is a browser-direct models.dev fetch now
 * (BYOK — no auth), so the shot intercepts that URL and serves a
 * models.dev-shaped fixture; `serverProviders` stays tRPC-intercepted.
 *
 * Usage: npx tsx scripts/agent-settings-shot.ts <baseUrl> <outDir>
 *
 * Shoots the dialog open at the two judged widths (1280, the 768 band)
 * in machinist-dark and drafting-light, plus one shot with the model
 * picker open at 1280/machinist-dark.
 */
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:3201";
const outDir = process.argv[3] ?? ".zcode/shots/agent-settings";

/** A `YYYY-MM-DD` date `days` before today — release dates must stay inside the picker's 6-month recency window. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The models.dev-shaped payload the intercepted `api.json` fetch serves —
 * the RAW upstream shape (snake_case fields, `models` keyed by id); the
 * picker filter applies the real vision/recency rules to it.
 */
const CATALOG_PAYLOAD = {
  openai: {
    id: "openai",
    models: {
      "gpt-5.2": {
        limit: { context: 400000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "GPT-5.2",
        release_date: daysAgo(20),
      },
      "gpt-5.1": {
        limit: { context: 400000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "GPT-5.1",
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
        ],
        release_date: daysAgo(50),
      },
      "gpt-5.1-codex": {
        limit: { context: 400000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "GPT-5.1 Codex",
        release_date: daysAgo(50),
      },
      "gpt-4.1": {
        limit: { context: 1047576 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "GPT-4.1",
        release_date: daysAgo(100),
      },
      "gpt-4o": {
        limit: { context: 128000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "GPT-4o",
        release_date: daysAgo(120),
      },
      o3: {
        limit: { context: 200000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "o3",
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
        ],
        release_date: daysAgo(140),
      },
      "o4-mini": {
        limit: { context: 200000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "o4-mini",
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
        ],
        release_date: daysAgo(150),
      },
    },
  },
};

/** The seeded, configured agent (localStorage is the config backend). */
const AGENT_CONFIG = {
  apiKeyByProvider: { openai: "sk-shot-fixture" },
  maxIterations: 5,
  mode: "client",
  modelId: "gpt-5.1",
  openAiCompatibleBaseUrl: null,
  provider: "openai",
  reasoning: null,
  syncEnabled: false,
  systemPrompt: null,
};

type Shot = {
  name: string;
  scheme: string;
  theme: string;
  viewport: { width: number; height: number };
  /** Open the model picker before shooting. */
  openPicker?: boolean;
};

const SHOTS: Shot[] = [
  {
    name: "agent-settings-machinist-dark-1280",
    scheme: "machinist",
    theme: "dark",
    viewport: { height: 800, width: 1280 },
  },
  {
    name: "agent-settings-machinist-dark-768",
    scheme: "machinist",
    theme: "dark",
    viewport: { height: 900, width: 768 },
  },
  {
    name: "agent-settings-drafting-light-1280",
    scheme: "drafting",
    theme: "light",
    viewport: { height: 800, width: 1280 },
  },
  {
    name: "agent-settings-drafting-light-768",
    scheme: "drafting",
    theme: "light",
    viewport: { height: 900, width: 768 },
  },
  {
    name: "agent-settings-picker-machinist-dark-1280",
    scheme: "machinist",
    theme: "dark",
    viewport: { height: 800, width: 1280 },
    openPicker: true,
  },
];

/** Wait for the complete workbench's settle protocol. */
async function waitWorkbenchSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("workbench-complete-root");
    const volume = root?.getAttribute("data-volume") ?? "";
    const settle = root?.getAttribute("data-cad-rendered-volume") ?? "";
    return volume !== "" && volume === settle;
  });
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      viewport: shot.viewport,
    });
    await context.addInitScript(
      ({ agentConfig, storedScheme, storedTheme }) => {
        localStorage.setItem("slopcad-scheme", storedScheme);
        localStorage.setItem("slopcad-theme", storedTheme);
        localStorage.setItem(
          "slopcad.agent.config.v1",
          JSON.stringify(agentConfig),
        );
      },
      {
        agentConfig: AGENT_CONFIG,
        storedScheme: shot.scheme,
        storedTheme: shot.theme,
      },
    );
    const page = await context.newPage();
    // The picker's catalog is the browser's own models.dev fetch — the
    // shot intercepts it with the fixture payload so the surface renders
    // the populated layout without touching the real upstream.
    await page.route("https://models.dev/api.json", async (route) => {
      await route.fulfill({
        body: JSON.stringify(CATALOG_PAYLOAD),
        contentType: "application/json",
        status: 200,
      });
    });
    // serverProviders stays a tRPC query — intercept it so the mode
    // option renders its client-only truth.
    await page.route("**/api/trpc/*", async (route) => {
      const url = new URL(route.request().url());
      const procedures = url.pathname
        .replace(/^.*\/api\/trpc\//, "")
        .split(",");
      const answers = procedures.map((procedure) => {
        // No transformer is configured on the client link: `result.data`
        // is the raw value, not the `{json: value}` envelope.
        if (procedure === "serverProviders") {
          return { result: { data: { allowed: false } } };
        }
        return null;
      });
      if (answers.includes(null)) {
        await route.continue();
        return;
      }
      await route.fulfill({
        body: JSON.stringify(answers),
        contentType: "application/json",
        status: 200,
      });
    });
    await page.goto(`${baseUrl}/workbench-complete`);
    await waitWorkbenchSettled(page);
    // The view switch exists in both rail states — set the chat view
    // first, then expand the rail if it booted collapsed (the 768 band
    // starts in the 44px icon rail): the chat panel only mounts once
    // the rail has width.
    await page.getByTestId("right-sidebar-view-chat").click();
    const settingsButton = page.getByRole("button", {
      name: "Open agent settings",
    });
    try {
      await settingsButton.waitFor({ state: "visible", timeout: 4_000 });
    } catch {
      await page.getByTestId("workbench-toggle-panels").click();
      await settingsButton.waitFor({ state: "visible", timeout: 15_000 });
    }
    await settingsButton.click();
    await page
      .getByTestId("agent-settings-dialog")
      .waitFor({ state: "visible", timeout: 15_000 });
    // Wait for the catalog intercept to resolve so the band reports the
    // cached count and the picker has options.
    await page
      .getByText(/models in the cached catalog/)
      .waitFor({ state: "visible", timeout: 15_000 });
    if (shot.openPicker === true) {
      await page.getByTestId("agent-settings-model-picker").click();
      await page
        .getByPlaceholder("Search models…")
        .waitFor({ state: "visible", timeout: 10_000 });
    }
    await page.mouse.move(4, 4);
    await page.evaluate(() => {
      const element = document.activeElement;
      if (element instanceof HTMLElement) element.blur();
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/${shot.name}.png` });
    await context.close();
    console.log(`captured ${shot.name}`);
  }
  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
