/**
 * Floor probe: horizontal-overflow sweep 640-2560 across the color
 * schemes and BOTH workbench modes (model, sketch), plus the
 * pinned-cluster check — after scrolling the sketch tool well to its end,
 * the pinned left group (Model/Extrude/Undo) must still sit inside the
 * viewport. Zero overflow is the contract at every step.
 *
 * Step discipline: schemes share ONE layout system (a scheme swaps color
 * tokens and the corner radius — never metrics), so the DEFAULT scheme
 * (machinist) takes the full 16px-step sweep (the responsive proof tool's
 * own discipline), and the other schemes take a coarse sweep to verify
 * nothing scheme-conditional leaks into layout. The judged widths (768,
 * 900) are always probed explicitly, whatever the step. Pass scheme names
 * as arguments to sweep specific schemes; FLOOR_STEP overrides the step
 * (16 = full, 96 = coarse).
 *
 * Usage: `pnpm --filter web probe:floor` (or `pnpm test:floor-probe`) with
 * the production server already serving; `npx tsx scripts/floor-probe.ts
 * <baseUrl> [scheme ...]` to point elsewhere / narrow the sweep.
 */
import { chromium, type Page } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:3321";

/** The four shipped schemes (see theme.ts / globals.css). */
const ALL_SCHEMES = ["machinist", "drafting", "studios", "ember"] as const;
const requested = process.argv.slice(3);
const SCHEMES = ALL_SCHEMES.filter(
  (scheme) => requested.length === 0 || requested.includes(scheme),
);
/** The default scheme takes the full sweep; the rest stay coarse. */
const STEP = Number(process.env.FLOOR_STEP ?? 16);

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("workbench-complete-root");
    const volume = root?.getAttribute("data-volume") ?? "";
    const settle = root?.getAttribute("data-cad-rendered-volume") ?? "";
    return volume !== "" && volume === settle;
  });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  let totalFailures = 0;

  for (const scheme of SCHEMES) {
    for (const mode of ["dark", "light"] as const) {
      for (const workbenchMode of ["model", "sketch"] as const) {
        console.log(
          `— ${scheme} / ${mode} / ${workbenchMode} mode (${String(STEP)}px steps) —`,
        );
        let failures = 0;
        // The judged widths are ALWAYS probed explicitly: neither grid
        // (16px from 640, 96px coarse) lands on 900, and the coarse grid
        // never lands on 768 either.
        const widths = new Set<number>();
        for (let width = 640; width <= 2560; width += STEP) {
          widths.add(width);
        }
        widths.add(768);
        widths.add(900);
        for (const width of [...widths].sort((a, b) => a - b)) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            deviceScaleFactor: 1,
          });
          await context.addInitScript(
            ({ storedScheme, storedTheme }) => {
              localStorage.setItem("slopcad-theme", storedTheme);
              localStorage.setItem("slopcad-scheme", storedScheme);
            },
            { storedScheme: scheme, storedTheme: mode },
          );
          const page = await context.newPage();
          await page.goto(`${baseUrl}/workbench-complete`);
          await settled(page);
          if (workbenchMode === "sketch") {
            await page.getByTestId("complete-mode-toggle").click();
            await page.waitForTimeout(400);
          }
          const overflow =
            (await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            )) ?? 0;
          if (overflow !== 0) {
            failures += 1;
            console.log(`  ${width}: overflowX=${overflow}`);
          }
          // Pinned-cluster check (sketch only): scroll the tool well hard
          // right; Model/Extrude/Undo must remain inside the viewport.
          if (workbenchMode === "sketch" && width === 768) {
            const well = page.locator('[data-slot="cad-sketch-toolbar"]');
            await well.evaluate((element) => {
              const scroller = element.parentElement;
              if (scroller !== null) {
                scroller.scrollLeft = scroller.scrollWidth;
              }
            });
            await page.waitForTimeout(200);
            for (const testId of [
              "workbench-mode-toggle",
              "sketch-extrude",
              "sketch-undo",
            ]) {
              const box = await page.getByTestId(testId).boundingBox();
              const inside =
                box !== null &&
                box.x >= 0 &&
                box.x + box.width <= width &&
                box.y >= 0;
              if (!inside) {
                failures += 1;
                console.log(
                  `  pinned ${testId}: x=${box?.x.toFixed(0)} outside viewport`,
                );
              }
            }
          }
          await context.close();
        }
        totalFailures += failures;
        console.log(
          failures === 0
            ? "  clean at every step"
            : `  ${String(failures)} failing step(s)/probe(s)`,
        );
      }
    }
  }
  await browser.close();
  if (totalFailures !== 0) {
    console.error(`floor probe: ${String(totalFailures)} failure(s) total`);
    process.exit(1);
  }
  console.log("floor probe: clean across all schemes, registers, and modes");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
