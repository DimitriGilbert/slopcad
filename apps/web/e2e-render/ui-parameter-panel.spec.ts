import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { saveArtifact, sha256, waitForSettledScene } from "./helpers";

/**
 * Phase 15.4 `CadParameterPanel` e2e — the parameter panel's browser gate
 * on the same deterministic harness as the sibling CAD-component specs
 * (production build, SwiftShader, fixed 1280×720 DPR-1). The fixture
 * (`/ui-viewport`) mounts the `@slopcad/ui` CadParameterPanel
 * PROVIDER-DRIVEN beside the model tree (zero props: parameters mirror the
 * store's collection, expression validation is the domain's own
 * parser/evaluator, and applies ride `parameter.set` transactions through
 * the store), so this spec proves the component's own wiring end to end:
 *
 *  - DISPLAY: the panel renders the fixture document's real parameters —
 *    the hole diameter with its canonical unit, the translate components,
 *    the rotate angle in radians, and the expression-driven `volumeHint`
 *    showing the domain's own expression printing — and the initial panel
 *    is byte-stable across two fresh loads (the capture discipline: the
 *    pointer parked, focus dropped, transitions settled);
 *  - EDIT → COMMIT: filling the hole diameter through the form and
 *    submitting issues exactly one canonical `parameter.set` transaction
 *    (read from `data-command-log` — the DOMAIN is the thing that changed)
 *    and the settled volume follows the document (the workbench pattern);
 *    the settled edited-state page is captured under the full-page
 *    discipline (pointer parked, focus dropped, scroll pinned to the page
 *    bottom — the edit path's auto-scroll drift must not reframe the
 *    shot) and is byte-stable through a reload → redo replay;
 *  - INVALID EXPRESSION: submitting `holeDiameter *` surfaces the domain's
 *    structured failure verbatim (`expression/unexpected-end-of-input` with
 *    its message) as a visible field error, issues NOTHING (the command log
 *    stays empty, the volume and frames stay put), and the error state is
 *    captured as a settled screenshot artifact whose bytes differ from the
 *    initial baseline;
 *  - EXPRESSION EDIT: submitting a new expression for `volumeHint`
 *    evaluates it against the document's current values and commits the
 *    RESULTING value as `parameter.set` — the vocabulary's honest
 *    expression-edit path.
 *
 * Byte comparisons use Playwright `Buffer.equals` on panel-element
 * screenshots. Every pixel assertion stands beside a numeric/DOM assertion.
 */

const ROOT = "#ui-viewport-root";
const PANEL = '#ui-param-panel [data-slot="cad-parameter-panel"]';

/** The submit button of the panel's Formedible form. */
function applyButton(page: Page) {
  return page.getByRole("button", { name: "Apply" });
}

/** A panel field by its label — which IS the parameter name (domain data). */
function panelField(page: Page, name: string) {
  return page.getByLabel(name, { exact: true });
}

/** One serialized command-log entry (the store's canonical transaction form). */
interface SerializedCommandLogEntry {
  readonly formatVersion: number;
  readonly commands: readonly {
    readonly type: string;
    readonly id: string;
    readonly value?: {
      readonly dimension: string;
      readonly unit: string;
      readonly value: number;
    };
  }[];
}

/** Reads the fixture root's canonical command log. */
async function readCommandLog(page: Page): Promise<SerializedCommandLogEntry[]> {
  const raw = await page.locator(ROOT).getAttribute("data-command-log");
  expect(raw, "data-command-log must exist").not.toBeNull();
  return JSON.parse(raw ?? "[]") as SerializedCommandLogEntry[];
}

/** Waits until the command log holds exactly `count` entries. */
async function waitForCommandCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    ({ rootId, expected }) => {
      const root = document.getElementById(rootId);
      if (root === null) return false;
      const log = JSON.parse(
        root.getAttribute("data-command-log") ?? "[]",
      ) as unknown[];
      return log.length === expected;
    },
    { rootId: "ui-viewport-root", expected: count },
  );
}

