/**
 * Shared helpers for the Phase 11.3/12 render e2e specs: the settle-protocol
 * waits, byte-artifact persistence, and the Phase 12 selection-surface
 * readers (face anchors, selection JSON, highlight settle). Specs must
 * derive every clicked point from the fixture's face-anchor surface — no
 * guessed pixels.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
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

/**
 * Frame nudge for rAF starvation: a loaded headless browser can stop
 * servicing requestAnimationFrame entirely, leaving R3F's queued demand
 * render (and its settle stamp) unscheduled — a clipped screenshot forces
 * the compositor through a frame, which flushes pending rAF callbacks.
 * Settle semantics are unchanged: the stamp must still agree. Module-private:
 * this module's settle waits (`waitForSettledScene`,
 * `waitForTreeSelectionFrame`, `waitForImportedMeshSettled`) are its only
 * callers.
 */
async function forceAnimationFrame(page: Page): Promise<void> {
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
export async function waitForSettledScene(
  page: Page,
  rootId = "render-root",
): Promise<string> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let observed: string | SettleState = "the render-root element never appeared";
  while (Date.now() < deadline) {
    const state = await page.evaluate<SettleState | null, string>((id) => {
      const root = document.getElementById(id);
      if (root === null) return null;
      return {
        inFlight: root.getAttribute("data-in-flight"),
        applied: root.getAttribute("data-applied-revision"),
        current: root.getAttribute("data-current-revision"),
        volume: root.getAttribute("data-volume"),
        rendered: root.getAttribute("data-cad-rendered-volume"),
      };
    }, rootId);
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
export async function readFaceAnchors(
  page: Page,
  viewportId = "render-viewport",
): Promise<FaceAnchorSurface> {
  const raw = await page
    .locator(`#${viewportId}`)
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
  rootId = "render-root",
): Promise<void> {
  await page.waitForFunction(({ id, key: expected }) => {
    const root = document.getElementById(id);
    return (
      root !== null &&
      root.getAttribute("data-selection-key") === expected &&
      root.getAttribute("data-cad-selection-frame") === expected
    );
  }, { id: rootId, key: expectedKey });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

/**
 * The highlight-layer settle wait for TREE/PANEL-originated state changes.
 * A viewport pick keeps the pointer over the canvas, whose pointer events
 * keep the compositor servicing frames; a tree or panel pick touches only
 * DOM, so the demand frame that must carry the selection stamp can sit
 * unscheduled under rAF starvation — the exact condition
 * `waitForSettledScene`'s clipped-screenshot nudge exists for. So this
 * polls the fixture's state surface on a timer (never rAF) and nudges a
 * frame per poll until the selection key AND the stamp agree, then samples
 * two animation frames so a screenshot provably lands after the highlight
 * was drawn.
 */
export async function waitForTreeSelectionFrame(
  page: Page,
  expectedKey: string,
  rootId: string,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const matched = await page.evaluate(
      ({ id, expected }) => {
        const root = document.getElementById(id);
        return (
          root !== null &&
          root.getAttribute("data-selection-key") === expected &&
          root.getAttribute("data-cad-selection-frame") === expected
        );
      },
      { id: rootId, expected: expectedKey },
    );
    if (matched) break;
    if (Date.now() > deadline) {
      throw new Error(
        `The selection frame stamp never reached "${expectedKey}".`,
      );
    }
    await forceAnimationFrame(page);
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  await forceAnimationFrame(page);
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
export async function readSelection(
  page: Page,
  rootId = "render-root",
): Promise<unknown[]> {
  const raw = await page
    .locator(`#${rootId}`)
    .getAttribute("data-selection");
  expect(raw, "the fixture must publish the selection JSON").not.toBeNull();
  if (raw === null) throw new Error("unreachable: selection checked above");
  return JSON.parse(raw) as unknown[];
}

/** The hovered reference's serialized JSON, or "" when nothing is hovered. */
export async function readHover(
  page: Page,
  rootId = "render-root",
): Promise<string> {
  const raw = await page.locator(`#${rootId}`).getAttribute("data-hover");
  expect(raw).not.toBeNull();
  if (raw === null) throw new Error("unreachable: hover checked above");
  return raw;
}

/** The regeneration the domain selection state currently stands at. */
export async function readSelectionRegeneration(
  page: Page,
  rootId = "render-root",
): Promise<number> {
  const raw = await page
    .locator(`#${rootId}`)
    .getAttribute("data-selection-regeneration");
  const value = Number(raw);
  expect(Number.isInteger(value) && value >= 0, `regeneration="${String(raw)}"`).toBe(true);
  return value;
}

// ---------------------------------------------------------------------------
// Phase 13 tool surface
// ---------------------------------------------------------------------------

/** One read of the fixture's tool surface (parsed from its data attributes). */
export interface ToolSurface {
  readonly toolId: string;
  readonly phase: string;
  readonly toolState: unknown;
  readonly completion: unknown;
  readonly failure: unknown;
  readonly commandLog: unknown;
  readonly measure: string;
  readonly translate: unknown;
}

/** Reads the fixture's Phase 13 tool surface. */
export async function readToolSurface(
  page: Page,
  rootId = "render-root",
): Promise<ToolSurface> {
  const read = async (attribute: string): Promise<string> => {
    const raw = await page.locator(`#${rootId}`).getAttribute(attribute);
    expect(raw, `${attribute} must exist`).not.toBeNull();
    return raw ?? "";
  };
  const parse = (raw: string): unknown => (raw === "" ? null : JSON.parse(raw));
  return {
    toolId: await read("data-tool-id"),
    phase: await read("data-tool-phase"),
    toolState: parse(await read("data-tool-state")),
    completion: parse(await read("data-tool-completion")),
    failure: parse(await read("data-tool-failure")),
    commandLog: parse(await read("data-command-log")),
    measure: await read("data-measure"),
    translate: parse(await read("data-translate")),
  };
}

/** Activates a tool through the fixture's tool selector and waits for it. */
export async function activateTool(
  page: Page,
  toolId: string,
  rootId = "render-root",
): Promise<void> {
  await page.locator(`#tool-${toolId}`).click();
  await page.waitForFunction(
    ({ id, root }) => {
      const element = document.getElementById(root);
      return (
        element !== null &&
        element.getAttribute("data-tool-id") === id &&
        element.getAttribute("data-tool-phase") === "active"
      );
    },
    { id: toolId, root: rootId },
  );
}

/** Reads the settle counter (the number of rendered projection frames). */
export async function readRenderedFrames(
  page: Page,
  rootId = "render-root",
): Promise<number> {
  const raw = await page
    .locator(`#${rootId}`)
    .getAttribute("data-rendered-frames");
  const value = Number(raw);
  expect(Number.isInteger(value) && value >= 0, `frames="${String(raw)}"`).toBe(true);
  return value;
}

/** Waits until the scene has rendered at least `atLeast` projection frames. */
export async function waitForRenderedFrames(
  page: Page,
  atLeast: number,
  rootId = "render-root",
): Promise<void> {
  await page.waitForFunction(
    ({ count, root }) => {
      const element = document.getElementById(root);
      const frames = Number(element?.getAttribute("data-rendered-frames") ?? "0");
      return frames >= count;
    },
    { count: atLeast, root: rootId },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

/**
 * Waits until the settle stamp proves the frame carrying the CURRENT
 * applied translate offset has rendered — the precise "moved frame" wait
 * (the volume stamp cannot distinguish it: translation is
 * volume-invariant). Then two animation frames, so a screenshot provably
 * samples the frame after the moved geometry was drawn.
 */
export async function waitForRenderedTranslate(
  page: Page,
  rootId = "render-root",
): Promise<void> {
  await page.waitForFunction((id) => {
    const root = document.getElementById(id);
    return (
      root !== null &&
      root.getAttribute("data-cad-rendered-translate") !== null &&
      root.getAttribute("data-cad-rendered-translate") ===
        root.getAttribute("data-translate")
    );
  }, rootId);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

/**
 * Drags from one face anchor to another (pointer down, stepped moves,
 * pointer up) — the translate/rotate gesture the tools consume.
 */
export async function dragFaceAnchorToFaceAnchor(
  page: Page,
  from: FaceAnchor,
  to: FaceAnchor,
  viewportId = "render-viewport",
): Promise<void> {
  const canvas = page.locator(`#${viewportId} canvas`);
  const box = await canvas.boundingBox();
  expect(box, "canvas bounding box").not.toBeNull();
  if (box === null) throw new Error("unreachable: box checked above");
  await page.mouse.move(box.x + from.point[0], box.y + from.point[1]);
  await page.mouse.down();
  await page.mouse.move(
    box.x + to.point[0],
    box.y + to.point[1],
    { steps: 10 },
  );
  await page.mouse.up();
}

/** Keyboard modifiers Playwright accepts for a click. */
type ClickModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

/** Clicks the viewport at a face anchor's CSS-pixel point. */
export async function clickFaceAnchor(
  page: Page,
  anchor: FaceAnchor,
  modifiers: readonly ClickModifier[] = [],
  viewportId = "render-viewport",
): Promise<void> {
  await page.locator(`#${viewportId} canvas`).click({
    position: { x: anchor.point[0], y: anchor.point[1] },
    modifiers: [...modifiers],
  });
}

// ---------------------------------------------------------------------------
// Phase 15.1 pixel-diff localization
// ---------------------------------------------------------------------------

/** A rectangle in element-capture pixels (mask regions and model regions). */
export interface CaptureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The axis-aligned bounds of a set of differing capture pixels. */
export interface DiffBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Where two element captures' pixels differ, mask rectangles applied. */
export interface LocalizedPixelDiff {
  /** Differing pixels inside at least one mask rect (e.g. overlay DOM). */
  readonly masked: number;
  /** Differing pixels outside every mask rect. */
  readonly unmasked: number;
  /** Bounds of the unmasked differing pixels; null when `unmasked` is 0. */
  readonly unmaskedBounds: DiffBounds | null;
}

// ---------------------------------------------------------------------------
// Phase 18 /io mesh import-export surface
// ---------------------------------------------------------------------------

/** One read of the /io fixture's import surface (parsed attributes). */
export interface IoImportSurface {
  readonly source: string;
  readonly triangles: number | null;
  /** The 3dp volume readout (the human-facing surface). */
  readonly volume: string;
  /** The full-precision volume (the semantic assertion surface). */
  readonly volumeExact: string;
  readonly extents: string;
  readonly detail: string;
  readonly error: string;
  /** The imported scene's settle stamp (`data-cad-imported-volume`). */
  readonly rendered: string;
}

/**
 * Reads the /io fixture's import surface: provenance, triangle count,
 * volume readout, extents, flavor/unit detail, error text, and the
 * imported scene's settle stamp. Every Phase 18 semantic assertion reads
 * from these attributes — nothing is asserted from pixels alone.
 */
export async function readIoImportSurface(
  page: Page,
  rootId = "io-root",
): Promise<IoImportSurface> {
  const raw = await page.evaluate((id) => {
    const root = document.getElementById(id);
    return {
      source: root?.getAttribute("data-import-source") ?? null,
      triangles: root?.getAttribute("data-import-triangles") ?? null,
      volume: root?.getAttribute("data-import-volume") ?? null,
      volumeExact: root?.getAttribute("data-import-volume-exact") ?? null,
      extents: root?.getAttribute("data-import-extents") ?? null,
      detail: root?.getAttribute("data-import-detail") ?? null,
      error: root?.getAttribute("data-import-error") ?? null,
      rendered: root?.getAttribute("data-cad-imported-volume") ?? null,
    };
  }, rootId);
  expect(raw.source, "the /io fixture must publish the import surface").not.toBeNull();
  const triangles = raw.triangles === null || raw.triangles === "" ? null : Number(raw.triangles);
  return {
    source: raw.source ?? "",
    triangles,
    volume: raw.volume ?? "",
    volumeExact: raw.volumeExact ?? "",
    extents: raw.extents ?? "",
    detail: raw.detail ?? "",
    error: raw.error ?? "",
    rendered: raw.rendered ?? "",
  };
}

/**
 * The imported-scene settle wait for /io: a DOM-only import (button click,
 * no pointer over either canvas) can leave the demand frame that must
 * carry the settle stamp unscheduled under rAF starvation — the exact
 * condition `waitForTreeSelectionFrame` handles for tree picks. So this
 * polls the fixture's import surface on a timer (never rAF) until the
 * volume readout is published AND the imported scene's settle stamp agrees
 * with it, nudging a frame per poll, then samples two animation frames so
 * a screenshot provably lands after the imported geometry was drawn.
 */
export async function waitForImportedMeshSettled(
  page: Page,
  rootId = "io-root",
): Promise<string> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const state = await page.evaluate((id) => {
      const root = document.getElementById(id);
      return {
        volume: root?.getAttribute("data-import-volume") ?? null,
        rendered: root?.getAttribute("data-cad-imported-volume") ?? null,
      };
    }, rootId);
    if (
      state.volume !== null &&
      state.volume !== "" &&
      state.volume === state.rendered
    ) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The imported mesh never settled (last state: ${JSON.stringify(state)}).`,
      );
    }
    await forceAnimationFrame(page);
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
  return (await readIoImportSurface(page, rootId)).volume;
}

// ---------------------------------------------------------------------------
// Phase 19 /io GLB reference-viewer surface
// ---------------------------------------------------------------------------

/** One read of the /io fixture's GLB viewer surface (parsed attributes). */
export interface IoGlbSurface {
  /** "loaded" once the GLTFLoader parsed the held bytes; "" before. */
  readonly status: string;
  /** Loaded node names + decoded counts, JSON (e.g. one `body_plate`). */
  readonly nodes: string;
  /** The parsed pbrMetallicRoughness material, JSON. */
  readonly material: string;
  /** The decoded soup's full-precision divergence-theorem volume. */
  readonly volumeExact: string;
  /** The decoded soup's extents, the fixtures' `30.000 × …` form. */
  readonly extents: string;
  /** The page's shared error readout (GLB load failures included). */
  readonly error: string;
  /** The loaded scene's settle stamp (`data-cad-glb-volume`). */
  readonly rendered: string;
}

/** Reads the /io fixture's GLB viewer surface from its attributes. */
export async function readIoGlbSurface(
  page: Page,
  rootId = "io-root",
): Promise<IoGlbSurface> {
  const raw = await page.evaluate((id) => {
    const root = document.getElementById(id);
    return {
      status: root?.getAttribute("data-glb-status") ?? null,
      nodes: root?.getAttribute("data-glb-nodes") ?? null,
      material: root?.getAttribute("data-glb-material") ?? null,
      volumeExact: root?.getAttribute("data-glb-volume-exact") ?? null,
      extents: root?.getAttribute("data-glb-extents") ?? null,
      error: root?.getAttribute("data-import-error") ?? null,
      rendered: root?.getAttribute("data-cad-glb-volume") ?? null,
    };
  }, rootId);
  expect(raw.status, "the /io fixture must publish the GLB surface").not.toBeNull();
  return {
    status: raw.status ?? "",
    nodes: raw.nodes ?? "",
    material: raw.material ?? "",
    volumeExact: raw.volumeExact ?? "",
    extents: raw.extents ?? "",
    error: raw.error ?? "",
    rendered: raw.rendered ?? "",
  };
}

/**
 * The GLB viewer settle wait for /io: same discipline as
 * `waitForImportedMeshSettled` — poll on a timer until the loaded soup's
 * 3dp volume is published AND the viewer's settle stamp agrees with it
 * (nudging a frame per poll against rAF starvation), then sample two
 * animation frames so a screenshot provably lands after the loaded GLB was
 * drawn. Returns the settled 3dp volume text.
 */
export async function waitForGlbViewerSettled(
  page: Page,
  rootId = "io-root",
): Promise<string> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const state = await page.evaluate((id) => {
      const root = document.getElementById(id);
      const volumeExact = root?.getAttribute("data-glb-volume-exact") ?? null;
      return {
        volume:
          volumeExact === null || volumeExact === ""
            ? null
            : Number(volumeExact).toFixed(3),
        rendered: root?.getAttribute("data-cad-glb-volume") ?? null,
      };
    }, rootId);
    if (
      state.volume !== null &&
      state.volume !== "" &&
      state.volume === state.rendered
    ) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The GLB viewer never settled (last state: ${JSON.stringify(state)}).`,
      );
    }
    await forceAnimationFrame(page);
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
  return (await readIoGlbSurface(page, rootId)).rendered;
}

/**
 * Pixel-diff localization: decodes two element-capture PNGs IN THE PAGE —
 * the same browser renderer that produced the bytes reads them back via
 * `createImageBitmap` (no spec-side PNG decoder dependency) — and reports
 * where their pixels differ. `masks` (capture-pixel rectangles, e.g.
 * overlay DOM boxes) are counted separately and excluded from the
 * localized bounds, so a surviving unmasked diff proves the canvas itself
 * changed rather than composited DOM chrome. Throws in-page when the two
 * captures' dimensions differ.
 */
export async function diffElementCaptures(
  page: Page,
  first: Buffer,
  second: Buffer,
  masks: readonly CaptureRect[] = [],
): Promise<LocalizedPixelDiff> {
  return page.evaluate<
    LocalizedPixelDiff,
    {
      readonly first: string;
      readonly second: string;
      readonly masks: readonly CaptureRect[];
    }
  >(
    ({ first: firstPng, masks: rects, second: secondPng }) => {
      const decode = async (base64: string): Promise<ImageData> => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: "image/png" }),
        );
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (context === null) {
          throw new Error("decoding captures requires a 2D canvas context");
        }
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const compare = async (): Promise<LocalizedPixelDiff> => {
        const [a, b] = await Promise.all([
          decode(firstPng),
          decode(secondPng),
        ]);
        if (a.width !== b.width || a.height !== b.height) {
          throw new Error(
            `capture size mismatch: ${String(a.width)}x${String(a.height)} vs ${String(b.width)}x${String(b.height)}`,
          );
        }
        let masked = 0;
        let unmasked = 0;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let y = 0; y < a.height; y += 1) {
          for (let x = 0; x < a.width; x += 1) {
            const offset = (y * a.width + x) * 4;
            const differs =
              a.data[offset] !== b.data[offset] ||
              a.data[offset + 1] !== b.data[offset + 1] ||
              a.data[offset + 2] !== b.data[offset + 2] ||
              a.data[offset + 3] !== b.data[offset + 3];
            if (!differs) continue;
            const insideMask = rects.some(
              (rect) =>
                x >= rect.x &&
                x < rect.x + rect.width &&
                y >= rect.y &&
                y < rect.y + rect.height,
            );
            if (insideMask) {
              masked += 1;
              continue;
            }
            unmasked += 1;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
        return {
          masked,
          unmasked,
          unmaskedBounds: unmasked === 0 ? null : { maxX, maxY, minX, minY },
        };
      };
      return compare();
    },
    {
      first: first.toString("base64"),
      masks,
      second: second.toString("base64"),
    },
  );
}

/**
 * A locator's bounding box as a capture-pixel mask rect: translated against
 * `captureBox` (the captured element's page-coordinate box), scaled from
 * CSS to capture pixels (`captureWidthPx` carries the device pixel ratio),
 * and inflated by `inflationPx` so subpixel-antialiased glyph edges at the
 * box boundary cannot leak into the unmasked diff.
 */
export async function locatorMaskRect(
  locator: Locator,
  captureBox: { readonly x: number; readonly y: number; readonly width: number },
  captureWidthPx: number,
  inflationPx = 2,
): Promise<CaptureRect> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("a mask target must have a bounding box");
  }
  const scale = captureWidthPx / captureBox.width;
  return {
    x: (box.x - captureBox.x) * scale - inflationPx,
    y: (box.y - captureBox.y) * scale - inflationPx,
    width: box.width * scale + inflationPx * 2,
    height: box.height * scale + inflationPx * 2,
  };
}
