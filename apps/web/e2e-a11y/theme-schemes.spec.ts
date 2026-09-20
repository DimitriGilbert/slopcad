import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { SCHEMES } from "../src/theme";

/**
 * Scheme × register coverage for the three judged surfaces (the default
 * world — Machinist dark — is covered by every other suite; the harnesses
 * pin it). This is NOT a second baseline corpus: one parametrized pass per
 * scheme, register, and surface that (a) forces the persisted scheme and
 * register, (b) proves both actually applied to the document root, (c)
 * probes the computed token PAIRS for WCAG AA contrast in the rendered
 * page, and (d) files a screenshot artifact under `e2e-artifacts/a11y/`
 * for human eyes. All four schemes ship in BOTH registers — the scheme
 * picker's contract — so the sweep is 4 × 2 per surface.
 *
 * Chromium only: the probes and the artifact are deterministic on one
 * engine; Firefox headless on this machine cannot create the WebGL
 * context the workbench settle gate rides (see helpers.awaitWorkbenchReady).
 */

/** The judged surfaces, with their settle root (null = DOM-ready is
 * enough; the docs page carries no settle stamp). */
const SURFACES = [
  {
    name: "workbench-complete",
    path: "/workbench-complete",
    root: "workbench-complete-root",
  },
  {
    name: "component-catalog",
    path: "/components/nema17-mount",
    root: "component-preview-root",
  },
  { name: "docs", path: "/docs", root: null },
] as const;

/** Token pairs probed on every surface: [fg token, bg token, minimum]. */
const CONTRAST_PAIRS: readonly [string, string, number][] = [
  ["--foreground", "--background", 4.5],
  ["--muted-foreground", "--background", 4.5],
  ["--foreground", "--card", 4.5],
  ["--muted-foreground", "--card", 4.5],
  ["--primary-foreground", "--primary", 4.5],
  ["--accent-foreground", "--accent", 4.5],
  ["--signal", "--background", 4.5],
  ["--status-ok", "--background", 4.5],
  ["--status-parked", "--background", 4.5],
  ["--destructive", "--background", 4.5],
];

/** Reads a CSS custom property's computed value from the page root. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (property) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue(property)
        .trim(),
    name,
  );
}

/** WCAG contrast ratio of two computed color strings (rgb()/oklch()). */
async function contrast(page: Page, fg: string, bg: string): Promise<number> {
  return page.evaluate(
    ([a = "", b = ""]): number => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      const lum = (color: string): number => {
        ctx.fillStyle = "#000";
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const channels = [...ctx.getImageData(0, 0, 1, 1).data].map(
          (channel) => channel / 255,
        );
        const linear = (c: number): number =>
          c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        return (
          0.2126 * linear(channels[0] ?? 0) +
          0.7152 * linear(channels[1] ?? 0) +
          0.0722 * linear(channels[2] ?? 0)
        );
      };
      const l1 = lum(a);
      const l2 = lum(b);
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (hi + 0.05) / (lo + 0.05);
    },
    [fg, bg],
  );
}

/** Saves one artifact under the a11y artifacts directory. */
async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/a11y", { recursive: true });
  await writeFile(`e2e-artifacts/a11y/${name}`, bytes);
}

for (const { id: scheme } of SCHEMES) {
  for (const theme of ["dark", "light"] as const) {
    for (const surface of SURFACES) {
      test(`${scheme} scheme, ${theme} register: ${surface.name} renders with AA token contrast`, async ({
        page,
      }) => {
        test.skip(
          test.info().project.name !== "chromium",
          "the scheme probes and artifacts are deterministic on Chromium only",
        );
        await page.addInitScript(
          ({ storedScheme, storedTheme }) => {
            try {
              window.localStorage.setItem("slopcad-theme", storedTheme);
              window.localStorage.setItem("slopcad-scheme", storedScheme);
            } catch {
              // A stripped context cannot persist; the root-attribute
              // assertions below fail loudly instead.
            }
          },
          { storedScheme: scheme, storedTheme: theme },
        );
        await page.goto(surface.path, { waitUntil: "networkidle" });
        if (surface.root !== null) {
          await page.waitForFunction(
            (id) =>
              Number(
                document
                  .getElementById(id)
                  ?.getAttribute("data-rendered-frames") ?? "0",
              ) >= 1,
            surface.root,
            { timeout: 30_000 },
          );
        }
        await page.waitForTimeout(500);

        // Both axes must actually BE applied on the document root: the
        // register via the dark class, the scheme via data-scheme.
        expect(
          await page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        ).toBe(theme === "dark");
        expect(
          await page.evaluate(() =>
            document.documentElement.getAttribute("data-scheme"),
          ),
        ).toBe(scheme);

        // Every probed token pair must clear its WCAG AA floor.
        for (const [fg, bg, minimum] of CONTRAST_PAIRS) {
          const ratio = await contrast(
            page,
            await token(page, fg),
            await token(page, bg),
          );
          expect(
            ratio,
            `${fg} on ${bg} in ${scheme} ${theme}: ${ratio.toFixed(2)}`,
          ).toBeGreaterThanOrEqual(minimum);
        }

        const bytes = await page.screenshot();
        await saveArtifact(
          `scheme-${scheme}-${theme}-${surface.name}-chromium.png`,
          bytes,
        );
      });
    }
  }
}