/** Reads the rendered-frames counter (the settled-frame probe). */
async function readRenderedFrames(page: Page): Promise<number> {
  const raw = await page.locator(ROOT).getAttribute("data-rendered-frames");
  const value = Number(raw);
  expect(Number.isInteger(value) && value >= 0, `frames="${String(raw)}"`).toBe(
    true,
  );
  return value;
}

/**
 * Capture discipline for panel element shots: park the pointer off every
 * surface (no hover fills), drop focus (no caret in the inputs), and let
 * the form's CSS transitions run out.
 */
async function settleForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(300);
}

/**
 * Capture discipline for FULL-PAGE shots. The fixture page is taller than
 * the 720px capture window, and the edit path's `fill`/`click` auto-scroll
 * it by a run-dependent amount (scroll-into-view plus history scroll
 * restoration drift a few pixels per replay), so an unpinned page shot
 * frames a DIFFERENT slice of the page every run — the edited-fullpage
 * artifact's historical nondeterminism. Park the pointer, drop focus, pin
 * the scroll to the page bottom (clamped to the maximum scroll, landing
 * the parameter panel — the artifact's subject — fully in frame), then
 * two animation frames plus a short wait so the number-input spinner and
 * focus paints cannot be caught mid-flight.
 */
async function settleFullPageForCapture(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) element.blur();
  });
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
  await page.waitForTimeout(200);
}

/** Buffers shared across this file's tests (one worker, sequential order). */
const shared = {
  /** The settled boot-state panel — the byte baseline. */
  panelBaseline: undefined as Buffer | undefined,
};

test("the panel renders the fixture document's parameters, byte-stably across two loads", async ({
  page,
}) => {
  await page.goto("/ui-viewport");
  await waitForSettledScene(page, "ui-viewport-root");

  // Real document state: five parameters, canonical units from the domain.
  expect(await panelField(page, "holeDiameter").inputValue()).toBe("8");
  expect(await panelField(page, "translate_x").inputValue()).toBe("0");
  expect(await panelField(page, "translate_y").inputValue()).toBe("0");
  expect(await panelField(page, "translate_z").inputValue()).toBe("0");
  expect(await panelField(page, "rotate_z").inputValue()).toBe("0");
  // The expression-driven parameter displays the domain's own printing.
  expect(await panelField(page, "volumeHint").inputValue()).toBe(
    "holeDiameter * 2",
  );

  await expect(
    page.locator(PANEL).getByText("Current value: 8 mm"),
  ).toBeVisible();
  await expect(
    page.locator(PANEL).getByText("Current value: 0 mm"),
  ).toHaveCount(3);
  // The rotate angle reads in the CANONICAL unit of its dimension.
  await expect(
    page.locator(PANEL).getByText("Current value: 0 rad"),
  ).toBeVisible();
  // The expression-driven parameter shows its current cached quantity.
  await expect(
    page.locator(PANEL).getByText("Current value: 16 mm"),
  ).toBeVisible();

  await settleForCapture(page);
  const first = await page.locator(PANEL).screenshot();

  // A fresh load re-derives everything from the document: same panel state,
  // so the same bytes.
  await page.reload();
  await waitForSettledScene(page, "ui-viewport-root");
  await settleForCapture(page);
  const second = await page.locator(PANEL).screenshot();

  expect(
    second.equals(first),
    `run1 sha256=${sha256(first)} vs run2 sha256=${sha256(second)}`,
  ).toBe(true);

  shared.panelBaseline = first;
  await saveArtifact("ui-param-panel-run1.png", first);
  await saveArtifact("ui-param-panel-run2.png", second);
});

