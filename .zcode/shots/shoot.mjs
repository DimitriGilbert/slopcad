import { chromium } from "../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3001";
const OUT = process.env.OUT_DIR ?? ".zcode/shots";
mkdirSync(OUT, { recursive: true });

const stage = process.argv[2] ?? "after";
const THEME = process.env.THEME ?? "dark";
const SCHEME = process.env.SCHEME ?? "machinist";
const WIDTH = Number(process.env.WIDTH ?? 1440);
const email = `design-${stage}-${THEME}-${SCHEME}-${Date.now()}@example.com`;
const password = "design-review-passphrase-1";
const name = "Klaas Vermeulen";

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: 900 },
  deviceScaleFactor: 2,
});
await page.addInitScript(
  ([theme, scheme]) => {
    localStorage.setItem("slopcad-theme", theme ?? "dark");
    localStorage.setItem("slopcad-scheme", scheme ?? "machinist");
  },
  [THEME, SCHEME],
);
page.on("pageerror", (err) => console.log("PAGEERROR:", err.message));

const shot = async (label) => {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${OUT}/${stage}-${label}.png` });
  console.log("shot:", `${stage}-${label}.png`, "url:", page.url());
};

// Sign up through the public form.
await page.goto(`${BASE}/login`);
await page.getByLabel("Name").fill(name);
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill(password);
await page.getByRole("button", { name: "Sign Up" }).click();
await page
  .getByRole("heading", { name: "Dashboard" })
  .waitFor({ timeout: 20000 });
await shot("dashboard-empty");

// Projects: empty state, then create one through the form.
await page.goto(`${BASE}/projects`);
await shot("projects-empty");
await page.getByLabel("Project name").fill("Bench vise rebuild");
await page.getByLabel("Description").fill("Jaw plates and the clamp screw");
await page.getByRole("button", { name: "Create project" }).click();
const projectLink = page.locator('[data-testid="project-list"] a', {
  hasText: "Bench vise rebuild",
});
await projectLink.waitFor({ timeout: 15000 });
await page.getByLabel("Project name").fill("Toolmaker block set");
await page.getByRole("button", { name: "Create project" }).click();
const secondLink = page.locator('[data-testid="project-list"] a', {
  hasText: "Toolmaker block set",
});
await secondLink.waitFor({ timeout: 15000 });
await shot("projects-populated");

// Project detail: create a document.
await projectLink.click();
await page.getByRole("heading", { name: "Bench vise rebuild" }).waitFor();
await page.getByLabel("Document name").fill("jaw-plate");
await page.getByRole("button", { name: "Create document" }).click();
await page
  .locator('[data-testid="document-list"] li', { hasText: "jaw-plate" })
  .waitFor({ timeout: 15000 });
await shot("project-detail");

// Dashboard with data on it.
await page.goto(`${BASE}/dashboard`);
await page
  .getByText("Bench vise rebuild")
  .first()
  .waitFor({ timeout: 15000 });
await shot("dashboard-populated");

await browser.close();
console.log("done, account:", email);
