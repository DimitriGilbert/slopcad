/**
 * Shared helpers for the Phase 11.3/12 render e2e specs: the settle-protocol
 * waits, byte-artifact persistence, and the Phase 12 selection-surface
 * readers (face anchors, selection JSON, highlight settle). Specs must
 * derive every clicked point from the fixture's face-anchor surface — no
 * guessed pixels.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Same settle budget the previous `waitForFunction` default provided. */
const SETTLE_TIMEOUT_MS = 30_000;
/** Driver-side poll cadence while the scene is still churning. */
const SETTLE_POLL_MS = 50;

/** One read of the fixture's state surface (attribute values or absence). */
interface SettleState {
  readonly inFlight: string | null;
  readonly applied: string | null;
  readonly current: string | null;
  readonly volume: string | null;
  readonly rendered: string | null;
}

type SettleStatus =
  | { readonly settled: true; readonly volume: string }
  | { readonly settled: false; readonly numericSettled: boolean };

function classifySettle(state: SettleState): SettleStatus {
  const volume = state.volume;
  if (volume === null || volume === "") {
    return { settled: false, numericSettled: false };
  }
  const numericSettled =
    state.inFlight === "0" &&
    state.applied !== null &&
    state.applied !== "" &&
    state.applied === state.current;
  if (!numericSettled) {
    return { settled: false, numericSettled: false };
  }
  const rendered = state.rendered;
  if (rendered !== null && rendered !== "" && rendered === volume) {
    return { settled: true, volume };
  }
  // Numeric surface quiescent, settle stamp not caught up yet.
  return { settled: false, numericSettled: true };
}

async function forceAnimationFrame(page: Page): Promise<void> {
  // Frame nudge for rAF starvation: a loaded headless browser can stop
  // servicing requestAnimationFrame entirely, leaving R3F's queued demand
  // render (and its settle stamp) unscheduled — a clipped screenshot forces
  // the compositor through a frame, which flushes pending rAF callbacks.
  // Settle semantics are unchanged: the stamp must still agree.
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
}

/**
 * Waits until the fixture's state surface proves a quiescent scene whose
 * pixels provably belong to the displayed numbers: no computation in
 * flight, the visible state at the newest revision, and the scene's
 * settle stamp (`data-cad-rendered-volume`, written by `CadScene`'s
 * onSettled) equal to the settled volume (`data-volume`). Returns the
 * settled volume text. When the numeric state has settled but the stamp
 * has not, the loop nudges a frame (see `forceAnimationFrame`) instead of
 * waiting for one to arrive on its own; genuine non-settlement still
 * fails at the deadline.
 */
export async function waitForSettledScene(page: Page): Promise<string> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let observed: string | SettleState = "the render-root element never appeared";
  while (Date.now() < deadline) {
    const state = await page.evaluate<SettleState | null>(() => {
      const root = document.getElementById("render-root");
      if (root === null) return null;
      return {
        inFlight: root.getAttribute("data-in-flight"),
        applied: root.getAttribute("data-applied-revision"),
        current: root.getAttribute("data-current-revision"),
        volume: root.getAttribute("data-volume"),
        rendered: root.getAttribute("data-cad-rendered-volume"),
      };
    });
    if (state !== null) {
      observed = state;
      const status = classifySettle(state);
      if (status.settled) return status.volume;
      if (status.numericSettled) {
        await forceAnimationFrame(page);
        continue;
      }
    }
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  throw new Error(
    `The render fixture never settled (last state: ${JSON.stringify(observed)}).`,
  );
}

export async function readVolume(page: Page): Promise<number> {
  const text = await page.locator("#render-volume").textContent();
  const value = Number(text);
  expect(Number.isFinite(value), `#render-volume="${text}"`).toBe(true);
  return value;
}

/** Persist the exact compared bytes so artifacts never diverge from assertions. */
export async function saveArtifact(name: string, bytes: Buffer): Promise<void> {
  await mkdir("e2e-artifacts/render", { recursive: true });
  await writeFile(`e2e-artifacts/render/${name}`, bytes);
}

// ---------------------------------------------------------------------------
// Phase 12 selection surface
// ---------------------------------------------------------------------------

/** The fixture's stable plate body id (`rend_plate` derives from it). */
const PLATE_BODY_ID = "body_plate";

/** One face anchor: viewport CSS pixels + mean normal, from the fixture. */
export interface FaceAnchor {
  readonly point: readonly [number, number];
  /** `null` for closed curved faces (no single normal — e.g. a bore wall). */
  readonly normal: readonly [number, number, number] | null;
}

export interface FaceAnchorSurface {
  readonly [faceKey: string]: FaceAnchor;
}