test("editing a value through the panel commits parameter.set and settles a new volume", async ({
  page,
}) => {
  await page.goto("/ui-viewport");
  const defaultVolume = await waitForSettledScene(page, "ui-viewport-root");
  const framesBefore = await readRenderedFrames(page);
  expect((await readCommandLog(page)).length).toBe(0);

  await panelField(page, "holeDiameter").fill("6");
  await applyButton(page).click();

  // The DOCUMENT changed first: one canonical command in the log before any
  // pixel settles — the domain is the thing that changed.
  await waitForCommandCount(page, 1);
  const log = await readCommandLog(page);
  expect(log[0]?.commands).toHaveLength(1);
  expect(log[0]?.commands[0]?.type).toBe("parameter.set");
  expect(log[0]?.commands[0]?.id).toBe("param_hole_diameter");
  expect(log[0]?.commands[0]?.value).toEqual({
    dimension: "length",
    unit: "mm",
    value: 6,
  });

  // The panel's mirror followed the commit.
  await expect(
    page.locator(PANEL).getByText("Current value: 6 mm"),
  ).toBeVisible();

  // The executor stand-in followed the document: a settled NEW volume.
  const editedVolume = await waitForSettledScene(page, "ui-viewport-root");
  expect(editedVolume).not.toBe(defaultVolume);
  expect(await readRenderedFrames(page)).toBeGreaterThan(framesBefore);

  await settleFullPageForCapture(page);
  const editedShot = await page.screenshot();
  await saveArtifact("ui-param-panel-edited-fullpage.png", editedShot);

  // The edited-state page must reproduce through a full replay: reload the
  // document, redo the same edit, and the settled capture — same settle
  // discipline, same pinned scroll — must be byte-identical.
  await page.reload();
  await waitForSettledScene(page, "ui-viewport-root");
  await panelField(page, "holeDiameter").fill("6");
  await applyButton(page).click();
  await waitForCommandCount(page, 1);
  expect(await waitForSettledScene(page, "ui-viewport-root")).toBe(
    editedVolume,
  );
  await settleFullPageForCapture(page);
  const editedShotReplay = await page.screenshot();
  expect(
    editedShotReplay.equals(editedShot),
    `edited sha256=${sha256(editedShot)} vs replay sha256=${sha256(editedShotReplay)}`,
  ).toBe(true);
});

test("an invalid expression shows the domain's error state and issues nothing", async ({
  page,
}) => {
  const panelBaseline = shared.panelBaseline;
  expect(
    panelBaseline,
    "the determinism test must establish the panel baseline first",
  ).toBeDefined();
  if (panelBaseline === undefined) {
    throw new Error("unreachable: baseline checked above");
  }

  await page.goto("/ui-viewport");
  const volume = await waitForSettledScene(page, "ui-viewport-root");
  const framesBefore = await readRenderedFrames(page);

  await panelField(page, "volumeHint").fill("holeDiameter *");

  // Live domain validation: the structured failure surfaces as a visible
  // field error AND the Apply button disables — submit is structurally
  // blocked, not merely refused after the fact.
  const error = page
    .locator(PANEL)
    .getByText(
      "expression/unexpected-end-of-input: The expression ended where an operand was expected.",
    );
  await expect(error).toBeVisible();
  await expect(applyButton(page)).toBeDisabled();

  // Nothing was issued and nothing moved: command log, document, pixels.
  await page.waitForTimeout(300);
  expect(await readCommandLog(page)).toEqual([]);
  expect(await waitForSettledScene(page, "ui-viewport-root")).toBe(volume);
  expect(await readRenderedFrames(page)).toBe(framesBefore);

  // The error state is a settled capture whose bytes visibly differ from
  // the initial baseline (the error is IN the pixels, not just the DOM).
  await settleForCapture(page);
  const errorShot = await page.locator(PANEL).screenshot();
  expect(
    errorShot.equals(panelBaseline),
    `error sha256=${sha256(errorShot)} must differ from baseline sha256=${sha256(panelBaseline)}`,
  ).toBe(false);
  await saveArtifact("ui-param-panel-error.png", errorShot);

  // Fixing the expression re-enables Apply; clicking commits the evaluated
  // value: the evaluator resolves holeDiameter (8 mm) against the document
  // and the RESULTING value is committed as parameter.set.
  await panelField(page, "volumeHint").fill("holeDiameter * 3");
  await expect(applyButton(page)).toBeEnabled();
  await applyButton(page).click();
  await waitForCommandCount(page, 1);
  const log = await readCommandLog(page);
  expect(log[0]?.commands[0]?.type).toBe("parameter.set");
  expect(log[0]?.commands[0]?.id).toBe("param_volume_hint");
  expect(log[0]?.commands[0]?.value).toEqual({
    dimension: "length",
    unit: "mm",
    value: 24,
  });
  await expect(error).toHaveCount(0);
});
