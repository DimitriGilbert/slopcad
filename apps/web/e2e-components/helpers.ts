/**
 * Shared helpers for the Phase 32 component-preview e2e spec: the settle
 * protocol waits (the render harness's discipline, over the preview
 * page's attribute surface) and the byte-artifact persistence.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The preview page's settle root. */
export const ROOT = "#component-preview-root";

/** Same settle budget discipline as the render harness. */
const SETTLE_TIMEOUT_MS = 30_000;
const SETTLE_POLL_MS = 50;

/** One read of the preview page's state surface. */
interface SettleState {
  readonly inFlight: string | null;
  readonly applied: string | null;
  readonly current: string | null;
  readonly volume: string | null;
  readonly expected: string | null;
  readonly rendered: string | null;
}

type SettleStatus =
  | {
      readonly settled: true;
      readonly volume: string;
      readonly expected: string;
    }
  | { readonly settled: false };

function classifySettle(state: SettleState): SettleStatus {
  const volume = state.volume;
  const expected = state.expected;
  if (
    volume === null ||
    volume === "" ||
    expected === null ||
    expected === ""
  ) {
    return { settled: false };
  }
  const numericSettled =
    state.inFlight === "0" &&
    state.applied !== null &&
    state.applied !== "" &&
    state.applied === state.current;
  if (!numericSettled) return { settled: false };
  const rendered = state.rendered;
  if (rendered !== null && rendered !== "" && rendered === volume) {
    return { settled: true, expected, volume };
  }
  return { settled: false };
}

/** Frame nudge for rAF starvation (the render harness's lesson). */
async function forceAnimationFrame(page: Page): Promise<void> {
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
}

/**
 * Waits until the preview page's state surface proves a quiescent build
 * whose pixels provably belong to the displayed numbers (the settle
 * stamp agrees with the settled volume), then returns the settled volume
 * and analytic texts.
 */
export async function waitForSettledPreview(
  page: Page,
): Promise<{ readonly volume: string; readonly expected: string }> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let observed: string | SettleState = "the preview root never appeared";
  while (Date.now() < deadline) {
    const state = await page.evaluate<SettleState | null, string>((id) => {
      const root = document.getElementById(id);
      if (root === null) return null;
      return {
        applied: root.getAttribute("data-applied-revision"),
        current: root.getAttribute("data-current-revision"),
        expected: root.getAttribute("data-expected-volume"),
        inFlight: root.getAttribute("data-in-flight"),
        rendered: root.getAttribute("data-cad-rendered-volume"),
        volume: root.getAttribute("data-volume"),
      };
    }, "component-preview-root");
    if (state !== null) {
      observed = state;
      const status = classifySettle(state);
      if (status.settled) {
        return { expected: status.expected, volume: status.volume };
      }
    }
    await forceAnimationFrame(page);
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  throw new Error(
    `Preview never settled: ${JSON.stringify(observed)} — surface: ${await page
      .locator(ROOT)
      .getAttribute("data-error")}`,
  );
}

/** Saves `bytes` under the components artifact folder. */
export async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/components", { recursive: true });
  await writeFile(`e2e-artifacts/components/${name}`, bytes);
}

/** The viewport's canvas element (the byte-comparable surface). */
export function previewCanvas(page: Page): Locator {
  return page.locator("#component-preview-viewport canvas");
}
