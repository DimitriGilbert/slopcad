/**
 * Shared helpers for the Phase 30 accessibility workflows: the tab-stop
 * walker behind the focus-order assertions, the capture discipline (the
 * workbench harness's settle-then-shoot protocol), and the artifact
 * persistence for the seven-state visual baselines.
 */

import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

import { waitForSettledScene } from "../e2e-render/helpers";

export { waitForSettledScene };

/** The complete workbench's machine-surface root. */
export const ROOT = "workbench-complete-root";

/**
 * Readiness for the a11y assertions. Chromium gets the full settle
 * protocol (its runs feed the visual baselines). Firefox headless on this
 * machine cannot create a WebGL context — the driver refuses with
 * "AllowWebgl2:false restricts context creation on this system", so the
 * rendered-frame settle stamp never fires — but every a11y assertion
 * rides the DOM and the store, not rendered pixels. For Firefox,
 * readiness is the mounted machine surface: the booted tool state and
 * the parameter panel's derived fields (which exist only once the
 * document has settled numerically).
 */
export async function awaitWorkbenchReady(
  page: Page,
  browserName: string | undefined,
): Promise<void> {
  if (browserName === "chromium") {
    await waitForSettledScene(page, ROOT);
    return;
  }
  await expect(page.locator('[data-slot="cad-status-bar"]')).toBeVisible();
  await expect(page.getByLabel("translate_x", { exact: true })).toBeVisible();
  // The document state has reached the page only when the export action
  // enables (the applied scene exists) — the DOM-level equivalent of the
  // settle gate, and the guard against a disabled Export swallowing a
  // Tab stop or an Enter.
  await expect(page.getByTestId("complete-export")).toBeEnabled();
}

/** One focusable stop in the page's tab order, described for assertions. */
export interface TabStop {
  readonly tag: string;
  readonly testid: string | null;
  readonly toolId: string | null;
  readonly label: string | null;
  readonly fieldLabel: string | null;
  readonly text: string;
}

/** A stable identity for one stop, built from the most specific token. */
export function tabStopKey(stop: TabStop): string {
  return (
    stop.testid ??
    stop.toolId ??
    stop.label ??
    stop.fieldLabel ??
    `${stop.tag}:${stop.text}`
  );
}

/**
 * Walks the page's tab order with the keyboard only, from a cleared
 * focus, until focus wraps back to the body (or `maxStops` presses). The
 * focus-order assertions are derived from this walk — never from DOM
 * order guesses.
 */
export async function collectTabStops(
  page: Page,
  maxStops = 80,
): Promise<TabStop[]> {
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  const stops: TabStop[] = [];
  for (let index = 0; index < maxStops; index += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate<TabStop | null>(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return null;
      const id = element.id;
      const fieldLabel =
        id === ""
          ? null
          : (document
              .querySelector(`label[for="${CSS.escape(id)}"]`)
              ?.textContent?.trim() ?? null);
      return {
        tag: element.tagName.toLowerCase(),
        testid: element.getAttribute("data-testid"),
        toolId: element.getAttribute("data-tool-id"),
        label: element.getAttribute("aria-label"),
        fieldLabel,
        text: (element.textContent ?? "").trim().slice(0, 30),
      };
    });
    if (stop === null) break;
    stops.push(stop);
  }
  return stops;
}

/**
 * Capture discipline (the workbench harness's, verbatim): park the
 * pointer off every surface (no hover fills), drop focus (no caret or
 * focus ring in the frame), let transitions run.
 */
export async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(300);
}

/** Saves an artifact under the a11y artifacts directory. */
export async function saveA11yArtifact(
  name: string,
  bytes: Buffer,
): Promise<void> {
  await mkdir("e2e-artifacts/a11y", { recursive: true });
  await writeFile(`e2e-artifacts/a11y/${name}`, bytes);
}