/**
 * Reads the fixture's face-anchor surface: per synthetic face (keyed
 * `<bodyId>/<faceIndex>`), the CSS-pixel anchor point relative to the
 * viewport's top-left and the face's mean normal.
 */
export async function readFaceAnchors(page: Page): Promise<FaceAnchorSurface> {
  const raw = await page
    .locator("#render-viewport")
    .getAttribute("data-face-anchors");
  expect(raw, "the fixture must publish face anchors").not.toBeNull();
  if (raw === null) throw new Error("unreachable: anchors checked above");
  const parsed = JSON.parse(raw) as FaceAnchorSurface;
  expect(Object.keys(parsed).length, "at least one face anchor").toBeGreaterThan(0);
  return parsed;
}

/**
 * The face whose mean normal matches `target` within a per-component
 * tolerance — the semantic way to address "the top face" without triangle
 * indices. Throws when no face matches (the spec's assumption broke).
 */
export function faceWithNormal(
  anchors: FaceAnchorSurface,
  target: readonly [number, number, number],
  tolerance = 0.05,
): { readonly key: string; readonly faceIndex: number; readonly anchor: FaceAnchor } {
  for (const [key, anchor] of Object.entries(anchors)) {
    if (anchor.normal === null) continue;
    const matches =
      Math.abs(anchor.normal[0] - target[0]) <= tolerance &&
      Math.abs(anchor.normal[1] - target[1]) <= tolerance &&
      Math.abs(anchor.normal[2] - target[2]) <= tolerance;
    if (matches) {
      const faceIndex = Number(key.split("/")[1]);
      expect(Number.isInteger(faceIndex), `face key "${key}"`).toBe(true);
      return { key, faceIndex, anchor };
    }
  }
  throw new Error(
    `No face anchor with normal [${target.join(", ")}] in [${Object.keys(anchors).join(", ")}].`,
  );
}

/** Canonical selection key of a synthetic face reference (spec-side form). */
export function faceSelectionKey(
  revision: number,
  faceIndex: number,
  bodyId = PLATE_BODY_ID,
): string {
  return `face|${bodyId}|${String(revision)}|${String(faceIndex)}`;
}

/** Canonical selection key of a body reference (spec-side form). */
export function bodySelectionKey(bodyId = PLATE_BODY_ID): string {
  return `body|${bodyId}`;
}

/**
 * Waits until the DOM surface shows `expectedKey` as the selection AND the
 * scene's settle probe reports the same key — the first demand frame that
 * actually CARRIED that selection (the highlight-layer settle protocol) —
 * then waits two animation frames so the screenshot provably samples the
 * frame after the highlight was drawn.
 */
export async function waitForSelectionFrame(
  page: Page,
  expectedKey: string,
): Promise<void> {
  await page.waitForFunction((key) => {
    const root = document.getElementById("render-root");
    return (
      root !== null &&
      root.getAttribute("data-selection-key") === key &&
      root.getAttribute("data-cad-selection-frame") === key
    );
  }, expectedKey);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

/** The selected references as the fixture serialized them (parsed JSON). */
export async function readSelection(page: Page): Promise<unknown[]> {
  const raw = await page.locator("#render-root").getAttribute("data-selection");
  expect(raw, "the fixture must publish the selection JSON").not.toBeNull();
  if (raw === null) throw new Error("unreachable: selection checked above");
  return JSON.parse(raw) as unknown[];
}

/** The hovered reference's serialized JSON, or "" when nothing is hovered. */
export async function readHover(page: Page): Promise<string> {
  const raw = await page.locator("#render-root").getAttribute("data-hover");
  expect(raw).not.toBeNull();
  if (raw === null) throw new Error("unreachable: hover checked above");
  return raw;
}

/** The regeneration the domain selection state currently stands at. */
export async function readSelectionRegeneration(page: Page): Promise<number> {
  const raw = await page
    .locator("#render-root")
    .getAttribute("data-selection-regeneration");
  const value = Number(raw);
  expect(Number.isInteger(value) && value >= 0, `regeneration="${String(raw)}"`).toBe(true);
  return value;
}

/** Keyboard modifiers Playwright accepts for a click. */
type ClickModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

/** Clicks the viewport at a face anchor's CSS-pixel point. */
export async function clickFaceAnchor(
  page: Page,
  anchor: FaceAnchor,
  modifiers: readonly ClickModifier[] = [],
): Promise<void> {
  await page.locator("#render-viewport canvas").click({
    position: { x: anchor.point[0], y: anchor.point[1] },
    modifiers: [...modifiers],
  });
}
