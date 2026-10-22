/**
 * Agent-settings shot harness: drives the REAL workbench on a dev or
 * built server to the open agent settings dialog and screenshots it, so
 * the reworked provider/model surface can be judged like every other
 * cockpit surface. The tRPC catalog queries are intercepted — a
 * populated picker needs a signed-in catalog, and an unauthenticated
 * shot would only ever show the honest error state.
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

/** The catalog entries the intercepted `modelCatalog.list` serves. */
const CATALOG = [
  {
    contextLimit: 400000,
    deprecated: false,
    fetchedAt: "2026-10-07T00:00:00.000Z",
    modelId: "gpt-5.2",
    name: "GPT-5.2",
    provider: "openai",
    reasoningOptions: null,
    releaseDate: "2026-01-15",
    vision: true,
  },
  {
    contextLimit: 400000,
    deprecated: false,
    fetchedAt: "2026-10-07T00:00:00.000Z",
    modelId: "gpt-5.1",
    name: "GPT-5.1",
    provider: "openai",
    reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
    releaseDate: "2025-11-13",
    vision: true,
  },
  {
    contextLimit: 400000,
    deprecated: false,
    fetchedAt: "2026-10-07T00:00:00.000Z",
    modelId: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    provider: "openai",
    reasoningOptions: null,
    releaseDate: "2025-11-13",
    vision: true,
  },
  {
    contextLimit: 1047576,
    deprecated: false,
    fetchedAt: "2026-10-07T00:00:00.000Z",
    modelId: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    reasoningOptions: null,
    releaseDate: "2025-04-14",
    vision: true,
  },
  {
    contextLimit: 128000,
    deprecated: false,
    fetchedAt: "2026-10-07T00:00:00.000Z",
    modelId: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    reasoningOptions: null,
    releaseDate: "2025-05-13",
    vision: true,
  },
  {
    contextLimit: 200000,
    deprecated: false,
    fetchedAt: "2026-10-07T00:00:00.000Z",
    modelId: "o3",
    name: "o3",
    provider: "openai",
    reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
    releaseDate: "2025-04-16",
    vision: true,
  },
  {
    contextLimit: 200000,
    deprecated: false,
    fetchedAt: "2026-10-07T00:00:00.000Z",
    modelId: "o4-mini",
    name: "o4-mini",
    provider: "openai",
    reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
    releaseDate: "2025-04-16",
    vision: true,
  },
];

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
    // A populated picker needs the signed-in catalog cache; intercepting
    // the two queries the sheet mounts keeps the shot honest about
    // layout without standing up an authenticated session.
    await page.route("**/api/trpc/*", async (route) => {
      const url = new URL(route.request().url());
      const procedures = url.pathname
        .replace(/^.*\/api\/trpc\//, "")
        .split(",");
      const answers = procedures.map((procedure) => {
        // No transformer is configured on the client link: `result.data`
        // is the raw value, not the `{json: value}` envelope.
        if (procedure === "modelCatalog.list") {
          return { result: { data: CATALOG } };
        }
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
