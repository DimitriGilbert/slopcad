/**
 * App-shot harness: the AUTHENTICATED surfaces across the full scheme
 * matrix — four colour schemes × both registers, from a BUILT server.
 *
 * `design-shots.ts` covers the public surfaces (workbench, docs, viewer,
 * front door, design system). It cannot cover these: the dashboard, the
 * projects shelf, a project's document shelf and the auth stage only
 * exist for a signed-in user, so each combination here signs up its OWN
 * fresh account through the public form and walks the real flow —
 * creating two projects and a document with the product's own Formedible
 * forms — shooting each surface in both its empty and populated state.
 *
 * Nothing is faked: no seeded database, no injected session. If a form
 * contract moves, this harness fails, which is the point.
 *
 * Usage: npx tsx scripts/app-shots.ts <baseUrl> <outDir> [nameFilter]
 *
 * `nameFilter` keeps only the shots whose name contains it (same
 * convention as design-shots.ts).
 */
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:3321";
const outDir = process.argv[3] ?? "app-shots";
const nameFilter = process.argv[4] ?? "";

const SCHEMES = ["machinist", "drafting", "studios", "ember"] as const;
const REGISTERS = ["dark", "light"] as const;

/** The password every throwaway design account shares. */
const PASSWORD = "design-review-passphrase-1";
/** The account's display name — a real-sounding person, not "John Doe". */
const USER_NAME = "Klaas Vermeulen";

/** The two projects the populated states are built from. */
const PROJECTS = [
  { name: "Bench vise rebuild", description: "Jaw plates and the clamp screw" },
  { name: "Toolmaker block set", description: "A 1-2-3 block pair, ground" },
] as const;

const DOCUMENT_NAME = "jaw-plate";

interface Captured {
  readonly name: string;
}

async function shoot(
  page: Page,
  name: string,
  taken: Captured[],
): Promise<void> {
  if (!name.includes(nameFilter)) return;
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  taken.push({ name });
  console.log(`captured ${name}`);
}

/** Walk one scheme × register combination end to end. */
async function walkCombination(
  browser: Browser,
  scheme: (typeof SCHEMES)[number],
  register: (typeof REGISTERS)[number],
  taken: Captured[],
): Promise<void> {
  const suffix = `${scheme}-${register}`;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
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

  // The auth stage, before anything is typed into it.
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("Name").waitFor({ timeout: 30_000 });
  await shoot(page, `login-${suffix}`, taken);

  // SIGN UP through the public form — the real flow, a fresh account.
  //
  // Backoff, deliberately: a production server rate-limits the auth
  // endpoints, and eight sign-ups in a few minutes trips that window. The
  // harness waits it out rather than weakening the server's configuration
  // to make a screenshot convenient.
  const email = `design-${suffix}-${String(Date.now())}@example.com`;
  await page.getByLabel("Name").fill(USER_NAME);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });
  for (let attempt = 1; ; attempt += 1) {
    await page.getByRole("button", { name: "Sign Up" }).click();
    try {
      await dashboardHeading.waitFor({ timeout: 15_000 });
      break;
    } catch (error: unknown) {
      if (attempt >= 4) throw error;
      console.log(`sign-up for ${suffix} refused; waiting out the window`);
      await page.waitForTimeout(45_000);
    }
  }
  await shoot(page, `dashboard-empty-${suffix}`, taken);

  // The projects shelf: empty, then populated through its own form.
  await page.goto(`${baseUrl}/projects`);
  await page
    .getByRole("heading", { name: "Projects" })
    .waitFor({ timeout: 30_000 });
  await shoot(page, `projects-empty-${suffix}`, taken);

  for (const project of PROJECTS) {
    await page.getByLabel("Project name").fill(project.name);
    await page.getByLabel("Description").fill(project.description);
    await page.getByRole("button", { name: "Create project" }).click();
    await page
      .locator('[data-testid="project-list"] a', { hasText: project.name })
      .waitFor({ timeout: 30_000 });
  }
  await shoot(page, `projects-populated-${suffix}`, taken);

  // One project's document shelf: empty, then with a document in it.
  await page
    .locator('[data-testid="project-list"] a', { hasText: PROJECTS[0].name })
    .click();
  await page
    .getByRole("heading", { name: PROJECTS[0].name })
    .waitFor({ timeout: 30_000 });
  await shoot(page, `project-detail-empty-${suffix}`, taken);

  await page.getByLabel("Document name").fill(DOCUMENT_NAME);
  await page.getByRole("button", { name: "Create document" }).click();
  await page
    .locator('[data-testid="document-list"] li', { hasText: DOCUMENT_NAME })
    .waitFor({ timeout: 30_000 });
  await shoot(page, `project-detail-${suffix}`, taken);

  // The dashboard again, now that the workspace has something in it.
  await page.goto(`${baseUrl}/dashboard`);
  await page.getByText(PROJECTS[0].name).first().waitFor({ timeout: 30_000 });
  await shoot(page, `dashboard-populated-${suffix}`, taken);

  await context.close();
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const taken: Captured[] = [];
  for (const scheme of SCHEMES) {
    for (const register of REGISTERS) {
      await walkCombination(browser, scheme, register, taken);
    }
  }
  await browser.close();
  console.log(`${String(taken.length)} shots in ${outDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
