import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";

import {
  dispatchedCount,
  readFaceAnchors,
  waitForImportedMeshSettled,
  waitForSettledScene,
} from "../e2e-render/helpers";
import { createCadWorkbenchSession } from "../src/cad-workbench/session";
import { serializeSessionToNativeText } from "../src/cad-projects/native-document-bridge";
import { VIEWER_FRAME_HEADERS } from "../src/viewer/viewer-frame-policy";
import {
  decodeNativeFromShare,
  encodeNativeForShare,
} from "../src/viewer/share-codec";
import { EXTRUDE_DEFAULT_DEPTH_MM } from "../src/cad-workbench/SketchMode";
import { CHAIN_FILLET_DEFAULT_RADIUS_MM } from "../src/cad-workbench/chain";
import {
  HOLE_DEFAULT_DEPTH_MM,
  HOLE_DEFAULT_DIAMETER_MM,
} from "../src/cad-workbench/hole";
import {
  activateSketchTool,
  annotationsOf,
  assertPngs,
  cameraAttribute,
  cameraMode,
  clickCanvasPoint,
  closeCommandMenu,
  collectDownloads,
  COMPLETE,
  COMPLETE_ROOT,
  DIALOG,
  drawAndExtrudeRod,
  drawPathSpine,
  drawProfileSquare,
  drawRectangle,
  enterSketchMode,
  holeLastExtrusion,
  OCCT_ROOT,
  openCommandMenu,
  openComplete,
  openDialogViaMenu,
  readMenuRowIds,
  readTimeline,
  readWebMcpSnapshot,
  RECT,
  REDO_BUTTON,
  rootAttribute,
  runCommand,
  saveSketch,
  saveThrowawaySketch,
  schemaTypeOf,
  SKETCH,
  submitDialogAndSettle,
  UNDO_BUTTON,
  undoRedoCheckpoint,
  VIEWPORT_COMPLETE,
  volumeNear,
  waitForRootSettle,
} from "./helpers";

/**
 * The EXHAUSTIVE ONE-SESSION journey — one user, one browser context, the
 * whole program walked in order. The stage list is derived mechanically
 * from the Phase 60 command-surface checklist
 * (`e2e-workbench/command-surface.checklist.json`) plus every production
 * route: every command-menu entry, every dialog flow, every panel, every
 * import/export, and every honest decline a user would hit. Nothing is
 * skipped for being minor — the final stage is the COVERAGE GATE, which
 * compares the session's recorded surfaces against the full manifest and
 * the planned route list, and FAILS on any untested path.
 *
 * Reuse discipline: every flow, testid, and numeric pin below is the
 * existing suites' step library (e2e-workbench, e2e, e2e-render,
 * e2e-projects) chained onto one growing document. No new machine
 * surfaces, no invented selectors.
 */

// ---------------------------------------------------------------------------
// The manifest (the spine) and the coverage ledger
// ---------------------------------------------------------------------------

interface ChecklistEntry {
  readonly id: string;
  readonly phase: number;
  readonly kind: "command" | "command-panel" | "panel";
  readonly route: string;
  readonly target?: string;
  readonly targets?: readonly string[];
}

interface ChecklistDoc {
  readonly epoch: string;
  readonly entries: readonly ChecklistEntry[];
  readonly declines: readonly {
    readonly id: string;
    readonly capability: string;
    readonly reason: string;
  }[];
}

const manifest: ChecklistDoc = JSON.parse(
  readFileSync(
    new URL("../e2e-workbench/command-surface.checklist.json", import.meta.url),
    "utf8",
  ),
) as ChecklistDoc;

const ENTRY_IDS = manifest.entries.map((entry) => entry.id);
const DECLINE_IDS = manifest.declines.map((decline) => decline.id);

/** Every production route the session walks, in user order. */
const PLANNED_ROUTES: readonly string[] = [
  "/",
  "/workbench",
  "/workbench-complete",
  "/workbench-complete-occt",
  "/workbench-chain",
  "/workbench-assembly",
  "/workbench-assembly-motion",
  "/workbench-assembly-interference",
  "/workbench-analysis",
  "/drawings",
  "/render",
  "/io",
  "/projects",
  "/viewer",
];

/** The one-process ledger (one worker, serial mode — no cross-process races). */
const ledger = {
  covered: new Set<string>(),
  declines: new Set<string>(),
  routes: new Set<string>(),
  extras: new Set<string>(),
};

const stageTimings: { readonly name: string; readonly seconds: number }[] = [];

function cover(id: string): void {
  ledger.covered.add(id);
}

function recordDecline(id: string): void {
  ledger.declines.add(id);
}

function walk(route: string): void {
  ledger.routes.add(route);
}

function extra(name: string): void {
  ledger.extras.add(name);
}

/** Wraps one stage's body with the timeline bookkeeping. */
async function stage(name: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  await body();
  const seconds = (Date.now() - started) / 1000;
  stageTimings.push({ name, seconds });
  console.log(`[stage] ${name} ${seconds.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// The shared browser session (ONE context, ONE page, serial stages)
// ---------------------------------------------------------------------------

const test = base.extend<object, { sessionPage: Page }>({
  sessionPage: [
    async ({ browser }, use) => {
      // The session's ONE whole-run video. The config's `use.video` does
      // not reach a fixture-built context, so the recording is wired here:
      // the file is finalized when the context closes after the gate.
      const videoOn = process.env.SESSION_VIDEO !== "0";
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        ...(videoOn
          ? {
              recordVideo: {
                dir: "test-results/session-video",
                size: { width: 1280, height: 720 },
              },
            }
          : {}),
      });
      const page = await context.newPage();
      await use(page);
      await context.close();
    },
    { scope: "worker" },
  ],
});

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Shared constants and step-library helpers (the existing suites' surfaces)
// ---------------------------------------------------------------------------

const OCCT = `#${OCCT_ROOT}`;
const TREE = '[data-slot="cad-model-tree"]';
const PROPERTY = '[data-slot="cad-property-panel"]';
const TOOLBAR = '[data-slot="cad-toolbar"]';

/** The eleven workbench WebMCP tools the complete page registers (Phase 7
 * + Phase 2.1 capture + the Phase 2.2 read tools). */
const WORKBENCH_WEBMCP_TOOLS = [
  "cad_get_document_summary",
  "cad_list_commands",
  "cad_run_command",
  "cad_set_parameter",
  "cad_undo",
  "cad_redo",
  "cad_apply_commands",
  "cad_measure",
  "cad_capture_views",
  "cad_get_document",
  "cad_get_diagnostics",
] as const;

/** The ten assembly WebMCP tools the mutable assembly pages (Phase 2.2)
 * register — `/workbench-assembly` and `/workbench-assembly-motion`. */
const ASSEMBLY_WEBMCP_TOOLS = [
  "cad_get_document",
  "cad_get_diagnostics",
  "cad_assembly_add_occurrence",
  "cad_assembly_remove_occurrence",
  "cad_assembly_pattern",
  "cad_assembly_add_mate",
  "cad_assembly_remove_mate",
  "cad_assembly_add_joint",
  "cad_assembly_remove_joint",
  "cad_assembly_check_interference",
] as const;

/** The read-only assembly set the interference fixture page (Phase 2.2)
 * registers — its document is the fixture's constant, so no mutator mints. */
const ASSEMBLY_READONLY_WEBMCP_TOOLS = [
  "cad_get_document",
  "cad_get_diagnostics",
  "cad_assembly_check_interference",
] as const;

/** The projects WebMCP tools the authenticated pages register (Phase 8). */
const PROJECTS_WEBMCP_TOOLS = [
  "projects_list",
  "projects_create",
  "open_document",
] as const;

/** The boot plate's analytic volume (30 × 20 × 10 with the ⌀8 bore). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** The section's analytic area at the plate's mid-height. */
const BOOT_SECTION_AREA = 30 * 20 - Math.PI * 16;

/** The pad/hole/fillet chain formulas (the chain journey's anchors). */
const CHAIN_PAD_VOLUME = (depthMm: number): number =>
  (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * depthMm;
const CHAIN_HOLED_VOLUME = (depthMm: number): number =>
  CHAIN_PAD_VOLUME(depthMm) -
  Math.PI * (HOLE_DEFAULT_DIAMETER_MM / 2) ** 2 * HOLE_DEFAULT_DEPTH_MM;
const CHAIN_FILLETED_VOLUME = (depthMm: number, radiusMm: number): number =>
  CHAIN_HOLED_VOLUME(depthMm) -
  radiusMm * radiusMm * (1 - Math.PI / 4) * depthMm;

/** The OCCT feature anchors (derived in the workbench suite's docblocks). */
const DEG5 = (5 * Math.PI) / 180;
const ROD_VOLUME = Math.PI * 9 * 10;
const DRAFT_TOP_RADIUS = 3 - 10 * Math.tan(DEG5);
const DRAFT_VOLUME =
  (Math.PI * 10 * (9 + 3 * DRAFT_TOP_RADIUS + DRAFT_TOP_RADIUS ** 2)) / 3;
const THICKEN_VOLUME = 90 * Math.PI - 32 * Math.PI;
const SPLIT_VOLUME = 45 * Math.PI;
const RULED_BAND = Math.sin(0.1) / 0.1;
const HELIX_OCCT = 2 * Math.PI * 3 * 3 * 11 * RULED_BAND;
const ISO_THREAD_DEPTH_MM = (5 * Math.sqrt(3)) / 16;
const GROOVE_CENTROID_OFFSET_MM =
  (ISO_THREAD_DEPTH_MM / 3) * ((2 * (1 / 4) + 7 / 8) / (1 / 4 + 7 / 8));
const THREAD_TOOL_VOLUME =
  2 *
  Math.PI *
  6 *
  ((45 * Math.sqrt(3)) / 256) *
  (3 - GROOVE_CENTROID_OFFSET_MM);
const SWEEP_VOLUME = 20 * 20 * 40;
const LOFT_VOLUME_20 = (1400 * 20) / 6;
const LOFT_VOLUME_50 = (1400 * 50) / 6;
const PLATE_60_VOLUME = 60 * 40 * 10;
const PLATE_WITH_HOLE_VOLUME = PLATE_60_VOLUME - Math.PI * 25 * 10;
const TRIMMED_AREA = 10 * 20;
const THICKENED_SHEET_VOLUME = TRIMMED_AREA * 2;

/** The session user identity (a fresh public-flow sign-up per run). */
const SESSION_USER = {
  name: "Session E2E",
  email: `session-e2e-${Date.now()}-${Math.round(Math.random() * 1e6)}@slopcad.dev`,
  password: "supercalifragilistic",
};

// ---------------------------------------------------------------------------
// The agent-chat walk's loopback fixture (PLAN-AGENT-CHAT Phase 6, B1)
// ---------------------------------------------------------------------------

/**
 * The loopback agent-fixture server the harness's supervised webServer
 * boots (`e2e-session/scripts/`): the real production code is pointed at
 * it via `MODEL_CATALOG_URL` (catalog refresh) and
 * `OPENAI_COMPATIBLE_BASE_URL` (client-direct runs AND the server relay),
 * so the walk exercises real code paths with zero external network.
 */
const AGENT_FIXTURE_URL =
  process.env.AGENT_FIXTURE_URL ?? "http://127.0.0.1:3213";

/** The BYO key the walk configures in the browser (never crosses to us). */
const AGENT_FIXTURE_USER_KEY = "user-loopback-key";

/** One chat-completions request the loopback fixture recorded. */
interface AgentFixtureCall {
  readonly index: number;
  readonly authorization: string | null;
  readonly model: string;
  readonly roles: readonly string[];
  readonly declaredTools: boolean;
}

/** One scripted fixture response (exactly the control API's accepted shapes). */
type AgentFixtureResponse =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly message: string;
    };

/** REPLACES the fixture's scripted queue — stages never inherit scripts. */
async function scriptAgentResponses(
  page: Page,
  responses: readonly AgentFixtureResponse[],
): Promise<void> {
  const response = await page.request.post(`${AGENT_FIXTURE_URL}/__script`, {
    data: { replace: true, responses },
  });
  expect(response.ok()).toBeTruthy();
}

/** The fixture server's recorded chat-completions calls, in order. */
async function agentFixtureCalls(page: Page): Promise<AgentFixtureCall[]> {
  const response = await page.request.get(`${AGENT_FIXTURE_URL}/__calls`);
  expect(response.ok()).toBeTruthy();
  const payload: unknown = await response.json();
  const calls = (payload as { calls?: unknown }).calls;
  return Array.isArray(calls) ? (calls as AgentFixtureCall[]) : [];
}

/**
 * The signed-in session's synced conversation titles, through the REAL
 * tRPC list over the session's own cookies (the Phase 3.4 sync push's
 * server-side evidence). Empty until the opt-in sync lands rows.
 */
async function syncedConversationTitles(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/trpc/agentConversations.list");
  if (!response.ok()) {
    return [];
  }
  const payload: unknown = await response.json();
  return collectTitles(payload);
}

/** Deep-collects `title` strings off id-carrying objects (the dto's shape). */
function collectTitles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTitles(entry));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const titles =
    typeof record.title === "string" && typeof record.id === "string"
      ? [record.title]
      : [];
  return [...titles, ...Object.values(record).flatMap(collectTitles)];
}

/** The boot plate's analytic volume with a ⌀`d` bore (mm³). */
const bootPlateVolumeWithHole = (d: number): number =>
  30 * 20 * 10 - Math.PI * (d / 2) ** 2 * 10;

/**
 * Waits until the chat panel's persistence work is visibly settled: the
 * sync line GONE, twice with a beat between (the line can transiently
 * hide between two ops of one completion pass). With the opt-in sync on,
 * every conversation append rides the outbox and this line is the UI's
 * own "there is unsynced work" signal — the store commits at run
 * completion, so navigating while work is pending can tear an in-flight
 * OPFS write (the resume then finds the conversation but not its rows).
 */
async function waitForAgentSyncSettled(page: Page): Promise<void> {
  const line = page.getByTestId("agent-chat-sync-status");
  const hidden = async (): Promise<boolean> =>
    (await line.count()) === 0 || (await line.isVisible()) === false;
  await expect.poll(hidden, { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(400);
  await expect.poll(hidden, { timeout: 15_000 }).toBe(true);
}

/** The serialized `parameter.set` the walk's tool call applies (⌀11 mm). */
const AGENT_SET_HOLE_11 = {
  formatVersion: 1,
  type: "parameter.set",
  id: "param_hole_diameter",
  value: { dimension: "length", unit: "mm", value: 11 },
} as const;

/** A deliberately malformed command (wrong format version — D9's chip). */
const AGENT_BAD_COMMAND = {
  ...AGENT_SET_HOLE_11,
  formatVersion: 99,
} as const;

// ---------------------------------------------------------------------------
// The stages
// ---------------------------------------------------------------------------

test("s01 home route renders the front door", async ({ sessionPage: page }) => {
  await stage("s01 home", async () => {
    await page.goto("/");
    walk("/");
    await expect(
      page.getByRole("heading", {
        name: "Parametric CAD with a document that tells the truth.",
      }),
    ).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.getByText(/^api: (connected|disconnected)$/)).toBeVisible(
      {
        timeout: 10_000,
      },
    );
  });
});

test("s02 the plain workbench models and history round-trips", async ({
  sessionPage: page,
}) => {
  await stage("s02 workbench", async () => {
    walk("/workbench");
    await page.goto("/workbench");
    const volume = await waitForSettledScene(page, "workbench-root");
    expect(Number(volume)).toBeGreaterThan(0);
    await expect(
      page.locator(`${TREE} [data-node-key="body|body_plate"]`),
    ).toBeVisible();

    // MODEL: sketch → extrude lands the analytic pad (the persistence
    // journey's modeling step, on the plain route).
    await page.locator('[data-testid="workbench-mode-toggle"]').click();
    await expect(page.locator(SKETCH)).toBeVisible();
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, RECT.x0, RECT.y0);
    await clickCanvasPoint(page, RECT.x1, RECT.y1);
    const before = await dispatchedCount(page, "workbench-root");
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator("#workbench-root")).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const extruded = await waitForRootSettle(page, "workbench-root", {
      afterDispatch: before,
    });
    // Phase 16 document-scene semantics: the applied scene IS the applied
    // document — the boot plate renders as one body BESIDE the new pad, so
    // the settle is the DOCUMENT volume (plate + pad).
    const analytic =
      BOOT_PLATE_VOLUME + CHAIN_PAD_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM);
    expect(
      volumeNear(Number(extruded), analytic),
      `extruded ${extruded} vs analytic ${String(analytic)}`,
    ).toBe(true);

    // HISTORY: undo reverts to the boot plate, redo restores the pad
    // (the plain workbench's own history group, #history-undo/redo).
    await page.locator("#history-undo").click();
    await expect(page.locator("#workbench-root")).toHaveAttribute(
      "data-scene-kind",
      "plate",
    );
    await waitForRootSettle(page, "workbench-root");
    await page.locator("#history-redo").click();
    await page.waitForFunction(
      () =>
        (
          JSON.parse(
            document
              .getElementById("workbench-root")
              ?.getAttribute("data-feature-timeline") ?? "{}",
          ) as { entries: readonly { kind: string }[] }
        ).entries.some((entry) => entry.kind === "extrude"),
      undefined,
      { timeout: 10_000 },
    );
    await waitForRootSettle(page, "workbench-root");
  });
});

test("s03 complete workbench boots and the menu ships exactly the audited commands", async ({
  sessionPage: page,
}) => {
  await stage("s03 boot + menu closure", async () => {
    walk("/workbench-complete");
    const volume = await openComplete(page);
    expect(Number(volume)).toBeGreaterThan(0);

    // Every boot surface reports honestly (the workflow suite's OPEN gate).
    await expect(
      page.locator(`${TOOLBAR} button[data-tool-id="select"]`),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator(`${TREE} [data-node-key="feature|feat_translate_plate"]`),
    ).toBeVisible();
    await expect(
      page.locator(`${TREE} [data-node-key="feature|feat_rotate_plate"]`),
    ).toBeVisible();
    await expect(
      page.locator(`${TREE} [data-node-key="body|body_plate"]`),
    ).toBeVisible();
    await expect(page.locator(PROPERTY)).toContainText("Nothing selected.");
    await expect(
      page.getByLabel("holeDiameter", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="cad-status-bar"]')).toContainText(
      "tool = select (active)",
    );
    const timeline = await readTimeline(page, COMPLETE_ROOT);
    expect(timeline.entries.map((entry) => entry.kind)).toEqual([
      "translate",
      "rotate",
    ]);
    expect(Number(volume)).toBeCloseTo(BOOT_PLATE_VOLUME, -1);

    // THE MENU CLOSURE: the rendered rows equal the checklist's command
    // set EXACTLY, both directions (the command-surface suite's audit).
    await openCommandMenu(page, COMPLETE_ROOT);
    const domIds = await readMenuRowIds(page);
    await closeCommandMenu(page, COMPLETE_ROOT);
    const checklistCommandIds = manifest.entries
      .filter(
        (entry) =>
          entry.route === "/workbench-complete" &&
          (entry.kind === "command" || entry.kind === "command-panel"),
      )
      .map((entry) => entry.target ?? "");
    expect(
      domIds.filter((id) => !checklistCommandIds.includes(id)),
      "menu rows missing from the checklist",
    ).toEqual([]);
    expect(
      checklistCommandIds.filter((id) => !domIds.includes(id)),
      "checklist commands missing from the menu",
    ).toEqual([]);

    // The local-face-operations DECLINE: no face-op verb row ships — the
    // kernel capability has no workbench verb at this epoch (the audit's
    // recorded finding), so the menu must not pretend otherwise.
    expect(
      domIds.filter((id) =>
        /(^|-)(move-face|delete-face|replace-face|face-op)(-|$)/.test(id),
      ),
      "a face-op verb shipped without an audit entry",
    ).toEqual([]);
    recordDecline("local-face-operations-verb");
  });
});

test("s04 section journey and the camera/display panels on the boot plate", async ({
  sessionPage: page,
}) => {
  await stage("s04 section + camera + display", async () => {
    await openComplete(page);

    // -- SECTION (Phase 46): select the body, enable the section record,
    //    read the analytic face rows, view-cut halves the volume, disable
    //    restores (the section suite's machine-surface assertions).
    await page.locator('[data-node-key="body|body_plate"]').first().click();
    const clipToggle = page.locator('[data-testid="section-clip-toggle"]');
    await expect(clipToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('[data-testid="section-area"]')).toHaveCount(0);

    await clipToggle.click();
    await expect(clipToggle).toHaveAttribute("aria-pressed", "true");
    await waitForRootSettle(page, COMPLETE_ROOT);
    const areaText = await page
      .locator('[data-testid="section-area"]')
      .textContent();
    expect(Number(areaText?.replace(" mm²", ""))).toBeCloseTo(
      BOOT_SECTION_AREA,
      0,
    );
    const centroidText =
      (await page.locator('[data-testid="section-centroid"]').textContent()) ??
      "";
    expect(centroidText).toContain("x 15.000");
    expect(centroidText).toContain("y 10.000");
    expect(centroidText).toContain("z 5.000");

    await page.locator('[data-testid="section-view-toggle"]').click();
    await expect(
      page.locator('[data-testid="section-view-toggle"]'),
    ).toHaveAttribute("aria-pressed", "true");
    await waitForRootSettle(page, COMPLETE_ROOT);
    const cutVolume = Number(
      (await page.locator(COMPLETE).getAttribute("data-cad-rendered-volume")) ??
        "0",
    );
    expect(cutVolume).toBeCloseTo(BOOT_PLATE_VOLUME / 2, -1);
    expect(
      Number(
        (
          await page.locator('[data-testid="section-area"]').textContent()
        )?.replace(" mm²", ""),
      ),
    ).toBeCloseTo(BOOT_SECTION_AREA, 0);

    await clipToggle.click();
    await expect(clipToggle).toHaveAttribute("aria-pressed", "false");
    await waitForRootSettle(page, COMPLETE_ROOT);
    await expect(page.locator('[data-testid="section-area"]')).toHaveCount(0);
    cover("section-clipping");
  });
});

test("s04b the camera panel: orbit, ledger, standard views, convention", async ({
  sessionPage: page,
}) => {
  await stage("s04b camera orbit + views", async () => {
    // -- CAMERA PANEL (Phase 45): the boot overlay defaults off; orbit
    //    takes the camera; reset returns to spec law.
    expect(await rootAttribute(page, "data-viewport-camera-source")).toBe(
      "spec",
    );
    expect(await rootAttribute(page, "data-viewport-display-mode")).toBe(
      "shaded",
    );
    expect(await rootAttribute(page, "data-viewport-convention")).toBe(
      "third-angle",
    );
    expect(await cameraMode(page)).toBe("spec");

    const box = await page
      .locator(`#${VIEWPORT_COMPLETE} canvas`)
      .boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx - 120, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 40, cy - 30, { steps: 6 });
      await page.mouse.up();
    }
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-camera-source"))
      .toBe("user");
    await expect
      .poll(async () => cameraAttribute(page, "commit-count"))
      .toBe("1");
    await page.click('[data-testid="view-reset"]');
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-camera-source"))
      .toBe("spec");

    // Standard views pin the analytic decomposition; the convention flips
    // the ISO corner exactly 90°.
    await page.click('[data-testid="view-front"]');
    await expect.poll(async () => cameraMode(page)).toBe("user");
    expect(Number(await cameraAttribute(page, "azimuth-deg"))).toBe(270);
    expect(Number(await cameraAttribute(page, "elevation-deg"))).toBe(0);
    await page.click('[data-testid="view-top"]');
    await expect
      .poll(async () => cameraAttribute(page, "azimuth-deg"))
      .toBe("0");
    await page.click('[data-testid="view-iso"]');
    const thirdAngleAzimuth = Number(
      await cameraAttribute(page, "azimuth-deg"),
    );
    await page.click('[data-testid="view-convention-toggle"]');
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-convention"))
      .toBe("first-angle");
    await page.click('[data-testid="view-iso"]');
    const firstAngleAzimuth = Number(
      await cameraAttribute(page, "azimuth-deg"),
    );
    expect(Math.abs(firstAngleAzimuth - thirdAngleAzimuth)).toBe(90);
    await page.click('[data-testid="view-convention-toggle"]');
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-convention"))
      .toBe("third-angle");
  });
});

test("s04c fit, projection, and look-at", async ({ sessionPage: page }) => {
  await stage("s04c fit + projection + look-at", async () => {
    // Fit frames the bounds; the projection toggle preserves the pose.
    await page.click('[data-testid="view-front"]');
    await expect.poll(async () => cameraMode(page)).toBe("user");
    await page.click('[data-testid="view-fit"]');
    const fittedDistance = Number(await cameraAttribute(page, "distance-mm"));
    expect(Number(await cameraAttribute(page, "azimuth-deg"))).toBe(270);
    expect(fittedDistance).toBeGreaterThan(0);
    await page.click('[data-testid="view-projection-toggle"]');
    await expect
      .poll(async () => cameraAttribute(page, "projection"))
      .toBe("orthographic");
    await page.click('[data-testid="view-projection-toggle"]');
    await expect
      .poll(async () => cameraAttribute(page, "projection"))
      .toBe("perspective");

    // Look-at declines without a selection, aims with one (the tree pick).
    // The section journey earlier in this session left the body selected:
    // clear it explicitly so the DECLINE precondition is the tested state.
    await runCommand(page, COMPLETE_ROOT, "clear-selection");
    await expect
      .poll(async () =>
        page
          .locator('[data-testid="view-look-at"]')
          .evaluate((element) => (element as HTMLButtonElement).disabled),
      )
      .toBe(true);
    await page.locator(`${TREE} [data-node-key="body|body_plate"]`).click();
    await expect
      .poll(async () =>
        page
          .locator('[data-testid="view-look-at"]')
          .evaluate((element) => (element as HTMLButtonElement).disabled),
      )
      .toBe(false);
    const distanceBefore = await cameraAttribute(page, "distance-mm");
    await page.click('[data-testid="view-look-at"]');
    await expect.poll(async () => cameraMode(page)).toBe("user");
    expect(await cameraAttribute(page, "distance-mm")).toBe(distanceBefore);
    cover("camera-standard-views");
  });
});

test("s04d display modes and the zoom window", async ({
  sessionPage: page,
}) => {
  await stage("s04d display + zoom", async () => {
    // -- DISPLAY MODES: all four flip the display surface and back.
    for (const mode of ["shaded-edges", "wireframe", "hidden-line"] as const) {
      await page.click(`[data-testid="display-mode-${mode}"]`);
      await expect
        .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
        .toBe(mode);
    }
    await page.click('[data-testid="display-mode-shaded"]');
    await expect
      .poll(async () => rootAttribute(page, "data-viewport-display-mode"))
      .toBe("shaded");
    cover("display-modes");

    // Zoom window: arms, drags a quarter window, commits the zoomed camera.
    await page.click('[data-testid="view-front"]');
    await expect.poll(async () => cameraMode(page)).toBe("user");
    const distanceBeforeZoom = Number(
      await cameraAttribute(page, "distance-mm"),
    );
    await page.click('[data-testid="view-zoom-window"]');
    const layer = page.locator('[data-testid="viewport-zoom-window"]');
    await expect(layer).toBeVisible();
    const zoomBox = await layer.boundingBox();
    expect(zoomBox).not.toBeNull();
    if (zoomBox !== null) {
      const zx = zoomBox.x + zoomBox.width / 2;
      const zy = zoomBox.y + zoomBox.height / 2;
      await page.mouse.move(zx - zoomBox.width / 4, zy - zoomBox.height / 4);
      await page.mouse.down();
      await page.mouse.move(zx + zoomBox.width / 4, zy + zoomBox.height / 4, {
        steps: 4,
      });
      await page.mouse.up();
    }
    await expect
      .poll(async () => Number(await cameraAttribute(page, "distance-mm")))
      .toBeCloseTo(distanceBeforeZoom / 2, 0);
    await expect(layer).toHaveCount(0);
  });
});

test("s05 select, inspect, edit, tools, rollback, and the delete refusals", async ({
  sessionPage: page,
}) => {
  await stage("s05 edit + tools + history", async () => {
    await openComplete(page);
    const bootVolume = await waitForRootSettle(page, COMPLETE_ROOT);

    // SELECT/INSPECT: a tree pick derives the body's provenance.
    await page.locator(`${TREE} [data-node-key="body|body_plate"]`).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "body|body_plate",
    );
    await expect(page.locator(PROPERTY)).toContainText("Produced by");

    // EDIT through the parameter panel (one anchored parameter.set).
    const beforeEdit = await dispatchedCount(page, COMPLETE_ROOT);
    await page.getByLabel("holeDiameter", { exact: true }).fill("10");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-hole-diameter",
      "10",
    );
    const editedVolume = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: beforeEdit,
    });
    expect(volumeNear(Number(editedVolume), Number(bootVolume))).toBe(false);
    await expect(page.getByTestId("timeline-summary")).toHaveText("2 valid");

    // HISTORY via the COMMAND MENU rows (base-undo / base-redo).
    await runCommand(page, COMPLETE_ROOT, "undo");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-hole-diameter",
      "8",
    );
    const undone = await waitForRootSettle(page, COMPLETE_ROOT);
    expect(undone).toBe(bootVolume);
    cover("base-undo");
    await runCommand(page, COMPLETE_ROOT, "redo");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-hole-diameter",
      "10",
    );
    await waitForRootSettle(page, COMPLETE_ROOT);
    cover("base-redo");
    // Leave the boot parameter standing (undo the redo checkpoint).
    await page.locator(UNDO_BUTTON).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-hole-diameter",
      "8",
    );
    await waitForRootSettle(page, COMPLETE_ROOT);
  });
});

test("s05b tools: measure, rotate, select through keyboard and menu", async ({
  sessionPage: page,
}) => {
  await stage("s05b tools", async () => {
    // TOOLS: measure arms through the menu, Escape cancels, rotate arms,
    // the toolbar digit re-arms select.
    await runCommand(page, COMPLETE_ROOT, "tool-measure");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-id",
      "measure",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-phase",
      "active",
    );
    cover("base-tool-measure");
    await page
      .locator(`#${VIEWPORT_COMPLETE} [aria-label="CAD viewport"]`)
      .focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-phase",
      "cancelled",
    );
    await runCommand(page, COMPLETE_ROOT, "tool-rotate");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-id",
      "rotate",
    );
    cover("base-tool-rotate");
    await page.locator(`${TOOLBAR} button[data-tool-id="select"]`).focus();
    await page.keyboard.press("1");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-id",
      "select",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-tool-phase",
      "active",
    );
    cover("base-tool-select");
  });
});

test("s05c clear-selection and the rollback point lifecycle", async ({
  sessionPage: page,
}) => {
  await stage("s05c selection + rollback", async () => {
    // CLEAR SELECTION through the menu row.
    await page.locator(`${TREE} [data-node-key="body|body_plate"]`).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "body|body_plate",
    );
    await runCommand(page, COMPLETE_ROOT, "clear-selection");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "",
    );
    cover("base-clear-selection");

    // ROLLBACK: set a rollback point through the timeline gap (the
    // inactive gap button's aria-label is "Roll back after <kind>"; the
    // active marker span carries data-testid="rollback-marker"), then
    // remove it through the menu row.
    await page.locator('button[aria-label^="Roll back after"]').last().click();
    await expect(page.locator('[data-testid="rollback-marker"]')).toBeVisible();
    await expect
      .poll(async () => (await readTimeline(page, COMPLETE_ROOT)).rollback)
      .not.toBeNull();
    await runCommand(page, COMPLETE_ROOT, "clear-rollback");
    await expect(page.locator('[data-testid="rollback-marker"]')).toHaveCount(
      0,
    );
    await expect
      .poll(async () => (await readTimeline(page, COMPLETE_ROOT)).rollback)
      .toBeNull();
    cover("base-clear-rollback");
  });
});

test("s05d delete refusals and the command-vocabulary delete", async ({
  sessionPage: page,
}) => {
  await stage("s05d delete", async () => {
    // The upstream feature's delete REFUSES structurally: the domain's
    // verbatim refusal surfaces and NOTHING is issued (the command log
    // — accumulated across this whole session — stands unchanged).
    const logBeforeRefusal =
      (await page.locator(COMPLETE).getAttribute("data-command-log")) ?? "[]";
    await page
      .locator(`${TREE} [data-node-key="feature|feat_translate_plate"]`)
      .click({ position: { x: 40, y: 12 } });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      "feature|feat_translate_plate",
    );
    await page
      .locator(PROPERTY)
      .getByRole("button", { name: "Delete feature" })
      .click();
    await expect(page.locator(PROPERTY)).toContainText(
      "transaction/command-failed",
    );
    await expect(page.locator(PROPERTY)).toContainText(
      'referenced by feature "feat_rotate_plate"',
    );
    expect(await page.locator(COMPLETE).getAttribute("data-command-log")).toBe(
      logBeforeRefusal,
    );

    // The leaf feature deletes through the command vocabulary; undo
    // restores it exactly.
    await page
      .locator(`${TREE} [data-node-key="feature|feat_rotate_plate"]`)
      .click({ position: { x: 40, y: 12 } });
    await page
      .locator(PROPERTY)
      .getByRole("button", { name: "Delete feature" })
      .click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-command-log",
      /feature\.delete/,
    );
    expect(
      (await readTimeline(page, COMPLETE_ROOT)).entries.map(
        (entry) => entry.kind,
      ),
    ).toEqual(["translate"]);
    await page.locator(UNDO_BUTTON).click();
    expect(
      (await readTimeline(page, COMPLETE_ROOT)).entries.map(
        (entry) => entry.kind,
      ),
    ).toEqual(["translate", "rotate"]);
  });
});

test("s06 sketch workspace, the sketch tools, extrude, and the plain hole", async ({
  sessionPage: page,
}) => {
  await stage("s06 sketch + extrude + hole", async () => {
    await openComplete(page);

    // The SKETCH command boots the workspace with its vocabulary surface.
    await runCommand(page, COMPLETE_ROOT, "sketch");
    await expect(page.locator(`#${COMPLETE_ROOT}`)).toHaveAttribute(
      "data-sketch-mode",
      "sketch",
    );
    await expect(page.locator(SKETCH)).toBeVisible();
    await expect(
      page.locator('[data-slot="cad-sketch-toolbar"]'),
    ).toBeVisible();
    cover("sketch-vocabulary-workspace");
    for (const selector of [
      '[data-testid="sketch-status-solve"]',
      '[data-testid="sketch-status"]',
      '[data-testid="sketch-undo"]',
      '[data-testid="sketch-redo"]',
      '[data-testid="sketch-save"]',
      '[data-testid="sketch-status-message"]',
    ]) {
      await expect(page.locator(selector).first()).toBeAttached();
    }
    cover("sketch-solver-status");
    cover("sketch-editing-operations");

    // THE SKETCH TOOLS: rectangle, line, circle, point all draw; the
    // sketch-local undo/redo then walks the extra entities back out so
    // the profile stays exactly the rectangle for the analytic extrude.
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, RECT.x0, RECT.y0);
    await clickCanvasPoint(page, RECT.x1, RECT.y1);
    await activateSketchTool(page, "line");
    await clickCanvasPoint(page, 40, 0);
    await clickCanvasPoint(page, 45, 5);
    await activateSketchTool(page, "circle");
    await clickCanvasPoint(page, 40, 20);
    await clickCanvasPoint(page, 42, 20);
    await activateSketchTool(page, "point");
    await clickCanvasPoint(page, 45, 25);
    const kinds = async (): Promise<string[]> => {
      const entities = JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-entities")) ??
          "[]",
      ) as { kind: string }[];
      return entities.map((entity) => entity.kind);
    };
    // The rectangle records as one rectangle over its four segment lines
    // (the workflow suite's filter discipline), so the drawn sketch holds
    // the rectangle, the path line, the circle, and the point.
    const drawn = await kinds();
    expect(drawn.filter((kind) => kind === "rectangle").length).toBe(1);
    expect(drawn.filter((kind) => kind === "circle").length).toBe(1);
    expect(drawn.filter((kind) => kind === "point").length).toBe(1);
    expect(drawn.filter((kind) => kind === "line").length).toBe(5);
    // The sketch-local history walks the three extra entities out and back.
    for (let index = 0; index < 3; index += 1) {
      await page.locator('[data-testid="sketch-undo"]').click();
    }
    const trimmed = await kinds();
    expect(trimmed.filter((kind) => kind === "rectangle").length).toBe(1);
    expect(trimmed.filter((kind) => kind === "circle").length).toBe(0);
    expect(trimmed.filter((kind) => kind === "point").length).toBe(0);
    for (let index = 0; index < 3; index += 1) {
      await page.locator('[data-testid="sketch-redo"]').click();
    }
    expect((await kinds()).filter((kind) => kind === "circle").length).toBe(1);
    for (let index = 0; index < 3; index += 1) {
      await page.locator('[data-testid="sketch-undo"]').click();
    }
    expect((await kinds()).filter((kind) => kind === "circle").length).toBe(0);
  });
});

test("s06b extrude the profile and cut the plain hole", async ({
  sessionPage: page,
}) => {
  await stage("s06b extrude + hole", async () => {
    // EXTRUDE: the analytic pad commits (the create journey).
    const before = await dispatchedCount(page, COMPLETE_ROOT);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-sketch-mode",
      "model",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const extruded = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: before,
    });
    // The document scene renders the boot plate beside the pad (Phase 16).
    const analytic =
      BOOT_PLATE_VOLUME + CHAIN_PAD_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM);
    expect(volumeNear(Number(extruded), analytic)).toBe(true);

    // THE PLAIN HOLE bridge cuts the new extrusion.
    const holed = await holeLastExtrusion(page, COMPLETE_ROOT);
    expect(Number(holed)).toBeLessThan(Number(extruded));
    cover("plain-hole-bridge");

    // The timeline carries the whole grown history; undo removes the hole
    // (the scene falls back honestly) and redo restores it.
    const timeline = await readTimeline(page, COMPLETE_ROOT);
    expect(timeline.entries.map((entry) => entry.kind)).toEqual([
      "translate",
      "rotate",
      "extrude",
      "hole",
    ]);
    await undoRedoCheckpoint(page, COMPLETE_ROOT, "hole");
  });
});

test("s07 sketch on a face, pad, and the driving-face edit — geometry follows", async ({
  sessionPage: page,
}) => {
  await stage("s07 sketch-on-face", async () => {
    await openComplete(page);

    // The base extrusion: the same 20×15 rectangle the create journeys
    // draw, parked at x ∈ [40,60] — BESIDE the boot plate's footprint.
    // Phase 16 document-scene re-baseline: the plate renders beside the
    // pad now, and a pad overlapping the plate's footprint would put the
    // two top faces coplanar (the face pick could not distinguish them).
    await enterSketchMode(page);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 40, 10);
    await clickCanvasPoint(page, 60, 25);
    const before = await dispatchedCount(page, COMPLETE_ROOT);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-sketch-mode",
      "model",
    );
    const baseVolume = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: before,
    });
    const baseAnalytic = CHAIN_PAD_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM);
    // The document scene renders the boot plate beside the base pad
    // (Phase 16).
    expect(
      volumeNear(Number(baseVolume), BOOT_PLATE_VOLUME + baseAnalytic),
    ).toBe(true);

    // SELECT the driving face through the published anchor surface. The
    // document scene carries the plate's faces too, so the search filters
    // to the base extrusion's own top face.
    const anchors = await readFaceAnchors(page, COMPLETE_ROOT);
    const topMatches = Object.entries(anchors).filter(([key, anchor]) => {
      if (!key.startsWith("body_extrude/")) return false;
      if (anchor.normal === null) return false;
      return (
        Math.abs(anchor.normal[0]) <= 0.05 &&
        Math.abs(anchor.normal[1]) <= 0.05 &&
        Math.abs(anchor.normal[2] - 1) <= 0.05
      );
    });
    expect(topMatches.length, "exactly one top face on the base pad").toBe(1);
    const topEntry = topMatches[0];
    if (topEntry === undefined) throw new Error("unreachable: top asserted");
    const top = {
      faceIndex: Number(topEntry[0].split("/")[1]),
      anchor: topEntry[1],
    };
    await page
      .locator(`#${VIEWPORT_COMPLETE} canvas`)
      .click({ position: { x: top.anchor.point[0], y: top.anchor.point[1] } });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-selection-key",
      new RegExp(`^face\\|body_extrude\\|\\d+\\|${String(top.faceIndex)}$`),
    );

    // SKETCH ON FACE through the command row: the datum resolves and the
    // editor boots on the face's workplane.
    await runCommand(page, COMPLETE_ROOT, "sketch-on-face");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-sketch-mode",
      "sketch",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-datums",
      /^\[\{.*"resolved":true.*\}\]$/,
    );
    cover("sketch-on-face-verb");

    // EXTRUDE the pad; the composed scene settles at base + pad.
    await drawRectangle(page);
    const beforePad = await dispatchedCount(page, COMPLETE_ROOT);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-sketch-mode",
      "model",
    );
    const padded = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: beforePad,
    });
    // The pad composition unions base + pad (the base body is absorbed);
    // the document scene renders the boot plate beside them (Phase 16).
    expect(
      volumeNear(Number(padded), BOOT_PLATE_VOLUME + baseAnalytic * 2),
    ).toBe(true);

    // EDIT THE DRIVING FACE: the datum origin lifts and the pad follows.
    const beforeEdit = await dispatchedCount(page, COMPLETE_ROOT);
    await page.getByLabel("extrudeDepth", { exact: true }).fill("15");
    await page.getByRole("button", { name: "Apply" }).click();
    const edited = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: beforeEdit,
    });
    expect(
      volumeNear(Number(edited), BOOT_PLATE_VOLUME + baseAnalytic * 2.5),
    ).toBe(true);
    const datums = JSON.parse(
      (await page.locator(COMPLETE).getAttribute("data-datums")) ?? "[]",
    ) as { resolved: boolean; origin: readonly [number, number, number] }[];
    expect(datums).toHaveLength(1);
    expect(datums[0]?.resolved).toBe(true);
    expect(datums[0]?.origin[2]).toBeCloseTo(15, 6);
  });
});

test("s08 honest kernel declines: sweep, helix, and thicken on the default route", async ({
  sessionPage: page,
}) => {
  await stage("s08 declines", async () => {
    await openComplete(page);
    const honestVolume = await waitForRootSettle(page, COMPLETE_ROOT);

    // SWEEP commits, then declines honestly: the structured refusal on the
    // error surface, the pixels unchanged, the timeline chip Failed.
    await enterSketchMode(page);
    await drawProfileSquare(page);
    await saveSketch(page);
    await enterSketchMode(page);
    await drawPathSpine(page);
    await saveSketch(page);
    await openDialogViaMenu(page, COMPLETE_ROOT, "sweep");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 1" }).click();
    await page.locator(`${DIALOG} [role="combobox"]`).nth(1).click();
    await page.getByRole("option", { name: "sketch 2" }).click();
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "sweep",
    );
    await expect(page.locator("#workbench-complete-error")).toContainText(
      "kernel/unsupported-operation",
      { timeout: 30_000 },
    );
    expect(
      await page.locator(COMPLETE).getAttribute("data-cad-rendered-volume"),
    ).toBe(honestVolume);
    const sweepTimeline = await readTimeline(page, COMPLETE_ROOT);
    const sweepEntry = sweepTimeline.entries.find(
      (entry) => entry.kind === "sweep",
    );
    expect(sweepEntry?.status).toBe("failed");
    expect(sweepEntry?.diagnostics?.[0]?.message).toContain(
      "kernel/unsupported-operation",
    );
    cover("sweep-feature");
  });
});

test("s08b honest decline: helix on the default route", async ({
  sessionPage: page,
}) => {
  await stage("s08b helix decline", async () => {
    // HELIX commits and declines the same honest way.
    await enterSketchMode(page);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 0, -0.75);
    await clickCanvasPoint(page, 2, 0.75);
    await saveSketch(page);
    await openDialogViaMenu(page, COMPLETE_ROOT, "helix");
    // The form's default pick is the pool's first sketch (the sweep
    // profile, whose axial extent overlaps turns): pick the meridian —
    // the sketch this stage just saved — explicitly.
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 3", exact: true }).click();
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "helix",
    );
    await expect(page.locator("#workbench-complete-error")).toContainText(
      "kernel/unsupported-operation",
      { timeout: 30_000 },
    );
    const helixTimeline = await readTimeline(page, COMPLETE_ROOT);
    expect(
      helixTimeline.entries.find((entry) => entry.kind === "helix")?.status,
    ).toBe("failed");
    cover("helix-feature");
  });
});

test("s08c honest decline: thicken on the default route", async ({
  sessionPage: page,
}) => {
  await stage("s08c thicken decline", async () => {
    // THICKEN needs a feature-produced extrusion base: draw the rod first.
    await drawAndExtrudeRod(page, COMPLETE_ROOT);
    await openDialogViaMenu(page, COMPLETE_ROOT, "thicken");
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "thicken",
    );
    await expect(page.locator("#workbench-complete-error")).toContainText(
      "kernel/unsupported-operation",
      { timeout: 30_000 },
    );
    const thickenTimeline = await readTimeline(page, COMPLETE_ROOT);
    expect(
      thickenTimeline.entries.find((entry) => entry.kind === "thicken")?.status,
    ).toBe("failed");
    cover("thicken-shell-feature");
  });
});

test("s09 export/import: real bytes, the format breadth, and the sketch exchange", async ({
  sessionPage: page,
}) => {
  await stage("s09 exchange", async () => {
    await openComplete(page);
    const appliedVolume = await waitForRootSettle(page, COMPLETE_ROOT);

    // EXPORT: the dialog lists the honest exporter family — STL holds
    // real, sized bytes; IGES is NOT among them (the documented decline).
    await page.locator('[data-testid="complete-export"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    for (const format of ["stl", "3mf", "glb"]) {
      await expect(
        page.locator(`[data-testid="cad-export-run-${format}"]`),
      ).toBeAttached();
    }
    expect(
      await page.locator('[data-testid="cad-export-run-iges"]').count(),
      "IGES export must not ship (the documented decline)",
    ).toBe(0);
    await page.getByTestId("cad-export-run-stl").click();
    const entry = page.locator('[data-cad-export-entry="stl"]');
    await expect(entry).toContainText("triangles");
    const held = JSON.parse(
      (await page.locator(COMPLETE).getAttribute("data-export-held")) ?? "{}",
    ) as Record<string, number>;
    expect(held.stl).toBeGreaterThan(0);
    cover("base-export");
    recordDecline("iges-export-dwg-import");
    await page.keyboard.press("Escape");

    // IMPORT: the format breadth (STL/3MF/OBJ browser, STEP/BREP worker,
    // IGES meshes) and NO DWG row (the documented decline).
    await page.locator('[data-testid="complete-import"]').click();
    await expect(page.locator("[data-cad-import-dialog]")).toBeVisible();
    for (const format of ["stl", "3mf", "obj", "step", "brep", "iges"]) {
      await expect(
        page.locator(`[data-cad-import-format="${format}"]`),
      ).toBeAttached();
    }
    expect(
      await page.locator('[data-cad-import-format="dwg"]').count(),
      "DWG import must not ship (the documented decline)",
    ).toBe(0);
    cover("exchange-import-formats");

    // The held STL round-trips into the honest geometry preview.
    await page.getByTestId("cad-import-held-stl").click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "false",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "import",
    );
    await page.waitForFunction((rootId) => {
      const root = document.getElementById(rootId);
      const volume = root?.getAttribute("data-import-volume") ?? "";
      const settle = root?.getAttribute("data-cad-imported-volume") ?? "";
      return volume !== "" && volume === settle;
    }, COMPLETE_ROOT);
    expect(
      volumeNear(
        Number(
          (await page.locator(COMPLETE).getAttribute("data-import-volume")) ??
            "0",
        ),
        Number(appliedVolume),
      ),
    ).toBe(true);
    cover("base-import");
    await page.getByTestId("complete-clear-import").click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "document",
    );
  });
});

test("s09b an OBJ file imports through the dialog", async ({
  sessionPage: page,
}) => {
  await stage("s09b OBJ import", async () => {
    // An OBJ FILE imports through the dialog (the mesh path).
    const plateObj = [
      "o plate",
      "v 0 0 0",
      "v 10 0 0",
      "v 10 20 0",
      "v 0 20 0",
      "v 0 0 4",
      "v 10 0 4",
      "v 10 20 4",
      "v 0 20 4",
      "f 1 3 2",
      "f 1 4 3",
      "f 5 6 7",
      "f 5 7 8",
      "f 1 2 6",
      "f 1 6 5",
      "f 3 4 8",
      "f 3 8 7",
      "f 2 3 7",
      "f 2 7 6",
      "f 4 1 5",
      "f 4 5 8",
      "",
    ].join("\n");
    await page.getByTestId("complete-command-menu-trigger").click();
    await page.locator('[data-cad-command-id="import"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "true",
    );
    await page.getByTestId("cad-import-file").setInputFiles({
      buffer: Buffer.from(plateObj, "utf8"),
      mimeType: "text/plain",
      name: "plate.obj",
    });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-source",
      "obj",
    );
    await expect
      .poll(async () =>
        page.locator(COMPLETE).getAttribute("data-import-triangles"),
      )
      .toBe("12");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-volume",
      "800.000",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "import",
    );
    await page.getByTestId("complete-clear-import").click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "document",
    );
  });
});

test("s09c the sketch exchange: model-mode DXF decline and the sketch import", async ({
  sessionPage: page,
}) => {
  await stage("s09c DXF exchange", async () => {
    // A DXF picked from the MODEL-mode dialog declines honestly: no active
    // sketch, and the refusal says where the file CAN go.
    const sketchDxf =
      "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" +
      "0\nLINE\n5\n2AF\n8\noutline\n10\n0\n20\n0\n11\n30\n21\n40\n" +
      "0\nCIRCLE\n5\n2B0\n8\noutline\n10\n15\n20\n20\n40\n5\n" +
      "0\nENDSEC\n0\nEOF\n";
    await page.getByTestId("complete-command-menu-trigger").click();
    await page.locator('[data-cad-command-id="import"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "true",
    );
    await page.getByTestId("cad-import-file").setInputFiles({
      buffer: Buffer.from(sketchDxf, "utf8"),
      mimeType: "text/plain",
      name: "outline.dxf",
    });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-error",
      /sketch-import\/no-active-sketch/,
    );
    await expect(page.locator("[data-cad-import-error]")).toContainText(
      "enter sketch mode",
    );
    await page.keyboard.press("Escape");

    // THE SKETCH EXCHANGE: from the active sketch, the DXF entities commit
    // as one transaction.
    await runCommand(page, COMPLETE_ROOT, "sketch");
    await expect(page.locator(SKETCH)).toBeVisible();
    await page.getByTestId("sketch-import-file").setInputFiles({
      buffer: Buffer.from(sketchDxf, "utf8"),
      mimeType: "text/plain",
      name: "outline.dxf",
    });
    await expect(page.locator(SKETCH)).toHaveAttribute(
      "data-sketch-import",
      /outline\.dxf: imported 2 entities/,
    );
    const countEntities = async (): Promise<number> => {
      const raw = await page
        .locator(SKETCH)
        .getAttribute("data-sketch-entities");
      return (JSON.parse(raw ?? "[]") as unknown[]).length;
    };
    await expect.poll(countEntities).toBe(2);
    await expect(
      page.locator("#sketch-root [data-sketch-entity-id]"),
    ).toHaveCount(2);
    cover("sketch-exchange-import");
  });
});

test("s10 appearances, light rigs, quality mode, datum, and 3D curves", async ({
  sessionPage: page,
}) => {
  await stage("s10 appearances + curves + datum", async () => {
    await openComplete(page);

    // APPEARANCES: the brass preset applies to the body record and clears
    // back to the boot material (the tree chip carries the state).
    const appearanceChip = page
      .locator('[data-cad-tree-body-appearance=""]')
      .first();
    await expect(appearanceChip).toBeAttached();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.locator('[data-cad-tree-body-appearance=""]').first().click();
    await page.waitForTimeout(300);
    await page.getByTestId("appearance-preset-brass").click();
    // The active record rides the chip span's data-cad-tree-appearance-
    // active attribute (the trigger's own attribute is a constant hook).
    await expect
      .poll(async () =>
        page.locator("[data-cad-tree-appearance-active]").count(),
      )
      .toBe(1);
    extra("appearance-brass");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.locator("[data-cad-tree-body-appearance]").first().click();
    await page.waitForTimeout(300);
    await page.getByTestId("appearance-preset-none").click();
    await expect
      .poll(async () =>
        page.locator("[data-cad-tree-appearance-active]").count(),
      )
      .toBe(0);

    // LIGHT RIGS and the opt-in QUALITY mode: the toggles commit their
    // records and return to the boot state.
    await page.getByTestId("light-rig-inspection").click();
    await page.getByTestId("light-rig-studio").click();
    await page.getByTestId("render-quality-quality").click();
    await page.getByTestId("render-quality-standard").click();
    extra("light-rigs+quality");
  });
});

test("s10b datum geometry and 3D curves with their history", async ({
  sessionPage: page,
}) => {
  await stage("s10b datum + curves", async () => {
    // DATUM GEOMETRY through the command row: the record resolves.
    await runCommand(page, COMPLETE_ROOT, "create-datum");
    await expect(page.locator(DIALOG)).toBeVisible();
    await page
      .locator(DIALOG)
      .getByRole("button", { name: "Create datum" })
      .click();
    await expect(page.locator(DIALOG)).toBeHidden();
    const datums = JSON.parse(
      (await page.locator(COMPLETE).getAttribute("data-datums")) ?? "[]",
    ) as { resolved: boolean }[];
    expect(datums.length).toBeGreaterThanOrEqual(1);
    expect(datums[0]?.resolved).toBe(true);
    cover("datum-geometry");

    // 3D CURVES: the interpolated spline and the helix commit, render as
    // overlay markers, and persist through undo/redo (the curve journey).
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-curve-count",
      "0",
    );
    await runCommand(page, COMPLETE_ROOT, "create-curve");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-feature-dialog-kind",
      "curve",
    );
    await page.getByRole("button", { name: "Create curve" }).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-curve-count",
      "1",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "curves",
    );
    await expect(page.locator("[data-curve-overlay-marker]")).toHaveCount(1);

    await runCommand(page, COMPLETE_ROOT, "create-curve");
    const kindTrigger = page
      .locator(`${DIALOG} [data-slot=select-trigger]`)
      .first();
    await kindTrigger.click();
    await page
      .locator("[data-slot=select-item]", { hasText: "helix" })
      .first()
      .click();
    await page.getByRole("button", { name: "Create curve" }).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-curve-count",
      "2",
    );
    await expect(page.locator("[data-curve-overlay-marker]")).toHaveCount(2);
    cover("curve-authoring-3d");

    // The records persist through history.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-curve-count",
      "1",
    );
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-curve-count",
      "0",
    );
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-curve-count",
      "1",
    );
  });
});

test("s11 snapshot exports: PNG, the 8-frame turntable, and the isometric series", async ({
  sessionPage: page,
}) => {
  await stage("s11 snapshots", async () => {
    await openComplete(page);
    await expect
      .poll(async () => page.locator(COMPLETE).getAttribute("data-settled"))
      .toBe("1");

    // The single PNG snapshot (captures the settled frame directly —
    // no ledger wait — so it sits inside the 30s cap).
    const png = await collectDownloads(
      page,
      () => runCommand(page, COMPLETE_ROOT, "export-snapshot-png"),
      1,
      25_000,
    );
    await assertPngs(png, ["slopcad-snapshot.png"]);
    cover("visualization-snapshot-png");
  });
});

test("s11b the 8-frame turntable series export", async ({
  sessionPage: page,
}) => {
  // The camera ledger now advances per committed camera render, so the
  // series completes in seconds; the cap is a bounded ceiling only.
  test.setTimeout(150_000);
  await stage("s11b turntable", async () => {
    await openComplete(page);
    // The turntable: 8 distinct frames in order, camera restored to spec.
    const turntable = await collectDownloads(
      page,
      () => runCommand(page, COMPLETE_ROOT, "export-turntable"),
      8,
      120_000,
    );
    await assertPngs(
      turntable,
      Array.from(
        { length: 8 },
        (_, index) => `slopcad-turntable-${String(index)}.png`,
      ),
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-camera-source",
      "spec",
    );
    cover("visualization-snapshot-turntable");
  });
});

test("s11c the isometric 4-view series export", async ({
  sessionPage: page,
}) => {
  // Second series: 4 ledger waits, each answered by a real camera render
  // (seconds, not the historical 45s of dead degrades).
  test.setTimeout(90_000);
  await stage("s11c isometric", async () => {
    await openComplete(page);
    // The isometric series: 4 distinct views.
    const iso = await collectDownloads(
      page,
      () => runCommand(page, COMPLETE_ROOT, "export-isometric"),
      4,
      60_000,
    );
    await assertPngs(
      iso,
      Array.from(
        { length: 4 },
        (_, index) => `slopcad-iso-${String(index)}.png`,
      ),
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-camera-source",
      "spec",
    );
    cover("visualization-snapshot-isometric");
  });
});

test("s12 OCCT sweep and loft land on the analytic volumes", async ({
  sessionPage: page,
}) => {
  await stage("s12 occt sweep + loft", async () => {
    walk("/workbench-complete-occt");

    // SWEEP: profile + path sketches → the analytic tube, then the
    // undo/redo round trip (the sweep suite's journey).
    await openComplete(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await drawProfileSquare(page);
    await saveSketch(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await drawPathSpine(page);
    await saveSketch(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "sweep");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 1" }).click();
    await page.locator(`${DIALOG} [role="combobox"]`).nth(1).click();
    await page.getByRole("option", { name: "sketch 2" }).click();
    const beforeSweep = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "sweep",
    );
    const swept = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeSweep,
    });
    // The document scene renders the boot plate beside the swept tube
    // (Phase 16).
    expect(
      volumeNear(Number(swept), BOOT_PLATE_VOLUME + SWEEP_VOLUME),
      `swept ${swept} vs analytic ${String(BOOT_PLATE_VOLUME + SWEEP_VOLUME)}`,
    ).toBe(true);
    cover("sweep-feature");
    await undoRedoCheckpoint(page, OCCT_ROOT, "sweep");
  });
});

test("s12b OCCT loft lands on the Simpson volume and re-drives", async ({
  sessionPage: page,
}) => {
  await stage("s12b loft", async () => {
    // LOFT: a fresh page boots the fresh document, so the form's two
    // oldest-sketch pre-seed is exactly the two section squares.
    await openComplete(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await drawProfileSquare(page);
    await saveSketch(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, -5, -5);
    await clickCanvasPoint(page, 5, 5);
    await saveSketch(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "loft");
    const beforeLoft = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute("data-scene-kind", "loft");
    const lofted = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeLoft,
    });
    // The boot plate rides beside the loft (Phase 16 document scene).
    expect(volumeNear(Number(lofted), BOOT_PLATE_VOLUME + LOFT_VOLUME_20)).toBe(
      true,
    );

    // The station edit re-drives to the Simpson volume at 50 mm.
    const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("loftZ_1", { exact: true }).fill("50");
    await page.getByRole("button", { name: "Apply" }).click();
    const redriven = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeEdit,
    });
    expect(
      volumeNear(Number(redriven), BOOT_PLATE_VOLUME + LOFT_VOLUME_50),
    ).toBe(true);
    cover("loft-feature");
  });
});

test("s13 OCCT helix and thread land inside the derived bands", async ({
  sessionPage: page,
}) => {
  await stage("s13 occt helix + thread", async () => {
    await openComplete(page, OCCT_ROOT);

    // HELIX: the meridian sketch sweeps to the derived screw volume.
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 0, -0.75);
    await clickCanvasPoint(page, 2, 0.75);
    await saveSketch(page, OCCT_ROOT);
    // The meridian is "sketch 1"; the throwaway unlocks the row (the
    // menu's >= 2-sketch gate) and the pick is explicit.
    await saveThrowawaySketch(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "helix");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 1", exact: true }).click();
    const beforeHelix = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "helix",
    );
    const helical = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeHelix,
    });
    // The document volume: the boot plate rides beside the screw (the
    // band covers the plate's documented bore deficit too).
    const helixDocument = BOOT_PLATE_VOLUME + HELIX_OCCT;
    expect(
      Math.abs(Number(helical) - helixDocument) / helixDocument,
      `helical ${helical} vs derived ${String(helixDocument)}`,
    ).toBeLessThan(2e-3);
    cover("helix-feature");
  });
});

test("s13b OCCT thread inside the derived band and its re-drive", async ({
  sessionPage: page,
}) => {
  await stage("s13b thread", async () => {
    // THREAD: the ⌀6 rod threads inside the derived containment band; the
    // length edit re-drives deeper.
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "thread");
    const beforeThread = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "thread",
    );
    const threaded = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeThread }),
    );
    // The document volume: the boot plate AND s13's helix body are part
    // of this document (the stage continues the same session), and the
    // document scene renders every lineage — plate + helix + the threaded
    // rod (the thread output absorbs its base).
    const threadDocument = BOOT_PLATE_VOLUME + HELIX_OCCT + ROD_VOLUME;
    expect(threaded).toBeGreaterThanOrEqual(
      threadDocument - THREAD_TOOL_VOLUME,
    );
    expect(threaded).toBeLessThanOrEqual(
      threadDocument - THREAD_TOOL_VOLUME * 0.83,
    );
    const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("threadLength1", { exact: true }).fill("8");
    await page.getByRole("button", { name: "Apply" }).click();
    const redriven = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
    );
    expect(redriven).toBeLessThan(threaded);
    cover("thread-feature");

    // The history walk: the LAST transaction was the parameter edit, so
    // the first undo reverts the length (entries unchanged), the second
    // removes the thread feature, and the redo restores it valid.
    const threadEntries = (await readTimeline(page, OCCT_ROOT)).entries.length;
    await page.locator(UNDO_BUTTON).click();
    await page.waitForFunction(
      (id) =>
        Number(
          document.getElementById(id)?.getAttribute("data-hole-diameter") ??
            "0",
        ) === 0 || true,
      OCCT_ROOT,
    );
    await page.waitForFunction(
      ({ id, count }) =>
        (
          JSON.parse(
            document
              .getElementById(id)
              ?.getAttribute("data-feature-timeline") ?? "{}",
          ) as { entries: unknown[] }
        ).entries.length === count,
      { id: OCCT_ROOT, count: threadEntries },
    );
    await page.locator(UNDO_BUTTON).click();
    await page.waitForFunction(
      ({ id, count }) =>
        (
          JSON.parse(
            document
              .getElementById(id)
              ?.getAttribute("data-feature-timeline") ?? "{}",
          ) as { entries: unknown[] }
        ).entries.length ===
        count - 1,
      { id: OCCT_ROOT, count: threadEntries },
    );
    await page.locator(REDO_BUTTON).click();
    await page.waitForFunction(
      ({ id, count, kind }) => {
        const timeline = JSON.parse(
          document.getElementById(id)?.getAttribute("data-feature-timeline") ??
            "{}",
        ) as { entries: readonly { kind: string; status: string }[] };
        return (
          timeline.entries.length === count &&
          timeline.entries.some(
            (entry) => entry.kind === kind && entry.status === "valid",
          )
        );
      },
      { id: OCCT_ROOT, count: threadEntries, kind: "thread" },
    );
  });
});

test("s14 OCCT draft, rib, scale, thicken, and split land on the analytic volumes", async ({
  sessionPage: page,
}) => {
  await stage("s14 occt draft/rib/scale/thicken/split", async () => {
    // DRAFT: the saved circle extrudes with the 5° taper to the frustum;
    // the taper flattens through the parameter panel.
    await openComplete(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "circle");
    await clickCanvasPoint(page, 0, 0);
    await clickCanvasPoint(page, 3, 0);
    await saveSketch(page, OCCT_ROOT);
    await saveThrowawaySketch(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "draft");
    const beforeDraft = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const drafted = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeDraft,
    });
    // The boot plate rides beside the frustum (Phase 16 document scene).
    expect(volumeNear(Number(drafted), BOOT_PLATE_VOLUME + DRAFT_VOLUME)).toBe(
      true,
    );
    const beforeFlat = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("extrudeTaper1", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Apply" }).click();
    const flat = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeFlat,
    });
    expect(volumeNear(Number(flat), BOOT_PLATE_VOLUME + ROD_VOLUME)).toBe(true);
    cover("draft-taper-feature");
  });
});

test("s14b OCCT rib unions and re-drives", async ({ sessionPage: page }) => {
  await stage("s14b rib", async () => {
    // RIB: a fresh page, rod + section sketch → the union band; the
    // thickness re-drive grows it.
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, -5, -0.5);
    await clickCanvasPoint(page, 5, 0.5);
    await saveSketch(page, OCCT_ROOT);
    await saveThrowawaySketch(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "rib");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 1", exact: true }).click();
    const beforeRib = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute("data-scene-kind", "rib");
    const ribbed = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeRib }),
    );
    // The document volume: the boot plate rides beside the ribbed rod.
    expect(ribbed).toBeGreaterThan(BOOT_PLATE_VOLUME + ROD_VOLUME);
    expect(ribbed).toBeLessThanOrEqual(BOOT_PLATE_VOLUME + ROD_VOLUME + 20);
    const beforeRibEdit = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("ribThickness", { exact: true }).fill("4");
    await page.getByRole("button", { name: "Apply" }).click();
    const thicker = Number(
      await waitForRootSettle(page, OCCT_ROOT, {
        afterDispatch: beforeRibEdit,
      }),
    );
    expect(thicker).toBeGreaterThan(ribbed);
    cover("rib-feature");
  });
});

test("s14c OCCT scale doubles cubically", async ({ sessionPage: page }) => {
  await stage("s14c scale", async () => {
    // SCALE: the rod scales by exactly 8, then 27.
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "scale");
    const beforeScale = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "scale",
    );
    const scaled = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeScale,
    });
    // The document volume: the boot plate is NOT scaled — the scale
    // feature rebuilds its base into its own output body, which the
    // document scene renders beside the plate (Phase 16).
    expect(volumeNear(Number(scaled), BOOT_PLATE_VOLUME + ROD_VOLUME * 8)).toBe(
      true,
    );
    const beforeScaleEdit = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("scaleFactor", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Apply" }).click();
    const bigger = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeScaleEdit,
    });
    expect(
      volumeNear(Number(bigger), BOOT_PLATE_VOLUME + ROD_VOLUME * 27),
    ).toBe(true);
    cover("scale-feature");
  });
});

test("s14d OCCT thicken hollows to the exact shell", async ({
  sessionPage: page,
}) => {
  await stage("s14d thicken", async () => {
    // THICKEN: 1 mm walls hollow the rod into the exact closed shell.
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "thicken");
    await page.getByLabel("Wall thickness (mm)").fill("1");
    const beforeThicken = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "thicken",
    );
    const hollowed = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeThicken,
    });
    // The boot plate rides beside the shell (Phase 16 document scene).
    expect(
      volumeNear(Number(hollowed), BOOT_PLATE_VOLUME + THICKEN_VOLUME),
    ).toBe(true);
    cover("thicken-shell-feature");
  });
});

test("s14e OCCT split keeps the analytic half", async ({
  sessionPage: page,
}) => {
  await stage("s14e split", async () => {
    // SPLIT: the z = 5 datum plane keeps half the rod; flipping the keep
    // side keeps the other half.
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "create-datum");
    await page.getByLabel("Origin z (mm)").fill("5");
    await page
      .locator(DIALOG)
      .getByRole("button", { name: "Create datum" })
      .click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await openDialogViaMenu(page, OCCT_ROOT, "split");
    const beforeSplit = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "split",
    );
    const split = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeSplit,
    });
    // The boot plate rides beside the kept half (Phase 16 document scene).
    expect(volumeNear(Number(split), BOOT_PLATE_VOLUME + SPLIT_VOLUME)).toBe(
      true,
    );
    const beforeFlip = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("splitSide", { exact: true }).fill("-1");
    await page.getByRole("button", { name: "Apply" }).click();
    const flipped = await waitForRootSettle(page, OCCT_ROOT, {
      afterDispatch: beforeFlip,
    });
    expect(volumeNear(Number(flipped), BOOT_PLATE_VOLUME + SPLIT_VOLUME)).toBe(
      true,
    );
    cover("split-body-feature");
  });
});

test("s15 OCCT structured holes land on the derived volumes", async ({
  sessionPage: page,
}) => {
  await stage("s15 occt structured hole", async () => {
    await openComplete(page, OCCT_ROOT);
    // The plate: rectangle (0,0)–(30,20) extruded 10 mm.
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 0, 0);
    await clickCanvasPoint(page, 30, 20);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    await waitForRootSettle(page, OCCT_ROOT);

    // The counterbore through the structured dialog (the preview ghost
    // mounts over the settled scene).
    await openDialogViaMenu(page, OCCT_ROOT, "hole-spec");
    const selects = page.locator(`${DIALOG} [data-slot=select-trigger]`);
    await selects.first().click();
    await page
      .locator("[data-slot=select-item]", { hasText: "Counterbore" })
      .click();
    await expect(
      page.locator(DIALOG).getByLabel(/^Counterbore Ø/),
    ).toBeVisible();
    await page
      .locator(DIALOG)
      .getByLabel(/Position x/)
      .fill("15");
    await page
      .locator(DIALOG)
      .getByLabel(/Position y/)
      .fill("10");
    await expect(
      page.locator('[data-hole-preview-ghost="glyphs"]'),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-hole-preview-ghost="glyphs"] [data-hole-preview-position]',
      ),
    ).toHaveCount(1);

    const tip = 8 / 2 / Math.tan(((118 / 2) * Math.PI) / 180);
    const plateVolume = 30 * 20 * 10;
    const cboreRemoved =
      Math.PI * 16 * (6 - tip) +
      (Math.PI * 16 * tip) / 3 +
      Math.PI * (49 - 16) * 3;
    // The document volume: the boot plate renders beside the drilled plate
    // (Phase 16). The band covers the boot plate's documented bore deficit
    // (≈0.08% of its own volume), which the tighter feature-only band
    // could not.
    const counterboreDocument = BOOT_PLATE_VOLUME + plateVolume - cboreRemoved;
    const before = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute("data-scene-kind", "hole");
    const counterbored = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: before }),
    );
    expect(
      Math.abs(counterbored - counterboreDocument) / counterboreDocument,
    ).toBeLessThanOrEqual(2e-3);

    // The depth edit re-drives deeper.
    const beforeEdit = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("holeDepth1", { exact: true }).fill("8");
    await page.getByRole("button", { name: "Apply" }).click();
    const reDriven = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeEdit }),
    );
    const deepRemoved =
      Math.PI * 16 * (8 - tip) +
      (Math.PI * 16 * tip) / 3 +
      Math.PI * (49 - 16) * 3;
    const deepDocument = BOOT_PLATE_VOLUME + plateVolume - deepRemoved;
    expect(
      Math.abs(reDriven - deepDocument) / deepDocument,
    ).toBeLessThanOrEqual(2e-3);
    expect(reDriven).toBeLessThan(counterbored);
    cover("structured-hole-feature");
  });
});

test("s15b the positions sketch cuts many holes from one feature", async ({
  sessionPage: page,
}) => {
  await stage("s15b positions", async () => {
    // The analytic anchors (the same derived values part A pins).
    const tip = 8 / 2 / Math.tan(((118 / 2) * Math.PI) / 180);
    const plateVolume = 30 * 20 * 10;

    // THE POSITIONS SKETCH: two point entities cut MANY holes from one
    // feature (a fresh page boots the fresh document).
    await openComplete(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 0, 0);
    await clickCanvasPoint(page, 30, 20);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    await waitForRootSettle(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "point");
    await clickCanvasPoint(page, 10, 10);
    await clickCanvasPoint(page, 20, 10);
    await saveSketch(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "hole-spec");
    const positionsSelect = page
      .locator(`${DIALOG} [data-slot=select-trigger]`)
      .nth(1);
    await positionsSelect.click();
    await page
      .locator("[data-slot=select-item]")
      .filter({ hasText: /^sketch 1$/ })
      .click();
    await expect(
      page.locator(
        '[data-hole-preview-ghost="glyphs"] [data-hole-preview-position]',
      ),
    ).toHaveCount(2);
    const beforeMany = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute("data-scene-kind", "hole");
    const twoHoles = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeMany }),
    );
    const straightRemoved = Math.PI * 16 * (6 - tip) + (Math.PI * 16 * tip) / 3;
    // The document volume: the boot plate rides beside the drilled plate
    // (Phase 16); the band covers its documented bore deficit.
    const twoHoleDocument =
      BOOT_PLATE_VOLUME + plateVolume - 2 * straightRemoved;
    expect(
      Math.abs(twoHoles - twoHoleDocument) / twoHoleDocument,
    ).toBeLessThanOrEqual(2e-3);
  });
});

test("s16 OCCT pattern, path pattern, mirror, booleans, and the moved body", async ({
  sessionPage: page,
}) => {
  await stage("s16 occt patterns/booleans/move", async () => {
    // PATTERN: the editor arrays the rod with a skip and re-drives.
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "pattern");
    await page
      .locator(DIALOG)
      .getByRole("button", { name: "Skip an instance" })
      .click();
    const beforePattern = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "patternFeature",
    );
    const patterned = Number(
      await waitForRootSettle(page, OCCT_ROOT, {
        afterDispatch: beforePattern,
      }),
    );
    // The document volume: the boot plate rides beside the pattern
    // (Phase 16 document scene).
    expect(volumeNear(patterned, BOOT_PLATE_VOLUME + 2 * ROD_VOLUME)).toBe(
      true,
    );
    const beforePatternEdit = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("patternCount1", { exact: true }).fill("5");
    await page.getByLabel("patternSpacing1", { exact: true }).fill("30");
    await page.getByRole("button", { name: "Apply" }).click();
    const redriven = Number(
      await waitForRootSettle(page, OCCT_ROOT, {
        afterDispatch: beforePatternEdit,
      }),
    );
    expect(volumeNear(redriven, BOOT_PLATE_VOLUME + 4 * ROD_VOLUME)).toBe(true);
    cover("feature-pattern");
  });
});

test("s16b OCCT path pattern repeats along a saved path", async ({
  sessionPage: page,
}) => {
  await stage("s16b path pattern", async () => {
    // PATH PATTERN: a fresh page, the rod repeats along a saved path.
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "line");
    await clickCanvasPoint(page, 0, 0);
    await clickCanvasPoint(page, 0, 30);
    await saveSketch(page, OCCT_ROOT);
    await saveThrowawaySketch(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "pattern-path");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 1", exact: true }).click();
    const beforePath = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "patternPath",
    );
    const pathPatterned = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforePath }),
    );
    // The boot plate rides beside the path pattern (Phase 16).
    expect(volumeNear(pathPatterned, BOOT_PLATE_VOLUME + 4 * ROD_VOLUME)).toBe(
      true,
    );
    cover("path-pattern-feature");
  });
});

test("s16c OCCT mirror merges and re-drives standalone", async ({
  sessionPage: page,
}) => {
  await stage("s16c mirror", async () => {
    // MIRROR: the datum plane merges the reflection; the merge edit
    // re-drives to the standalone reflection.
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "create-datum");
    await page.getByLabel("Origin x (mm)").fill("5");
    await page.getByLabel("Normal x").fill("1");
    await page.getByLabel("Normal z").fill("0");
    await page.getByLabel("In-plane x x").fill("0");
    await page.getByLabel("In-plane x y").fill("1");
    await page
      .locator(DIALOG)
      .getByRole("button", { name: "Create datum" })
      .click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await openDialogViaMenu(page, OCCT_ROOT, "mirror");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(1).click();
    await page.getByRole("option", { name: "Merge with the original" }).click();
    const beforeMirror = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "mirror",
    );
    const mirrored = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeMirror }),
    );
    // The boot plate rides beside the mirror (Phase 16 document scene).
    expect(volumeNear(mirrored, BOOT_PLATE_VOLUME + 2 * ROD_VOLUME)).toBe(true);
    const beforeMirrorEdit = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("mirrorMerge", { exact: true }).fill("1");
    await page.getByRole("button", { name: "Apply" }).click();
    const standalone = Number(
      await waitForRootSettle(page, OCCT_ROOT, {
        afterDispatch: beforeMirrorEdit,
      }),
    );
    expect(volumeNear(standalone, BOOT_PLATE_VOLUME + ROD_VOLUME)).toBe(true);
    cover("mirror-feature");
  });
});

test("s16d OCCT boolean subtract at the analytic volume", async ({
  sessionPage: page,
}) => {
  await stage("s16d boolean subtract", async () => {
    // BOOLEAN SUBTRACT: the plate-with-hole at the analytic volume.
    await openComplete(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 0, 0);
    await clickCanvasPoint(page, 60, 40);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    await waitForRootSettle(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "circle");
    await clickCanvasPoint(page, 30, 20);
    await clickCanvasPoint(page, 35, 20);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    await waitForRootSettle(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "boolean");
    await page
      .locator(DIALOG)
      .getByRole("checkbox", { name: "pad 2", exact: true })
      .check();
    const beforeSubtract = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "boolean",
    );
    const subtracted = Number(
      await waitForRootSettle(page, OCCT_ROOT, {
        afterDispatch: beforeSubtract,
      }),
    );
    // The document volume: the boolean output absorbs its operands and
    // the boot plate rides beside it (Phase 16 document scene).
    expect(
      volumeNear(subtracted, BOOT_PLATE_VOLUME + PLATE_WITH_HOLE_VOLUME),
    ).toBe(true);
    await expect(
      page
        .locator(
          '[data-cad-tree-body-visibility="visible"], [data-cad-tree-body-visibility="hidden"]',
        )
        .first(),
    ).toBeAttached();
  });
});

test("s16e OCCT boolean union sums the slab", async ({ sessionPage: page }) => {
  await stage("s16e boolean union", async () => {
    // BOOLEAN UNION: a fresh page, two touching plates sum to the slab.
    await openComplete(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 0, 0);
    await clickCanvasPoint(page, 30, 40);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    await waitForRootSettle(page, OCCT_ROOT);
    await enterSketchMode(page, OCCT_ROOT);
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, 30, 0);
    await clickCanvasPoint(page, 60, 40);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    await waitForRootSettle(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "boolean");
    await page.locator(DIALOG).getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: "Union (join)" }).click();
    await page
      .locator(DIALOG)
      .getByRole("checkbox", { name: "pad 2", exact: true })
      .check();
    const beforeUnion = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "boolean",
    );
    const united = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeUnion }),
    );
    // The document volume: the union absorbs both operands; the boot
    // plate rides beside it (Phase 16 document scene).
    expect(volumeNear(united, BOOT_PLATE_VOLUME + PLATE_60_VOLUME)).toBe(true);
    cover("boolean-commands");
  });
});

test("s16f the moved body keeps its volume", async ({ sessionPage: page }) => {
  await stage("s16f move body", async () => {
    // MOVE BODY: the translation is volume-invariant (the body moves, the
    // measured material does not change).
    await openComplete(page, OCCT_ROOT);
    const rodVolume = await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "move-body");
    await page.getByLabel("Offset x (mm)").fill("10");
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    // The move is a TRANSFORM (no re-execution): the scene switches to the
    // moved body and the settled volume is unchanged — translation is
    // volume-invariant, so the plain settle (no dispatch anchor) applies.
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "moveBody",
    );
    const moved = await waitForRootSettle(page, OCCT_ROOT);
    expect(volumeNear(Number(moved), Number(rodVolume))).toBe(true);
    cover("body-management-move");
  });
});

test("s16g OCCT duplicate & transform: cumulative copies, re-drive, refusal, iterative", async ({
  sessionPage: page,
}) => {
  await stage("s16g duplicate & transform", async () => {
    // THE LADDER (the defaults): the rod duplicates ×3 with a 15 mm x-step
    // — cumulative T^i, the copies at 15/30/45 beside the UNCONSUMED
    // source (the document volume sums four rods over the boot plate).
    await openComplete(page, OCCT_ROOT);
    await drawAndExtrudeRod(page, OCCT_ROOT);
    await openDialogViaMenu(page, OCCT_ROOT, "duplicate");
    const beforeLadder = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "duplicate",
    );
    const ladder = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeLadder }),
    );
    expect(volumeNear(ladder, BOOT_PLATE_VOLUME + 4 * ROD_VOLUME)).toBe(true);
    const ladderTimeline = await readTimeline(page, OCCT_ROOT);
    expect(ladderTimeline.entries.at(-1)?.kind).toBe("duplicate");
    expect(ladderTimeline.entries.at(-1)?.status).not.toBe("failed");

    // THE $VAR RE-DRIVE: the step rides the auto-created `duplicateDx`
    // parameter — editing it in the panel re-derives every copy on the
    // next dispatch (15 → 25 mm steps; the sum is overlap-blind, the
    // movement pin lives in the kernel suite and the visual pass).
    const beforeStep = await dispatchedCount(page, OCCT_ROOT);
    await page.getByLabel("duplicateDx", { exact: true }).fill("25");
    await page.getByRole("button", { name: "Apply" }).click();
    const restepped = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeStep }),
    );
    expect(volumeNear(restepped, BOOT_PLATE_VOLUME + 4 * ROD_VOLUME)).toBe(
      true,
    );

    // THE CORNER (iterative + $ref): duplicate COPY 1 — the source pool
    // accepts an earlier duplicate's copy — with the step referencing
    // `$duplicateDx` (the bare reference rides the existing parameter) and
    // a 90° z-rotation: copy 1 stands east, its three T^i copies land at
    // 90/180/270° — four bodies at the quadrants. Three new rods over the
    // ladder document.
    await openDialogViaMenu(page, OCCT_ROOT, "duplicate");
    await page.locator(`${DIALOG} [data-slot=select-trigger]`).nth(0).click();
    await page.getByRole("option", { name: "copy 1", exact: true }).click();
    await page.getByLabel("Step x (mm)").fill("$duplicateDx");
    await page.getByLabel("Step y (mm)").fill("0");
    await page.getByLabel("Step z (mm)").fill("0");
    await page.getByLabel("Step rotation (deg)").fill("90");
    const beforeCorner = await dispatchedCount(page, OCCT_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    const corner = Number(
      await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: beforeCorner }),
    );
    expect(volumeNear(corner, BOOT_PLATE_VOLUME + 7 * ROD_VOLUME)).toBe(true);

    // THE IDENTITY REFUSAL: a zero step and a zero angle is the structured
    // refusal — the dialog stays open with the error verbatim, the
    // timeline is unchanged, and Escape closes without committing.
    await openDialogViaMenu(page, OCCT_ROOT, "duplicate");
    const refusalTimeline = await readTimeline(page, OCCT_ROOT);
    await page.getByLabel("Step x (mm)").fill("0");
    await page.getByLabel("Step y (mm)").fill("0");
    await page.getByLabel("Step z (mm)").fill("0");
    await page.getByLabel("Step rotation (deg)").fill("0");
    await page.getByLabel("Copies").fill("1");
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    const refusal = page.locator('[data-testid="feature-form-error"]');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("identity");
    // The refusal commits nothing: the timeline is unchanged.
    const afterRefusal = await readTimeline(page, OCCT_ROOT);
    expect(afterRefusal.entries.length).toBe(refusalTimeline.entries.length);
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toBeHidden();
    cover("duplicate-transform");
    extra("duplicate-transform-stage");
  });
});

test("s17 OCCT surface workflow: base sheets, trim, thicken, offset, knit", async ({
  sessionPage: page,
}) => {
  await stage("s17 occt surfaces", async () => {
    await openComplete(page, OCCT_ROOT);

    // The datum + the two base sheets (the surface suite's journey).
    await openDialogViaMenu(page, OCCT_ROOT, "create-datum");
    await page.locator(DIALOG).getByLabel("Normal z").fill("1");
    await page.locator(DIALOG).getByLabel("In-plane x x").fill("1");
    await page
      .locator(DIALOG)
      .getByRole("button", { name: "Create datum" })
      .click();
    await expect(page.locator(DIALOG)).toBeHidden();

    await openDialogViaMenu(page, OCCT_ROOT, "surface-create");
    const created = await submitDialogAndSettle(
      page,
      OCCT_ROOT,
      "Create base sheet",
    );
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "sheet",
    );
    expect(created.length).toBeGreaterThan(0);
    cover("sheet-bodies-base-surfaces");

    await openDialogViaMenu(page, OCCT_ROOT, "surface-create");
    await page.locator(DIALOG).getByLabel("u min (mm)").fill("10");
    await page.locator(DIALOG).getByLabel("u max (mm)").fill("20");
    await page.locator(DIALOG).getByLabel("v min (mm)").fill("-100");
    await page.locator(DIALOG).getByLabel("v max (mm)").fill("100");
    await submitDialogAndSettle(page, OCCT_ROOT, "Create base sheet");
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "sheet",
    );

    // TRIM: keep the tool's region — the exact 10 × 20 band.
    await openDialogViaMenu(page, OCCT_ROOT, "surface-trim");
    await submitDialogAndSettle(page, OCCT_ROOT, "Trim sheet");
    await expect(page.locator(OCCT)).toHaveAttribute(
      "data-scene-kind",
      "sheet",
    );
    cover("surface-trim-op");
  });
});

test("s17b OCCT surface thicken, offset, and knit", async ({
  sessionPage: page,
}) => {
  await stage("s17b thicken + offset + knit", async () => {
    // THICKEN the trimmed sheet × 2 mm → exactly 400 mm³.
    await openDialogViaMenu(page, OCCT_ROOT, "surface-thicken");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "trimmed" }).click();
    const thickened = await submitDialogAndSettle(
      page,
      OCCT_ROOT,
      "Thicken sheet",
    );
    // The document volume: the boot plate rides beside the sheet bodies
    // (Phase 16 document scene).
    expect(
      Math.abs(
        Number(thickened) - (BOOT_PLATE_VOLUME + THICKENED_SHEET_VOLUME),
      ),
      `thickened ${thickened}`,
    ).toBeLessThanOrEqual(THICKENED_SHEET_VOLUME * 0.002);
    cover("surface-thicken-op");

    // OFFSET: a sheet offsets along its normals (the timeline carries it).
    await openDialogViaMenu(page, OCCT_ROOT, "surface-offset");
    const offsetOutcome = await submitDialogAndSettle(
      page,
      OCCT_ROOT,
      "Offset sheet",
    );
    expect(offsetOutcome.length).toBeGreaterThan(0);
    cover("surface-offset-op");

    // KNIT: the two sheets sew through their boundary-consistent tolerance
    // (the honest outcome — closed shell or structured refusal — lands on
    // the machine surface, never a fake success).
    await openDialogViaMenu(page, OCCT_ROOT, "surface-knit");
    const timelineBefore = await readTimeline(page, OCCT_ROOT);
    await page
      .locator(DIALOG)
      .getByRole("button", { name: "Knit sheets" })
      .click();
    await page.waitForTimeout(1_000);
    const dialogStillOpen = await page.locator(DIALOG).isVisible();
    if (dialogStillOpen) {
      // The structured refusal stays in the dialog's outcome region.
      await expect(page.locator(DIALOG)).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      const knitTimeline = await readTimeline(page, OCCT_ROOT);
      expect(knitTimeline.entries.length).toBeGreaterThan(
        timelineBefore.entries.length,
      );
    }
    const knitSettled = await waitForRootSettle(page, OCCT_ROOT);
    expect(knitSettled.length).toBeGreaterThan(0);
    cover("surface-knit-op");
  });
});

test("s18 the chain workbench walks sketch → extrude → hole → fillet with the cascade", async ({
  sessionPage: page,
}) => {
  await stage("s18 chain", async () => {
    walk("/workbench-chain");
    await page.goto("/workbench-chain");
    await expect(page.locator("#chain-root")).toHaveAttribute(
      "data-chain-stage",
      "empty",
    );
    await page.locator('[data-testid="chain-mode-toggle"]').click();
    await expect(page.locator(SKETCH)).toBeVisible();
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, RECT.x0, RECT.y0);
    await clickCanvasPoint(page, RECT.x1, RECT.y1);

    // V1: the pad.
    const beforeExtrude = await dispatchedCount(page, "chain-root");
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator("#chain-root")).toHaveAttribute(
      "data-chain-stage",
      "extrude",
    );
    await waitForSettledScene(page, "chain-root", {
      afterDispatch: beforeExtrude,
    });
    let stages = JSON.parse(
      (await page.locator("#chain-root").getAttribute("data-stage-volumes")) ??
        "{}",
    ) as { extruded: number; holed: number | null; filleted: number | null };
    expect(
      Math.abs(stages.extruded - CHAIN_PAD_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM)) /
        CHAIN_PAD_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM),
    ).toBeLessThan(1e-9);

    // V2: the hole.
    const beforeHole = await dispatchedCount(page, "chain-root");
    await page.locator('[data-testid="chain-hole"]').click();
    await expect(page.locator("#chain-root")).toHaveAttribute(
      "data-chain-stage",
      "hole",
    );
    await waitForSettledScene(page, "chain-root", {
      afterDispatch: beforeHole,
    });
    stages = JSON.parse(
      (await page.locator("#chain-root").getAttribute("data-stage-volumes")) ??
        "{}",
    ) as { extruded: number; holed: number | null; filleted: number | null };
    expect(
      Math.abs(
        (stages.holed ?? 0) - CHAIN_HOLED_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM),
      ) / CHAIN_HOLED_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM),
    ).toBeLessThan(1e-9);
  });
});

test("s18b the chain fillet and the upstream cascade", async ({
  sessionPage: page,
}) => {
  await stage("s18b fillet + cascade", async () => {
    let stages: {
      extruded: number;
      holed: number | null;
      filleted: number | null;
    };
    // THE EDGE PICK + FILLET: the corner vertical from the published
    // anchors, then V3.
    const anchors = JSON.parse(
      (await page.locator("#chain-root").getAttribute("data-edge-anchors")) ??
        "{}",
    ) as Record<
      string,
      {
        point: readonly [number, number];
        lengthMm: number;
        centroidMm: readonly [number, number, number];
      }
    >;
    let ordinal: string | null = null;
    let anchor: { point: readonly [number, number] } | null = null;
    for (const [key, value] of Object.entries(anchors)) {
      if (
        Math.abs(value.centroidMm[2] - 5) < 1e-6 &&
        Math.abs(value.centroidMm[0] - 30) < 1e-6 &&
        Math.abs(value.centroidMm[1] - 25) < 1e-6
      ) {
        ordinal = key;
        anchor = value;
        break;
      }
    }
    expect(ordinal, "the corner vertical edge anchor").not.toBeNull();
    await page.locator("#chain-viewport").click({
      position: { x: anchor?.point[0] ?? 0, y: anchor?.point[1] ?? 0 },
    });
    await expect(page.locator("#chain-root")).toHaveAttribute(
      "data-selected-edge",
      ordinal ?? "",
    );
    const beforeFillet = await dispatchedCount(page, "chain-root");
    await page.locator('[data-testid="chain-fillet"]').click();
    await expect(page.locator("#chain-root")).toHaveAttribute(
      "data-chain-stage",
      "fillet",
    );
    await waitForSettledScene(page, "chain-root", {
      afterDispatch: beforeFillet,
    });
    stages = JSON.parse(
      (await page.locator("#chain-root").getAttribute("data-stage-volumes")) ??
        "{}",
    ) as { extruded: number; holed: number | null; filleted: number | null };
    expect(
      Math.abs(
        (stages.filleted ?? 0) -
          CHAIN_FILLETED_VOLUME(
            EXTRUDE_DEFAULT_DEPTH_MM,
            CHAIN_FILLET_DEFAULT_RADIUS_MM,
          ),
      ) /
        CHAIN_FILLETED_VOLUME(
          EXTRUDE_DEFAULT_DEPTH_MM,
          CHAIN_FILLET_DEFAULT_RADIUS_MM,
        ),
    ).toBeLessThan(1e-9);

    // THE CASCADE: the upstream depth edit re-executes every stage.
    const beforeCascade = await dispatchedCount(page, "chain-root");
    await page.getByLabel("extrudeDepth", { exact: true }).fill("12");
    await page.getByRole("button", { name: "Apply" }).click();
    await waitForSettledScene(page, "chain-root", {
      afterDispatch: beforeCascade,
    });
    stages = JSON.parse(
      (await page.locator("#chain-root").getAttribute("data-stage-volumes")) ??
        "{}",
    ) as { extruded: number; holed: number | null; filleted: number | null };
    expect(
      Math.abs(stages.extruded - CHAIN_PAD_VOLUME(12)) / CHAIN_PAD_VOLUME(12),
    ).toBeLessThan(1e-9);
    expect(
      Math.abs((stages.holed ?? 0) - CHAIN_HOLED_VOLUME(12)) /
        CHAIN_HOLED_VOLUME(12),
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(
        (stages.filleted ?? 0) -
          CHAIN_FILLETED_VOLUME(12, CHAIN_FILLET_DEFAULT_RADIUS_MM),
      ) / CHAIN_FILLETED_VOLUME(12, CHAIN_FILLET_DEFAULT_RADIUS_MM),
    ).toBeLessThan(1e-9);
  });
});

test("s19 the assembly tree adds and removes occurrences", async ({
  sessionPage: page,
}) => {
  await stage("s19 assembly", async () => {
    walk("/workbench-assembly");
    await page.goto("/workbench-assembly");
    const root = page.locator("#assembly-workbench-root");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "1");
    await expect(root).toHaveAttribute("data-cad-instance-count", "1");
    await expect(
      page.locator('[data-node-key="occ_assembly_1"]'),
    ).toBeVisible();

    await page.getByTestId("assembly-add-instance").click();
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "2");
    await expect(root).toHaveAttribute("data-cad-instance-count", "2");
    await expect(
      page.locator('[data-node-key="occ_assembly_2"]'),
    ).toBeVisible();

    await page.getByTestId("assembly-remove-instance").click();
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "1");
    await expect(root).toHaveAttribute("data-cad-instance-count", "1");
    await expect(page.locator('[data-node-key="occ_assembly_2"]')).toHaveCount(
      0,
    );
    cover("assembly-structure");
  });
});

test("s20 the assembly motion workbench: patterns, explode, joints, staleness", async ({
  sessionPage: page,
}) => {
  await stage("s20 motion", async () => {
    walk("/workbench-assembly-motion");
    await page.goto("/workbench-assembly-motion");
    const root = page.locator("#assembly-motion-root");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "2");
    await expect(root).toHaveAttribute("data-cad-pattern-count", "0");

    // The linear + circular patterns and the mirror stamp occurrences.
    await page.getByTestId("motion-linear-pattern").click();
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "5");
    await page.getByTestId("motion-circular-pattern").click();
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "11");
    await page.getByTestId("motion-circular-pattern").click();
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "11");
    await page.getByTestId("motion-mirror").click();
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "12");
    cover("component-patterns-mirror");

    // The explode state authors and scrubs deterministically.
    await page.getByTestId("motion-explode-author").click();
    await expect(root).toHaveAttribute("data-cad-explode-active", "true");
    const explodedStamp = await root.getAttribute("data-cad-explode-scene");
    const scrub = page.getByTestId("motion-explode-scrub");
    await scrub.fill("0.25");
    await expect(root).toHaveAttribute("data-cad-explode-factor", "0.25");
    const quarterStamp = await root.getAttribute("data-cad-explode-scene");
    expect(quarterStamp).not.toEqual(explodedStamp);
    await scrub.fill("1");
    await expect(root).toHaveAttribute(
      "data-cad-explode-scene",
      explodedStamp ?? "",
    );
    cover("assembly-motion-explode");

    // The revolute joint scrubs inside its limits.
    const jointScrub = page.getByTestId("motion-joint-scrub");
    await jointScrub.fill("30");
    await expect(root).toHaveAttribute("data-cad-motion-parameter", "30.0");
    const motionAt30 = await root.getAttribute("data-cad-motion-scene");
    await jointScrub.fill("0");
    await expect(root).toHaveAttribute("data-cad-motion-parameter", "0.0");
    const motionAt0 = await root.getAttribute("data-cad-motion-scene");
    expect(motionAt0).not.toEqual(motionAt30);
    cover("mate-joint-solver");

    // The clearance probe stamps a number; the drag declines honestly.
    const clearance = await root.getAttribute("data-cad-clearance-mm");
    expect(clearance ?? "").toMatch(/^\d+(\.\d+)?$/);
    cover("interference-clearance");
    await page.getByTestId("motion-drag-decline").click();
    await expect(page.getByTestId("motion-drag-decline-text")).toContainText(
      "mate solver",
    );

    // The cross-document staleness rule: edit → STALE → regenerate.
    await expect(root).toHaveAttribute("data-cad-stale", "false");
    await page.getByTestId("motion-edit-source").click();
    await expect(page.getByTestId("motion-stale-badge")).toHaveText("STALE");
    await page.getByTestId("motion-regenerate").click();
    await expect(page.getByTestId("motion-stale-badge")).toHaveText(
      "up to date",
    );
  });
});

test("s21 the interference workbench reports, isolates, and exports snapshots", async ({
  sessionPage: page,
}) => {
  await stage("s21 interference", async () => {
    walk("/workbench-assembly-interference");
    await page.goto("/workbench-assembly-interference");
    const root = page.locator("#interference-workbench-root");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "3");
    await expect(page.getByTestId("interference-panel")).toContainText(
      "No report yet",
    );

    await page.getByTestId("interference-run").click();
    await expect(root).toHaveAttribute("data-cad-interference-pairs", "1");
    await expect(root).toHaveAttribute("data-cad-clearance-count", "3");
    await expect(page.getByTestId("interference-row-0")).toContainText(
      "interferes",
    );

    await page.getByTestId("interference-isolate-0").click();
    await expect(root).toHaveAttribute("data-cad-instance-count", "2");
    await page.getByTestId("interference-show-all").click();
    await expect(root).toHaveAttribute("data-cad-instance-count", "3");

    await page.getByTestId("interference-export-json").click();
    await expect(root).toHaveAttribute("data-cad-report-format", "json");
    const jsonDigest = await root.getAttribute("data-cad-report-digest");
    expect(jsonDigest).not.toBe("none");
    await page.getByTestId("interference-export-html").click();
    await expect(root).toHaveAttribute("data-cad-report-format", "html");
    const htmlDigest = await root.getAttribute("data-cad-report-digest");
    expect(htmlDigest).not.toBe(jsonDigest);
  });
});

test("s22 the analysis workbench runs draft, curvature, zebra, and mass", async ({
  sessionPage: page,
}) => {
  await stage("s22 analysis", async () => {
    walk("/workbench-analysis");
    await page.goto("/workbench-analysis");
    const root = page.locator("#analysis-workbench-root");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-mass-g", "289.710");
    await expect(root).toHaveAttribute("data-cad-comb-max-kappa", "0.033");
    await expect(root).toHaveAttribute("data-cad-draft-faces", "none");

    await page.getByTestId("analysis-run").click();
    await expect(root).toHaveAttribute(
      "data-cad-draft-classes",
      "positive=1|negative=1|vertical=4|undercut=0",
    );
    await expect(root).toHaveAttribute(
      "data-cad-band-census",
      "flat=4|curved=46|sharp=0",
    );

    await expect(root).toHaveAttribute("data-cad-zebra", "off");
    await page.getByTestId("analysis-zebra-toggle").click();
    await expect(root).toHaveAttribute("data-cad-zebra", "on");
    await page.getByTestId("analysis-zebra-toggle").click();
    await expect(root).toHaveAttribute("data-cad-zebra", "off");
  });
});

test("s23 the drawing workbench produces a sheet, views, annotations, and stable output", async ({
  sessionPage: page,
}) => {
  await stage("s23 drawings", async () => {
    walk("/drawings");
    await page.goto("/drawings");
    const boot = page.locator("main[data-drawing-boot]");
    await expect(boot).toHaveAttribute("data-drawing-boot", "ready");
    const canvas = page.getByTestId("drawing-canvas");
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute(
      "aria-label",
      "Drawing canvas: no sheets yet",
    );

    // THE SHEET: creation recovers the seed's feature dimensions
    // end-to-end (never re-typed).
    await page.getByRole("button", { name: "Create sheet" }).click();
    const status = page.locator('[data-testid="drawing-status"]');
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute(
      "data-drawing-values",
      '["R4","20","60","40"]',
    );
    await expect(status).toHaveAttribute("data-dims-count", "4");
    cover("drawing-sheets-views");

    // THE VIEWS: three anchored base views + every derived view class +
    // the BOM and its balloon.
    for (const name of ["Front", "Top", "Right"]) {
      await page.getByRole("button", { name, exact: true }).click();
    }
    for (const name of [
      "Projected left",
      "Projected back",
      "Section A-A",
      "Detail B",
      "Broken-out",
      "Auxiliary D",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
    }
    await page.getByRole("button", { name: "Add BOM table" }).click();
    await page.getByRole("button", { name: "Add balloon" }).click();
    await expect(canvas).toHaveAttribute(
      "aria-label",
      "Drawing: A3 landscape sheet, 9 views: front, top, right, front, front, front, front, top, front, BOM 1 table, 1 balloon",
    );
    await expect(canvas.locator("g.dg-bom")).toHaveCount(1);
    await expect(canvas.locator("text.dg-balloon-item")).toHaveText("1");
    cover("drawing-output-bom");
  });
});

test("s23b drawing annotations, template switch, and stable output", async ({
  sessionPage: page,
}) => {
  await stage("s23b annotations + output", async () => {
    const status = page.locator('[data-testid="drawing-status"]');
    // THE ANNOTATIONS: the reference dimension and the revision row author
    // on-view; the template switches.
    await page.click('[data-testid="drawing-reference-open"]');
    const referenceDialog = page.locator(
      '[data-testid="drawing-reference-dialog"]',
    );
    await expect(referenceDialog).toBeVisible();
    await page
      .getByRole("button", { name: "Place reference dimension" })
      .click();
    await expect(referenceDialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-dims-count", "5");

    await page.click('[data-testid="drawing-revision-open"]');
    const revisionDialog = page.locator(
      '[data-testid="drawing-revision-dialog"]',
    );
    await expect(revisionDialog).toBeVisible();
    await page.getByLabel("Description").fill("session journey revision");
    await page.getByRole("button", { name: "Add revision row" }).click();
    await expect(revisionDialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-revisions", "1");

    await page.click('[data-testid="drawing-template-open"]');
    const templateDialog = page.locator(
      '[data-testid="drawing-template-dialog"]',
    );
    await expect(templateDialog).toBeVisible();
    await page.getByRole("combobox", { name: "Template" }).click();
    await page.getByRole("option", { name: "A4 landscape · 1:1" }).click();
    await page.getByRole("button", { name: "Apply template" }).click();
    await expect(templateDialog).not.toBeVisible();
    await expect(status).toHaveAttribute("data-template", "a4-landscape-1-1");
    cover("drawing-dimensions-annotations");

    // THE OUTPUT: the SVG export is byte-stable across re-exports.
    await page.click('[data-testid="drawing-export"]');
    const first = await status.getAttribute("data-drawing-svg");
    expect(first ?? "").toContain('viewBox="0 0 297 210"');
    await page.click('[data-testid="drawing-export"]');
    const second = await status.getAttribute("data-drawing-svg");
    expect(second).toBe(first);
  });
});

test("s24 the render fixture recomputes projection, pixels, and volume", async ({
  sessionPage: page,
}) => {
  await stage("s24 render", async () => {
    walk("/render");
    await page.goto("/render");
    const volumeA = await waitForSettledScene(page);
    expect(volumeA).toBe(
      (await page.locator("#render-volume").textContent())?.trim() ?? "",
    );
    // The render fixture's plate with its ⌀8 bore (the render spec's
    // analytic formula).
    const analytic = 30 * 20 * 10 - Math.PI * 16 * 10;
    expect(Math.abs(Number(volumeA) - analytic)).toBeLessThanOrEqual(
      analytic * 0.005,
    );
    await expect(page.locator("#render-bounds")).toHaveText(
      "30.000 × 20.000 × 10.000",
    );
    await expect(page.getByTestId("render-error")).toHaveText("");

    // The parameter change updates BOTH the numbers and the pixels.
    const shotA = await page.locator("#render-viewport canvas").screenshot();
    await page.locator("#param-holeDiameter").fill("14");
    const volumeB = await waitForSettledScene(page);
    expect(volumeB).not.toBe(volumeA);
    expect(Number(volumeB)).toBeLessThan(Number(volumeA));
    const shotB = await page.locator("#render-viewport canvas").screenshot();
    expect(shotB.equals(shotA)).toBe(false);
  });
});

test("s25 the io fixture round-trips the plate through STL", async ({
  sessionPage: page,
}) => {
  await stage("s25 io", async () => {
    walk("/io");
    await page.goto("/io");
    await waitForSettledScene(page, "io-root");
    const triangles = Number(
      await page.locator("#io-source-triangles").textContent(),
    );
    expect(triangles).toBeGreaterThan(0);

    // EXPORT: the held bytes publish with the source soup's count.
    await page.locator("#io-export-stl").click();
    const bytesText = await page
      .locator("#io-root")
      .getAttribute("data-export-stl-bytes");
    expect(Number(bytesText)).toBeGreaterThan(0);

    // The download anchor serves the same bytes a human gets.
    const base64 = await page.evaluate(() => {
      const anchor = document.getElementById("io-download-stl");
      if (anchor === null || !(anchor instanceof HTMLAnchorElement)) {
        throw new Error("download anchor missing");
      }
      return fetch(anchor.href)
        .then(async (response) => response.arrayBuffer())
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(
              ...bytes.subarray(index, index + 0x8000),
            );
          }
          return btoa(binary);
        });
    });
    const fileBytes = Buffer.from(base64, "base64");
    expect(fileBytes.length).toBe(Number(bytesText));

    // IMPORT: the mesh returns through the honest path and settles.
    await page.locator("#io-import-stl").click();
    const imported = await waitForImportedMeshSettled(page, "io-root");
    const surface = {
      source: await page.locator("#io-root").getAttribute("data-import-source"),
      triangles: await page
        .locator("#io-root")
        .getAttribute("data-import-triangles"),
      extents: await page
        .locator("#io-root")
        .getAttribute("data-import-extents"),
      error: await page.locator("#io-root").getAttribute("data-import-error"),
    };
    expect(surface.error).toBe("");
    expect(surface.source).toBe("stl");
    expect(surface.triangles).toBe(String(triangles));
    expect(surface.extents).toBe("30.000 × 20.000 × 10.000");
    expect(Number(imported)).toBeGreaterThan(0);
  });
});

test("s26 projects: sign up, create, model, save, reload, reopen, walk history", async ({
  sessionPage: page,
}) => {
  await stage("s26 projects + persistence", async () => {
    // SIGN UP through the public form; the dashboard greets the user.
    walk("/projects");
    await page.goto("/login");
    await page.getByLabel("Name").fill(SESSION_USER.name);
    await page.getByLabel("Email").fill(SESSION_USER.email);
    await page.getByLabel("Password").fill(SESSION_USER.password);
    await page.getByRole("button", { name: "Sign Up" }).click();
    await expect(
      page.getByRole("heading", { name: "Dashboard" }),
    ).toBeVisible();
    extra("login+dashboard");

    // CREATE PROJECT + DOCUMENT through the Formedible forms.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await page.getByLabel("Project name").fill("Session journey");
    await page.getByLabel("Description").fill("one-session e2e");
    await page.getByRole("button", { name: "Create project" }).click();
    const projectLink = page.locator('[data-testid="project-list"] a', {
      hasText: "Session journey",
    });
    await expect(projectLink).toBeVisible();
    await projectLink.click();
    await expect(
      page.getByRole("heading", { name: "Session journey" }),
    ).toBeVisible();
    await page.getByLabel("Document name").fill("session-plate");
    await page.getByRole("button", { name: "Create document" }).click();
    const documentRow = page.locator('[data-testid="document-list"] li', {
      hasText: "session-plate",
    });
    await expect(documentRow).toBeVisible();

    // OPEN: the document enters the workbench honestly unsaved at v0.
    await documentRow.getByRole("link", { name: "Open" }).click();
    const bar = page.locator('[data-testid="project-persistence-bar"]');
    await expect(bar).toHaveAttribute("data-loaded", "true");
    await expect(bar).toHaveAttribute("data-live-version", "0");
    await waitForSettledScene(page, "workbench-root");
  });
});

test("s26b model, save v2, reload, reopen, and walk the history", async ({
  sessionPage: page,
}) => {
  await stage("s26b persistence", async () => {
    const bar = page.locator('[data-testid="project-persistence-bar"]');

    // SAVE 1, MODEL, SAVE 2.
    await page.locator('[data-testid="persistence-save"]').click();
    await expect(bar).toHaveAttribute("data-live-version", "1");
    await expect(bar).toHaveAttribute("data-dirty", "false");
    // MODEL: the document workbench is the complete composition now, so
    // sketch mode enters through its command menu (the dedicated mode
    // toggle lives on the bare /workbench layout only).
    await runCommand(page, "workbench-root", "sketch");
    await expect(page.locator(SKETCH)).toBeVisible();
    await activateSketchTool(page, "rectangle");
    await clickCanvasPoint(page, RECT.x0, RECT.y0);
    await clickCanvasPoint(page, RECT.x1, RECT.y1);
    const before = await dispatchedCount(page, "workbench-root");
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator("#workbench-root")).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const extruded = await waitForSettledScene(page, "workbench-root", {
      afterDispatch: before,
    });
    // The projects route boots the same fixture-plate session, and the
    // document scene renders the plate beside the new pad (Phase 16).
    expect(
      volumeNear(
        Number(extruded),
        BOOT_PLATE_VOLUME + CHAIN_PAD_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM),
      ),
    ).toBe(true);
    await page.locator('[data-testid="persistence-save"]').click();
    await expect(bar).toHaveAttribute("data-live-version", "2");

    // RELOAD + REOPEN: the persisted document restores its content.
    await page.reload();
    await expect(
      page.locator('[data-testid="project-persistence-bar"]'),
    ).toHaveAttribute("data-live-version", "2");
    await expect(page.locator("#workbench-root")).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const reopened = await waitForSettledScene(page, "workbench-root");
    // The persisted document restores its content — plate beside pad, the
    // same document volume (Phase 16).
    expect(
      volumeNear(
        Number(reopened),
        BOOT_PLATE_VOLUME + CHAIN_PAD_VOLUME(EXTRUDE_DEFAULT_DEPTH_MM),
      ),
    ).toBe(true);
    await expect(
      page.locator(`${TREE} [data-node-key="feature|feat_extrude"]`),
    ).toBeVisible();

    // VERSION HISTORY: walking back to v1 restores the pre-extrude doc.
    await page.getByRole("button", { name: "Version history" }).click();
    const historyDialog = page.getByRole("dialog");
    await expect(historyDialog.getByText("Saved versions")).toBeVisible();
    await historyDialog.getByRole("button", { name: /^v1 / }).click();
    await expect(
      page.locator('[data-testid="project-persistence-bar"]'),
    ).toHaveAttribute("data-live-version", "1");
    await expect(page.locator("#workbench-root")).toHaveAttribute(
      "data-scene-kind",
      "plate",
    );
    await expect(
      page.locator(`${TREE} [data-node-key="feature|feat_extrude"]`),
    ).toHaveCount(0);
  });
});

test("s26c the TSX model exchange: import a .tsx model, export TSX, round-trip the held bytes", async ({
  sessionPage: page,
}) => {
  await stage("s26c tsx model exchange", async () => {
    // The TSX import crosses the session-gated server endpoint, so this
    // stage rides AFTER the journey's sign-up (s26) — the earlier io
    // stages (s09*) run pre-auth through their in-browser paths. The
    // fixture is the guide's hub-mount shape, committed with the harness.
    await openComplete(page);

    // IMPORT: the dialog's file chooser sends the .tsx fixture to the
    // app server's loader; the returned native document enters the
    // session through the SAME apply path an opened document takes.
    await page.locator('[data-testid="complete-import"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "true",
    );
    await expect(page.locator('[data-cad-import-format="tsx"]')).toBeAttached();
    await page.getByTestId("cad-import-file").setInputFiles({
      buffer: readFileSync(
        new URL("./fixtures/hub-mount.model.tsx", import.meta.url),
      ),
      mimeType: "text/plain",
      name: "hub-mount.model.tsx",
    });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "false",
    );
    // The model LANDED: the tree shows the imported features and the
    // joined mount body, and the timeline carries the fixture's five
    // features in authored order (polled — the dispatch follows the
    // store's replaceSession asynchronously).
    await expect(
      page.locator(`${TREE} [data-node-key="feature|feat_mount"]`),
    ).toBeVisible();
    await expect(
      page.locator(`${TREE} [data-node-key="body|body_mount"]`),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const timeline = await readTimeline(page, COMPLETE_ROOT);
        return timeline.entries.map((entry) => entry.kind).join(",");
      })
      .toBe("extrude,revolve,loft,subtract,union");
    await waitForSettledScene(page, COMPLETE_ROOT);
    extra("tsx-model-import");

    // EXPORT: the TSX format generates the document's model source in the
    // browser and holds it; the entry's download serves those bytes.
    await page.locator('[data-testid="complete-export"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    await page.getByTestId("cad-export-run-tsx").click();
    const entry = page.locator('[data-cad-export-entry="tsx"]');
    await expect(entry).toContainText("full document round-trip");
    const downloads = await collectDownloads(
      page,
      () => page.getByTestId("cad-export-download-tsx").click(),
      1,
      15_000,
    );
    const exported = await downloads[0]?.path();
    if (exported === undefined) throw new Error("the TSX export did not land");
    const source = await readFile(exported, "utf8");
    // The generated file carries the model's structural markers: the
    // compiler's inverse of the imported document (parameters first,
    // sketches at their first consumer, the feature DAG behind <Use>).
    expect(source).toContain("Generated by `generateTsx`");
    expect(source).toContain('from "@slopcad/cad-jsx"');
    expect(source).toContain("<Parameter");
    expect(source).toContain("<Sketch");
    expect(source).toContain("<Extrude");
    expect(source).toContain("<Revolve");
    expect(source).toContain("<Loft");
    expect(source).toContain("<Subtract");
    expect(source).toContain("<Union");
    expect(source).toContain('feature={"feat_plate"}');
    expect(source).not.toContain("DECLINED RECORDS");
    await page.keyboard.press("Escape");
    extra("tsx-model-export");

    // THE ROUND TRIP: the held TSX re-imports through the same server
    // loader and re-lands the identical timeline (the export's own proof
    // it recompiles).
    await page.locator('[data-testid="complete-import"]').click();
    await page.getByTestId("cad-import-held-tsx").click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "false",
    );
    await expect
      .poll(async () => {
        const roundTripped = await readTimeline(page, COMPLETE_ROOT);
        return roundTripped.entries.map((entry) => entry.kind).join(",");
      })
      .toBe("extrude,revolve,loft,subtract,union");
    await waitForSettledScene(page, COMPLETE_ROOT);
    extra("tsx-model-round-trip");
  });
});

test("s27 the WebMCP agent surface: registry snapshots on the workbench, projects, and assembly pages", async ({
  sessionPage: page,
}) => {
  await stage("s27 webmcp agent surface", async () => {
    // THE WORKBENCH SNAPSHOT: the eleven CAD tools the complete page
    // mounts, each with a JSON object input schema and honest usage
    // annotations (the seam is snapshot-only — see readWebMcpSnapshot).
    await openComplete(page);
    await expect
      .poll(async () =>
        (await readWebMcpSnapshot(page)).map((tool) => tool.name),
      )
      .toEqual([...WORKBENCH_WEBMCP_TOOLS]);
    const workbenchTools = await readWebMcpSnapshot(page);
    for (const tool of workbenchTools) {
      expect(schemaTypeOf(tool)).toBe("object");
    }
    expect(annotationsOf(workbenchTools, "cad_run_command")).toMatchObject({
      consequentialHint: true,
    });
    expect(
      annotationsOf(workbenchTools, "cad_get_document_summary"),
    ).toMatchObject({ readOnlyHint: true });
    expect(annotationsOf(workbenchTools, "cad_capture_views")).toMatchObject({
      readOnlyHint: true,
    });
    extra("webmcp-workbench-surface");

    // THE PROJECTS SNAPSHOT: the three workspace tools the authenticated
    // pages mount (the user is signed in since s26), same honesty rules.
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect
      .poll(async () =>
        (await readWebMcpSnapshot(page)).map((tool) => tool.name),
      )
      .toEqual([...PROJECTS_WEBMCP_TOOLS]);
    const projectsTools = await readWebMcpSnapshot(page);
    for (const tool of projectsTools) {
      expect(schemaTypeOf(tool)).toBe("object");
    }
    expect(annotationsOf(projectsTools, "projects_list")).toMatchObject({
      readOnlyHint: true,
    });
    expect(annotationsOf(projectsTools, "projects_create")).toMatchObject({
      consequentialHint: true,
    });
    expect(annotationsOf(projectsTools, "open_document")).toMatchObject({
      consequentialHint: true,
    });
    extra("webmcp-projects-surface");

    // THE ASSEMBLY SNAPSHOTS (Phase 2.2): the two mutable assembly pages
    // register the ten-tool set (reads + the occurrence/pattern/mate/joint
    // doors + the interference report); the interference fixture's document
    // is the page's constant, so it registers the reads and the report only.
    await page.goto("/workbench-assembly");
    await expect(page.locator("#assembly-workbench-root")).toHaveAttribute(
      "data-cad-hydrated",
      "true",
    );
    await expect
      .poll(async () =>
        (await readWebMcpSnapshot(page)).map((tool) => tool.name),
      )
      .toEqual([...ASSEMBLY_WEBMCP_TOOLS]);
    const assemblyTools = await readWebMcpSnapshot(page);
    for (const tool of assemblyTools) {
      expect(schemaTypeOf(tool)).toBe("object");
    }
    expect(annotationsOf(assemblyTools, "cad_get_document")).toMatchObject({
      readOnlyHint: true,
    });
    expect(
      annotationsOf(assemblyTools, "cad_assembly_add_occurrence"),
    ).toMatchObject({ consequentialHint: true });
    extra("webmcp-assembly-surface");

    await page.goto("/workbench-assembly-motion");
    await expect(page.locator("#assembly-motion-root")).toHaveAttribute(
      "data-cad-hydrated",
      "true",
    );
    await expect
      .poll(async () =>
        (await readWebMcpSnapshot(page)).map((tool) => tool.name),
      )
      .toEqual([...ASSEMBLY_WEBMCP_TOOLS]);
    extra("webmcp-assembly-motion-surface");

    await page.goto("/workbench-assembly-interference");
    await expect(page.locator("#interference-workbench-root")).toHaveAttribute(
      "data-cad-hydrated",
      "true",
    );
    await expect
      .poll(async () =>
        (await readWebMcpSnapshot(page)).map((tool) => tool.name),
      )
      .toEqual([...ASSEMBLY_READONLY_WEBMCP_TOOLS]);
    const interferenceTools = await readWebMcpSnapshot(page);
    expect(
      annotationsOf(interferenceTools, "cad_assembly_check_interference"),
    ).toMatchObject({ readOnlyHint: true });
    extra("webmcp-assembly-interference-surface");
  });
});

test("s28 parameter references: the $-token autocomplete drives and re-drives a draft extrude", async ({
  sessionPage: page,
}) => {
  await stage("s28 $param autocomplete + re-drive", async () => {
    // THE FEATURE (Phase 21): a value field accepts `$varname` with a
    // clickable autocomplete over the document's existing parameters. The
    // boot plate's `holeDiameter` (a length parameter, 8 mm after s05's
    // undo) is the existing var: the draft extrude's DISTANCE references
    // it, and editing the parameter re-drives BOTH features it drives.
    await openComplete(page);
    await enterSketchMode(page);
    await drawRectangle(page);
    await saveSketch(page);
    await saveThrowawaySketch(page, COMPLETE_ROOT);
    const base = Number(await waitForRootSettle(page, COMPLETE_ROOT));
    await openDialogViaMenu(page, COMPLETE_ROOT, "draft");

    // The profile: the fresh rectangle (20 × 15 = 300 mm²) — picked
    // explicitly; the throwaway line sketch is not a profile.
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 1", exact: true }).click();

    // THE AUTOCOMPLETE: typing `$` opens the document's parameter list;
    // clicking the row inserts the full `$holeDiameter` into the field.
    const distance = page.getByLabel("Distance (mm)");
    await distance.click();
    await distance.fill("$");
    const plateHeightRow = page.getByRole("option", {
      name: "$holeDiameter",
    });
    await expect(plateHeightRow).toBeVisible();
    await plateHeightRow.click();
    await expect(distance).toHaveValue("$holeDiameter");
    // Taper 0: the plain prism (the extrude kind's universal path).
    await page.getByLabel("Draft taper (deg)").fill("0");

    // SUBMIT: the field resolves against the document's parameters — the
    // feature input references the EXISTING parameter (no auto-created
    // depth literal) — and the geometry lands at exactly 300 × 8 mm³.
    const before = await dispatchedCount(page, COMPLETE_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const referenced = Number(
      await waitForRootSettle(page, COMPLETE_ROOT, { afterDispatch: before }),
    );
    const referencedPadVolume = (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0) * 8;
    expect(volumeNear(referenced, base + referencedPadVolume)).toBe(true);
    const timeline = await readTimeline(page, COMPLETE_ROOT);
    const draftEntry = timeline.entries.at(-1);
    expect(draftEntry?.kind).toBe("extrude");
    expect(draftEntry?.status).not.toBe("failed");

    // THE RE-DRIVE: editing the referenced parameter in the panel re-drives
    // the extrude (8 → 12 mm of pad) AND the plate's bore (⌀8 → ⌀12) — one
    // parameter, both features follow on the next dispatch.
    const beforeEdit = await dispatchedCount(page, COMPLETE_ROOT);
    await page.getByLabel("holeDiameter", { exact: true }).fill("12");
    await page.getByRole("button", { name: "Apply" }).click();
    const redriven = Number(
      await waitForRootSettle(page, COMPLETE_ROOT, {
        afterDispatch: beforeEdit,
      }),
    );
    const boredPlateVolume = 30 * 20 * 10 - Math.PI * 36 * 10;
    expect(
      volumeNear(redriven, boredPlateVolume + referencedPadVolume * 1.5),
    ).toBe(true);
    expect(redriven).not.toBe(referenced);
    extra("parameter-reference-autocomplete");
  });
});

test("s29 stored parameter expressions: the panel commits the expression, re-drives dependents, and refuses a cycle", async ({
  sessionPage: page,
}) => {
  await stage(
    "s29 panel expression commits + transitive re-drive + cycle",
    async () => {
      // THE FEATURE (Phase 22): an expression field commits the EXPRESSION
      // itself (`parameter.set` with a serialized AST), the document
      // re-derives the parameter's cached value and recomputes its dependents
      // in the same commit, and a closing cycle is refused with the chain
      // named. The boot document's expression pair is the stage's cast:
      // `volumeHint` and `boreRadius`, both defined over `holeDiameter`.
      await openComplete(page);
      const panel = page.locator('[data-slot="cad-parameter-panel"]');
      const apply = page.getByRole("button", { name: "Apply" });
      const volumeHintField = page.getByLabel("volumeHint", { exact: true });
      const boreRadiusField = page.getByLabel("boreRadius", { exact: true });
      await expect(volumeHintField).toHaveValue("holeDiameter * 2");
      await expect(boreRadiusField).toHaveValue("holeDiameter / 2");
      // The stage opens on a FRESH boot (the navigation above rebuilt the
      // boot document): holeDiameter = 8, the boot caches match, and the
      // previews re-evaluate live: 8 × 2 = 16.
      await expect(panel.getByText("= 16 mm", { exact: true })).toBeVisible();

      /** The root's serialized command log (the machine surface). */
      const readLog = async (): Promise<
        readonly { readonly commands: readonly Record<string, unknown>[] }[]
      > =>
        JSON.parse(
          (await page
            .locator(`#${COMPLETE_ROOT}`)
            .getAttribute("data-command-log")) ?? "[]",
        ) as readonly {
          readonly commands: readonly Record<string, unknown>[];
        }[];

      /** The machine log's committed-command count across transactions. */
      const logLength = async (): Promise<number> =>
        (await readLog()).reduce(
          (total, entry) => total + entry.commands.length,
          0,
        );

      // LEG 1 — the panel commits the expression: volumeHint :=
      // holeDiameter + 6mm (the unit literal keeps the addition
      // same-dimension — the domain refuses length + dimensionless). The
      // commit rides the vocabulary's expression payload (the serialized
      // AST, no value) and re-derives the cache (8 + 6 = 14) in the same
      // application.
      await volumeHintField.fill("holeDiameter + 6mm");
      await apply.click();
      await expect(volumeHintField).toHaveValue("holeDiameter + 6mm");
      await expect(panel.getByText("= 14 mm", { exact: true })).toBeVisible();
      const legOne = await readLog();
      const legOneCommand = legOne.at(-1)?.commands.at(-1);
      expect(legOneCommand?.type).toBe("parameter.set");
      expect(legOneCommand?.id).toBe("param_volume_hint");
      expect(legOneCommand?.value).toBeUndefined();
      expect(legOneCommand?.expression).toMatchObject({
        kind: "binary",
        left: { kind: "identifier", name: "holeDiameter" },
        operator: "+",
        right: { kind: "unitLiteral", value: 6, unit: "mm" },
      });

      // LEG 2 — chain a second expression onto the first: boreRadius :=
      // volumeHint / 2. Its preview line evaluates against the CACHED
      // environment, so `= 7 mm` (14 / 2) is reachable only because leg 1's
      // commit re-derived volumeHint's cache — the transitive proof.
      await boreRadiusField.fill("volumeHint / 2");
      await apply.click();
      await expect(boreRadiusField).toHaveValue("volumeHint / 2");
      await expect(panel.getByText("= 7 mm", { exact: true })).toBeVisible();

      // THE CYCLE — pointing volumeHint back at boreRadius closes the loop.
      // The field evaluator only validates parse/evaluate (it passes here),
      // so the refusal arrives from the commit and surfaces verbatim in the
      // panel's alert region — with the closing chain named. The machine log
      // is pinned through the refusal too: its length, captured before the
      // attempt, must survive unchanged (the ui suite's commandLog-length-0
      // guarantee, on the harness surface).
      const logBeforeCycle = await logLength();
      await volumeHintField.fill("boreRadius * 2");
      await apply.click();
      const cycleAlert = page.locator("[data-cad-param-panel-error]");
      await expect(cycleAlert).toBeVisible();
      expect(await cycleAlert.textContent()).toContain("parameter/cycle");
      expect(await cycleAlert.textContent()).toContain(
        "volumeHint → boreRadius → volumeHint",
      );
      // The refused commit was a never-happened commit: the stored
      // expressions are exactly what the DAG held, and nothing was issued.
      await expect(volumeHintField).toHaveValue("boreRadius * 2");
      await expect(boreRadiusField).toHaveValue("volumeHint / 2");
      expect(await logLength()).toBe(logBeforeCycle);

      // Restore: retyping volumeHint's stored expression makes the submit a
      // no-op for it — the alert clears on the next submit, and nothing is
      // issued.
      await volumeHintField.fill("holeDiameter + 6mm");
      await apply.click();
      await expect(cycleAlert).toHaveCount(0);
      await expect(panel.getByText("= 14 mm", { exact: true })).toBeVisible();

      // THE RE-DRIVE: editing `holeDiameter` — the literal both stored
      // expressions read — re-drives the panel's displayed value through the
      // stored expression (volumeHint 8 + 6 → 10 + 6 = 16) and re-settles
      // the boot plate at the new bore (the dispatch effect follows the
      // document identity, and the plate scene consumes the stored hole
      // diameter). The literal edit is a value-only commit, so boreRadius's
      // displayed line keeps reading volumeHint's cache (14 / 2 = 7) — the
      // domain's documented caching rule; the next expression commit
      // re-derives it.
      const before = await dispatchedCount(page, COMPLETE_ROOT);
      await page.getByLabel("holeDiameter", { exact: true }).fill("10");
      await apply.click();
      const redriven = Number(
        await waitForRootSettle(page, COMPLETE_ROOT, {
          afterDispatch: before,
        }),
      );
      await expect(panel.getByText("= 16 mm", { exact: true })).toBeVisible();
      await expect(panel.getByText("= 7 mm", { exact: true })).toBeVisible();
      expect(volumeNear(redriven, 30 * 20 * 10 - Math.PI * 25 * 10)).toBe(true);
      extra("parameter-expression-commit");
    },
  );
});

test("s30 variable manager: create, live autocomplete, expression switch, clear, refused self-cycle", async ({
  sessionPage: page,
}) => {
  await stage("s30 variable manager", async () => {
    // THE FEATURE (Phase 23): the parameter panel's manage mode — the
    // management surface for document parameters riding the vocabulary's
    // `parameter.create` and the expression/clear forms of `parameter.set`.
    // One variable, `caseHeight`, walks the whole life: created as a 10 mm
    // literal, consumed from a feature dialog's `$` autocomplete, switched
    // to `holeDiameter + 2mm` through the manager's own autocomplete,
    // re-driven by its reference, cleared back to a literal, and finally
    // refused a self-cycle with the chain named. LEG 6 adds the Phase 30
    // input-contract negatives: a NEGATIVE literal (`-25mm`) created
    // directly in the create form (the previously-refused input), a
    // `-$caseDepth` dialog reference typed through the autocomplete (the
    // sign riding the token), the feature landing on the negated
    // auto-parameter, and the re-drive through it when the source variable
    // moves.
    await openComplete(page);
    const panel = page.locator('[data-slot="cad-parameter-panel"]');

    /** The root's serialized command log (the machine surface). */
    const readLog = async (): Promise<
      readonly { readonly commands: readonly Record<string, unknown>[] }[]
    > =>
      JSON.parse(
        (await page
          .locator(`#${COMPLETE_ROOT}`)
          .getAttribute("data-command-log")) ?? "[]",
      ) as readonly {
        readonly commands: readonly Record<string, unknown>[];
      }[];

    /** The machine log's committed-command count across transactions. */
    const logLength = async (): Promise<number> =>
      (await readLog()).reduce(
        (total, entry) => total + entry.commands.length,
        0,
      );

    const manageToggle = page.getByRole("button", {
      name: "Manage variables",
    });
    const doneToggle = page.getByRole("button", { name: "Done", exact: true });
    await manageToggle.click();

    // The manager's rows (name + quantity + actions), located by variable.
    const caseRow = panel
      .locator('[data-slot="cad-parameter-row"]')
      .filter({ hasText: "caseHeight" });

    // LEG 1 — CREATE: `caseHeight` as a 10 mm literal. The commit is
    // `parameter.create` (the vocabulary's create form: name + quantity in
    // the domain's unit grammar), and the row appears from the live
    // collection.
    await panel.getByLabel("Name", { exact: true }).fill("caseHeight");
    await panel.getByLabel("Value", { exact: true }).fill("10mm");
    await panel.getByRole("button", { name: "Create variable" }).click();
    await expect(caseRow).toBeVisible();
    await expect(caseRow).toContainText("10 mm");
    const createCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(createCommand?.type).toBe("parameter.create");
    expect(createCommand?.name).toBe("caseHeight");
    expect(createCommand?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 10,
    });
    // The form reset for the next variable.
    await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("");

    // LEG 2 — THE FEATURE-DIALOG AUTOCOMPLETE DERIVES LIVE: the fresh
    // variable is immediately consumable as `$caseHeight` in a feature
    // form's `$` autocomplete (the draft extrude's Distance). The draft
    // command authoring gate needs two sketch records, so the stage draws
    // the profile rectangle plus the throwaway line sketch (s28's
    // precedent — neither is extruded; the dialog is asserted, then
    // dismissed).
    await doneToggle.click();
    await enterSketchMode(page);
    await drawRectangle(page);
    await saveSketch(page);
    await saveThrowawaySketch(page, COMPLETE_ROOT);
    await openDialogViaMenu(page, COMPLETE_ROOT, "draft");
    const distance = page.getByLabel("Distance (mm)");
    await distance.click();
    await distance.fill("$case");
    await expect(
      page.getByRole("option", { name: "$caseHeight" }),
    ).toBeVisible();
    // Close without submitting: the first Escape dismisses the open
    // autocomplete, the second the dialog (one may do both — dismiss until
    // gone).
    await page.keyboard.press("Escape");
    if (await page.locator(DIALOG).isVisible()) {
      await page.keyboard.press("Escape");
    }
    await expect(page.locator(DIALOG)).toBeHidden();

    // LEG 3 — EXPRESSION SWITCH through the manager's `$` autocomplete:
    // `caseHeight := holeDiameter + 2mm`. The suggestions exclude the
    // edited variable itself, a clicked row inserts the grammar's bare
    // identifier, and the live preview evaluates the current text.
    await manageToggle.click();
    await caseRow.getByRole("button", { name: "Set expression" }).click();
    const caseEditor = panel.getByLabel("caseHeight", { exact: true });
    await expect(caseEditor).toHaveValue("10");
    await caseEditor.fill("$hol");
    await panel.getByRole("option", { name: "$holeDiameter" }).click();
    await expect(caseEditor).toHaveValue("holeDiameter");
    await caseEditor.fill("holeDiameter + 2mm");
    // The preview: the boot's holeDiameter is 8, so 8 + 2.
    await expect(caseRow.getByText("= 10 mm", { exact: true })).toBeVisible();
    const logBeforeExpression = await logLength();
    await caseRow.getByRole("button", { name: "Apply" }).click();
    // Success closes the editor; the row reads the derived quantity and its
    // direct reference; the commit was the expression payload (the AST, no
    // value).
    await expect(caseEditor).toHaveCount(0);
    await expect(caseRow.getByText("= 10 mm", { exact: true })).toBeVisible();
    await expect(caseRow).toContainText("depends on holeDiameter");
    const expressionCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(expressionCommand?.type).toBe("parameter.set");
    expect(expressionCommand?.value).toBeUndefined();
    expect(expressionCommand?.expression).toMatchObject({
      kind: "binary",
      left: { kind: "identifier", name: "holeDiameter" },
      operator: "+",
      right: { kind: "unitLiteral", value: 2, unit: "mm" },
    });
    expect((await logLength()) - logBeforeExpression).toBe(1);

    // THE RE-DRIVE: editing the referenced literal (8 → 12) re-derives
    // caseHeight in the same commit — the edit-in-place form serves the
    // literal; the plate scene follows the new bore.
    await doneToggle.click();
    const beforeEdit = await dispatchedCount(page, COMPLETE_ROOT);
    await page.getByLabel("holeDiameter", { exact: true }).fill("12");
    await page.getByRole("button", { name: "Apply" }).click();
    const redriven = Number(
      await waitForRootSettle(page, COMPLETE_ROOT, {
        afterDispatch: beforeEdit,
      }),
    );
    expect(volumeNear(redriven, 30 * 20 * 10 - Math.PI * 36 * 10)).toBe(true);

    // LEG 4 — CLEAR back to literal: the vocabulary's clear-null form lands
    // on the expression's live evaluated quantity (12 + 2 = 14).
    await manageToggle.click();
    await expect(caseRow.getByText("= 14 mm", { exact: true })).toBeVisible();
    await caseRow.getByRole("button", { name: "Make literal" }).click();
    await expect(caseRow).toContainText("14 mm");
    const clearCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(clearCommand?.type).toBe("parameter.set");
    expect(clearCommand?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 14,
    });
    expect(clearCommand?.expression).toBeNull();

    // LEG 5 — THE REFUSED SELF-CYCLE: `caseHeight := caseHeight`, typed (the
    // self row is never suggested). The commit refuses with the closing
    // chain in the panel's alert region, and the machine log pins the
    // never-happened commit.
    const logAfterClear = await logLength();
    await caseRow.getByRole("button", { name: "Set expression" }).click();
    const cycleEditor = panel.getByLabel("caseHeight", { exact: true });
    await cycleEditor.fill("caseHeight");
    await caseRow.getByRole("button", { name: "Apply" }).click();
    const cycleAlert = page.locator("[data-cad-param-panel-error]");
    await expect(cycleAlert).toBeVisible();
    expect(await cycleAlert.textContent()).toContain("parameter/cycle");
    expect(await cycleAlert.textContent()).toContain("caseHeight → caseHeight");
    expect(await logLength()).toBe(logAfterClear);

    // LEG 6 — THE PHASE 30 NEGATIVES. (a) A NEGATIVE literal `-25mm` lands
    // directly in the create form — the input the literal-seed gate refused
    // before the widened rule (any identifier-free expression evaluating to
    // a finite quantity).
    // The row is pinned by its NAME SPAN (exact text): a plain hasText
    // would also catch the dependent row's `depends on caseDepth` line.
    const depthRow = panel
      .locator('[data-slot="cad-parameter-row"]')
      .filter({ has: page.getByText("caseDepth", { exact: true }) });
    await panel.getByLabel("Name", { exact: true }).fill("caseDepth");
    await panel.getByLabel("Value", { exact: true }).fill("-25mm");
    await panel.getByRole("button", { name: "Create variable" }).click();
    await expect(depthRow).toBeVisible();
    await expect(depthRow).toContainText("-25 mm");
    const depthCreate = (await readLog()).at(-1)?.commands.at(-1);
    expect(depthCreate?.type).toBe("parameter.create");
    expect(depthCreate?.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: -25,
    });

    // (b) THE NEGATED DIALOG REFERENCE: typing `-$` opens the autocomplete
    // (the sign rides the token), clicking the row inserts `-$caseDepth`,
    // and the submission emits the negated auto-parameter — a fresh
    // `parameter.create` whose defining expression is `-caseDepth` — with
    // the feature input referencing IT. The draft reuses LEG 2's rectangle
    // ("sketch 1", 20 × 15 = 300 mm²); the boot plate reads
    // 30·20·10 − π·12²/4·10 at this point (LEG 3's ⌀12 bore), and the pad
    // sits clear of it, so the volume pin is exact.
    await doneToggle.click();
    await openDialogViaMenu(page, COMPLETE_ROOT, "draft");
    await page.locator(`${DIALOG} [role="combobox"]`).nth(0).click();
    await page.getByRole("option", { name: "sketch 1", exact: true }).click();
    const negatedDistance = page.getByLabel("Distance (mm)");
    await negatedDistance.click();
    // The token opens on `-$` (the sign rides it); the stage narrows with
    // the partial because the suggestion list caps at 8 in document order.
    await negatedDistance.fill("-$ca");
    await expect(
      page.getByRole("option", { name: "$caseDepth" }),
    ).toBeVisible();
    await page.getByRole("option", { name: "$caseDepth" }).click();
    await expect(negatedDistance).toHaveValue("-$caseDepth");
    await page.getByLabel("Draft taper (deg)").fill("0");
    const beforeNegated = await dispatchedCount(page, COMPLETE_ROOT);
    await page.locator(DIALOG).getByRole("button", { name: "Create" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-scene-kind",
      "extrude",
    );
    const negatedVolume = Number(
      await waitForRootSettle(page, COMPLETE_ROOT, {
        afterDispatch: beforeNegated,
      }),
    );
    const boredPlate = 30 * 20 * 10 - Math.PI * 36 * 10;
    expect(volumeNear(negatedVolume, boredPlate + 300 * 25)).toBe(true);
    const negatedLog = await readLog();
    const negatedCommands = negatedLog.at(-1)?.commands ?? [];
    const negatedCreate = negatedCommands.find(
      (command) =>
        command.type === "parameter.create" && command.name === "extrudeDepth1",
    );
    expect(negatedCreate).toMatchObject({
      type: "parameter.create",
      name: "extrudeDepth1",
      // The seed is the negation of the source's current value (−25 → +25);
      // the defining expression re-derives the same quantity.
      value: { dimension: "length", unit: "mm", value: 25 },
      expression: {
        kind: "unary",
        operator: "-",
        operand: { kind: "identifier", name: "caseDepth" },
      },
    });
    const negatedTimeline = await readTimeline(page, COMPLETE_ROOT);
    expect(negatedTimeline.entries.at(-1)?.kind).toBe("extrude");
    expect(negatedTimeline.entries.at(-1)?.status).not.toBe("failed");

    // (c) THE RE-DRIVE: editing the source variable through the expression
    // arm (a constant expression with the unit attached — a bare `-30`
    // would be dimensionless; the commit that runs the topological
    // recompute; the panel's literal arm is the value-only form, which
    // leaves driven caches stale by the domain's documented rule)
    // re-derives the negated auto-parameter (−(−30 mm) = +30 mm) and the
    // feature moves with it. The manager's rows show both ends of the DAG:
    // caseDepth at −30 mm and extrudeDepth1 at `= 30 mm`, depends on
    // caseDepth.
    await manageToggle.click();
    await depthRow.getByRole("button", { name: "Set expression" }).click();
    const depthEditor = panel.getByLabel("caseDepth", { exact: true });
    await expect(depthEditor).toHaveValue("-25");
    await depthEditor.fill("-30mm");
    const beforeRedrive = await dispatchedCount(page, COMPLETE_ROOT);
    await depthRow.getByRole("button", { name: "Apply" }).click();
    await expect(depthEditor).toHaveCount(0);
    await expect(depthRow).toContainText("-30 mm");
    await expect(depthRow).toContainText("= -30 mm");
    const redrivenRow = panel
      .locator('[data-slot="cad-parameter-row"]')
      .filter({ has: page.getByText("extrudeDepth1", { exact: true }) });
    await expect(redrivenRow).toContainText("= 30 mm");
    await expect(redrivenRow).toContainText("depends on caseDepth");
    const redriveCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(redriveCommand?.type).toBe("parameter.set");
    expect(redriveCommand?.expression).toMatchObject({
      kind: "unary",
      operator: "-",
      operand: { kind: "unitLiteral", value: 30, unit: "mm" },
    });
    const redrivenVolume = Number(
      await waitForRootSettle(page, COMPLETE_ROOT, {
        afterDispatch: beforeRedrive,
      }),
    );
    expect(volumeNear(redrivenVolume, boredPlate + 300 * 30)).toBe(true);

    extra("parameter-negated-reference");
  });
});

test("s31 variable manager rename + delete: the rewrite is visible and the refusal names the blockers", async ({
  sessionPage: page,
}) => {
  await stage("s31 variable rename + delete", async () => {
    // THE FEATURE (Phase 24): the manager completes the variable lifecycle —
    // `parameter.rename` rewrites every stored expression referencing the
    // old name in the SAME commit (the dependent's stored AST and its
    // `depends on` line move to the new name; its evaluated value does not
    // move), and `parameter.delete` refuses while referenced — naming the
    // blockers — then deletes cleanly once they are cleared. The cast: a
    // literal base `shelfWidth` (20 mm) and `shelfDepth` defined over it
    // (`shelfWidth / 2`, cached 10 mm).
    await openComplete(page);
    const panel = page.locator('[data-slot="cad-parameter-panel"]');

    /** The root's serialized command log (the machine surface). */
    const readLog = async (): Promise<
      readonly { readonly commands: readonly Record<string, unknown>[] }[]
    > =>
      JSON.parse(
        (await page
          .locator(`#${COMPLETE_ROOT}`)
          .getAttribute("data-command-log")) ?? "[]",
      ) as readonly {
        readonly commands: readonly Record<string, unknown>[];
      }[];

    /** The machine log's committed-command count across transactions. */
    const logLength = async (): Promise<number> =>
      (await readLog()).reduce(
        (total, entry) => total + entry.commands.length,
        0,
      );

    /** The management row whose NAME TEXT is exactly `name` (a `depends on` line can mention another variable's name). */
    const rowOf = (name: string) =>
      panel
        .locator('[data-slot="cad-parameter-row"]')
        .filter({ has: page.getByText(name, { exact: true }) });

    const manageToggle = page.getByRole("button", {
      name: "Manage variables",
    });
    const doneToggle = page.getByRole("button", { name: "Done", exact: true });
    await manageToggle.click();

    // LEG 1 — CREATE the cast: `shelfWidth` = 20mm literal, then `shelfDepth`
    // defined over it (`shelfWidth / 2`). The define re-derives the cache in
    // the same application, so the row reads the derived 10 mm and its
    // direct reference.
    await panel.getByLabel("Name", { exact: true }).fill("shelfWidth");
    await panel.getByLabel("Value", { exact: true }).fill("20mm");
    await panel.getByRole("button", { name: "Create variable" }).click();
    await expect(rowOf("shelfWidth")).toBeVisible();
    await panel.getByLabel("Name", { exact: true }).fill("shelfDepth");
    await panel.getByLabel("Value", { exact: true }).fill("0mm");
    await panel.getByRole("button", { name: "Create variable" }).click();
    await expect(rowOf("shelfDepth")).toBeVisible();
    await rowOf("shelfDepth")
      .getByRole("button", { name: "Set expression" })
      .click();
    const depthEditor = panel.getByLabel("shelfDepth", { exact: true });
    await depthEditor.fill("shelfWidth / 2");
    await rowOf("shelfDepth").getByRole("button", { name: "Apply" }).click();
    await expect(depthEditor).toHaveCount(0);
    await expect(
      rowOf("shelfDepth").getByText("= 10 mm", { exact: true }),
    ).toBeVisible();
    await expect(
      rowOf("shelfDepth").getByText("depends on shelfWidth"),
    ).toBeVisible();

    // LEG 2 — THE RENAME: `shelfWidth` → `caseWidth` through the row's
    // rename editor. The commit is `parameter.rename`; the dependent's
    // stored expression is rewritten in the same application — its
    // `depends on` line moves to the new name while the evaluated value
    // stays exactly 10 mm (the rewrite is name-isomorphic).
    await rowOf("shelfWidth").getByRole("button", { name: "Rename" }).click();
    const renameField = panel.getByLabel("New name", { exact: true });
    await renameField.fill("caseWidth");
    await rowOf("shelfWidth").getByRole("button", { name: "Apply" }).click();
    await expect(renameField).toHaveCount(0);
    await expect(rowOf("caseWidth")).toBeVisible();
    await expect(rowOf("shelfWidth")).toHaveCount(0);
    await expect(
      rowOf("shelfDepth").getByText("depends on caseWidth"),
    ).toBeVisible();
    await expect(
      rowOf("shelfDepth").getByText("= 10 mm", { exact: true }),
    ).toBeVisible();
    const renameCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(renameCommand?.type).toBe("parameter.rename");
    expect(renameCommand?.name).toBe("caseWidth");

    // THE FEATURE-DIALOG AUTOCOMPLETE DERIVES LIVE: the NEW name is the
    // vocabulary — `$case` lists `$caseWidth`, and the OLD name is gone
    // from the grammar (no `$shelfWidth` row exists to pick). The draft
    // command authoring gate needs two sketch records (s28/s30's
    // precedent — neither is extruded; the dialog is asserted, then
    // dismissed).
    await doneToggle.click();
    await enterSketchMode(page);
    await drawRectangle(page);
    await saveSketch(page);
    await saveThrowawaySketch(page, COMPLETE_ROOT);
    await openDialogViaMenu(page, COMPLETE_ROOT, "draft");
    const distance = page.getByLabel("Distance (mm)");
    await distance.click();
    await distance.fill("$case");
    await expect(
      page.getByRole("option", { name: "$caseWidth" }),
    ).toBeVisible();
    await expect(page.getByRole("option", { name: "$shelfWidth" })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    if (await page.locator(DIALOG).isVisible()) {
      await page.keyboard.press("Escape");
    }
    await expect(page.locator(DIALOG)).toBeHidden();

    // LEG 3 — THE REFUSED DELETE: `caseWidth` is still read by shelfDepth's
    // stored expression. Arming issues nothing; the confirm is refused with
    // `document/in-use` naming the blocker (the dependent, by name), and
    // the row survives.
    await manageToggle.click();
    const logBeforeRefusal = await logLength();
    await rowOf("caseWidth").getByRole("button", { name: "Delete" }).click();
    await expect(
      rowOf("caseWidth").getByRole("button", { name: "Confirm delete" }),
    ).toBeVisible();
    expect(await logLength()).toBe(logBeforeRefusal);
    await rowOf("caseWidth")
      .getByRole("button", { name: "Confirm delete" })
      .click();
    const refusal = page.locator("[data-cad-param-panel-error]");
    await expect(refusal).toBeVisible();
    expect(await refusal.textContent()).toContain("document/in-use");
    expect(await refusal.textContent()).toContain("shelfDepth");
    expect(await logLength()).toBe(logBeforeRefusal);
    await expect(rowOf("caseWidth")).toBeVisible();

    // LEG 4 — CLEAR THE BLOCKER: making `shelfDepth` a literal drops the
    // reference (its evaluated quantity lands, the depends line is gone),
    // and the base now deletes cleanly.
    await rowOf("shelfDepth")
      .getByRole("button", { name: "Make literal" })
      .click();
    await expect(
      rowOf("shelfDepth").getByText("10 mm", { exact: true }),
    ).toBeVisible();
    await expect(rowOf("shelfDepth").getByText(/depends on/)).toHaveCount(0);
    await expect(refusal).toHaveCount(0);
    await rowOf("caseWidth").getByRole("button", { name: "Delete" }).click();
    await rowOf("caseWidth")
      .getByRole("button", { name: "Confirm delete" })
      .click();
    await expect(rowOf("caseWidth")).toHaveCount(0);
    const deleteCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(deleteCommand?.type).toBe("parameter.delete");
    expect(deleteCommand?.id).toBe(renameCommand?.id);

    // LEG 5 — THE UNREFERENCED DEPENDENT DELETES CLEANLY: nothing reads
    // `shelfDepth` (and its own definition is a literal now), so the
    // two-click confirm removes the row without a refusal.
    await rowOf("shelfDepth").getByRole("button", { name: "Delete" }).click();
    await rowOf("shelfDepth")
      .getByRole("button", { name: "Confirm delete" })
      .click();
    await expect(rowOf("shelfDepth")).toHaveCount(0);
    const lastCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(lastCommand?.type).toBe("parameter.delete");
    expect(lastCommand?.id).not.toBe(deleteCommand?.id);

    extra("parameter-manager-rename-delete");
  });
});

test("s32 sketch dimensions bind to variables: the $-autocomplete re-drives the sketch and the solid", async ({
  sessionPage: page,
}) => {
  await stage("s32 sketch dimension binding", async () => {
    // THE FEATURE (Phase 26a — the owner's commission: "I need to be able
    // to set the size of my perfboard"): a sketch dimension takes `$boardL`
    // as its value through the inspector's `$`-autocomplete, the binding
    // re-drives the LIVE sketch when the variable edits, and the case
    // extruded from that sketch re-drives downstream — one variable moving
    // drawn geometry and solid in the same commit.
    await openComplete(page);
    const panel = page.locator('[data-slot="cad-parameter-panel"]');

    /** The root's serialized command log (the machine surface). */
    const readLog = async (): Promise<
      readonly { readonly commands: readonly Record<string, unknown>[] }[]
    > =>
      JSON.parse(
        (await page
          .locator(`#${COMPLETE_ROOT}`)
          .getAttribute("data-command-log")) ?? "[]",
      ) as readonly {
        readonly commands: readonly Record<string, unknown>[];
      }[];

    /** The sketch session's serialized command log (data-sketch-commands). */
    const sketchLog = async (): Promise<readonly Record<string, unknown>[]> =>
      JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-commands")) ??
          "[]",
      ) as readonly Record<string, unknown>[];

    // LEG 1 — CAST THE VARIABLE: `boardL` = 26 mm (deliberately NOT the
    // drawn width — the binding must visibly re-drive the sketch).
    await page.getByRole("button", { name: "Manage variables" }).click();
    await panel.getByLabel("Name", { exact: true }).fill("boardL");
    await panel.getByLabel("Value", { exact: true }).fill("26mm");
    await panel.getByRole("button", { name: "Create variable" }).click();
    const boardRow = panel
      .locator('[data-slot="cad-parameter-row"]')
      .filter({ hasText: "boardL" });
    await expect(boardRow).toBeVisible();
    const createCommand = (await readLog()).at(-1)?.commands.at(-1);
    expect(createCommand?.type).toBe("parameter.create");
    expect(createCommand?.name).toBe("boardL");
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // LEG 2 — DRAW AND DIMENSION: the journey rectangle, then a distanceX
    // across it (left edge midpoint → right edge midpoint = the drawn
    // width, 20). The new constraint auto-selects, so the inspector's
    // dimension field reads the literal.
    await enterSketchMode(page);
    await drawRectangle(page);
    await activateSketchTool(page, "distanceX");
    await clickCanvasPoint(page, RECT.x0, (RECT.y0 + RECT.y1) / 2);
    await clickCanvasPoint(page, RECT.x1, (RECT.y0 + RECT.y1) / 2);
    const field = page.getByLabel("Dimension (mm)");
    await expect(field).toHaveValue("20");

    // LEG 3 — THE BINDING: type `$board`, pick `$boardL` from the live
    // autocomplete, apply. The commit is the BOUND `sketch.dimension.set`
    // (parameterId, no value), the inspector row names the binding, and the
    // sketch RE-SOLVES against the variable: the readout reads 26 mm and
    // the solved geometry spans 26 — the drawn 20 is gone.
    await field.click();
    await field.fill("$board");
    await page.getByRole("option", { name: "$boardL" }).click();
    await expect(field).toHaveValue("$boardL");
    await page
      .locator(`${SKETCH} form`)
      .getByRole("button", { name: "Apply" })
      .click();
    const boundCommand = (await sketchLog()).at(-1);
    expect(boundCommand?.type).toBe("sketch.dimension.set");
    expect(String(boundCommand?.parameterId)).toMatch(/^param_/);
    expect(boundCommand?.value).toBeUndefined();
    await expect(
      page
        .locator(`${SKETCH} [data-slot="cad-sketch-inspector"]`)
        .getByText("distanceX $boardL"),
    ).toBeVisible();
    await expect(page.locator(SKETCH)).toHaveAttribute(
      "data-sketch-dimensions",
      /Δx 26 mm/,
    );
    const spanOfSolved = async (): Promise<number> => {
      const solved = JSON.parse(
        (await page.locator(SKETCH).getAttribute("data-sketch-solved")) ?? "[]",
      ) as { kind: string; x1?: number; x2?: number }[];
      const xs = solved
        .filter((entity) => entity.kind === "line")
        .flatMap((line) => [line.x1 ?? 0, line.x2 ?? 0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(await spanOfSolved()).toBeCloseTo(26, 3);

    // LEG 4 — THE DANGLING ATTEMPT IS REFUSED: `$nope` names no variable;
    // the field gate names it the moment it is typed and the Apply button
    // disables — an unknown token cannot leave the field, and nothing
    // commits. (The feature dialogs' expressionNumber gate, same rule.)
    const sketchLogLength = (await sketchLog()).length;
    await field.click();
    await field.fill("$nope");
    await expect(page.getByText('Unknown parameter "nope".')).toBeVisible();
    await expect(
      page.locator(`${SKETCH} form`).getByRole("button", { name: "Apply" }),
    ).toBeDisabled();
    expect((await sketchLog()).length).toBe(sketchLogLength);

    // LEG 5 — THE CASE: extrude the bound sketch (auto-exits to the model
    // workspace). The document scene settles at the boot plate + the case
    // at the CURRENT variable: 26 × 15 × 10.
    const beforeExtrude = await dispatchedCount(page, COMPLETE_ROOT);
    await page.locator('[data-testid="sketch-extrude"]').click();
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-sketch-mode",
      "model",
    );
    const extruded = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: beforeExtrude,
    });
    expect(
      volumeNear(
        Number(extruded),
        BOOT_PLATE_VOLUME + 26 * 15 * EXTRUDE_DEFAULT_DEPTH_MM,
      ),
    ).toBe(true);

    // LEG 6 — THE DOWNSTREAM RE-DRIVE: edit `boardL` 26 → 40 in the
    // manager. The bound sketch re-solves at profile time, the extrusion
    // re-derives, and the settled volume follows — the perfboard resized by
    // one variable edit, no new sketch.
    const beforeEdit = await dispatchedCount(page, COMPLETE_ROOT);
    await page.getByLabel("boardL", { exact: true }).fill("40");
    await page.getByRole("button", { name: "Apply" }).click();
    const redriven = await waitForRootSettle(page, COMPLETE_ROOT, {
      afterDispatch: beforeEdit,
    });
    expect(
      volumeNear(
        Number(redriven),
        BOOT_PLATE_VOLUME + 40 * 15 * EXTRUDE_DEFAULT_DEPTH_MM,
      ),
    ).toBe(true);

    extra("sketch-dimension-binding");
  });
});

test("s33 the viewer: a shared part renders, re-drives, refuses, shares, exports, and embeds", async ({
  sessionPage: page,
  baseURL,
}) => {
  await stage("s33 viewer", async () => {
    // The shared document is REAL: the workbench boot session serialized
    // through the native bridge — five literal variables, two expression
    // variables, and the plate whose volume the pins below derive from.
    const nativeText = serializeSessionToNativeText(
      createCadWorkbenchSession(),
      new Map(),
      null,
      {},
      null,
      new Set(),
    );
    const payload = await encodeNativeForShare(nativeText);
    const sharePayloadUrl = `/viewer#${payload}`;

    // LEG 1 — THE SHARE PAGE: the link opens the public viewer, the part
    // settles, and the site chrome is around it.
    await page.goto(sharePayloadUrl);
    walk("/viewer");
    const settled = await waitForSettledScene(page, "viewer-root");
    expect(volumeNear(Number(settled), BOOT_PLATE_VOLUME)).toBe(true);
    await expect(page.locator("header")).toHaveCount(1);

    // LEG 2 — THE VARIABLES FORM: literals as number fields, expressions
    // with their `= quantity` preview line.
    await expect(page.getByLabel("holeDiameter", { exact: true })).toHaveValue(
      "8",
    );
    await expect(page.getByText("= 16 mm")).toBeVisible();
    expect(await page.getByTestId("viewer-summary").textContent()).toContain(
      "5 literal variables",
    );

    // LEG 3 — THE RE-DRIVE: an edit commits parameter.set through the SAME
    // store path the workbench panel uses; the plate re-derives.
    const beforeEdit = await dispatchedCount(page, "viewer-root");
    await page.getByLabel("holeDiameter", { exact: true }).fill("12");
    await page.getByRole("button", { name: "Apply" }).click();
    const redriven = await waitForSettledScene(page, "viewer-root", {
      afterDispatch: beforeEdit,
    });
    expect(volumeNear(Number(redriven), 30 * 20 * 10 - Math.PI * 36 * 10)).toBe(
      true,
    );

    // LEG 4 — THE EXPRESSION PATH: a committed rewrite previews its new
    // quantity; an unknown identifier refuses inline and blocks the
    // commit (nothing ships).
    const hintField = page.getByLabel("volumeHint", { exact: true });
    await hintField.fill("holeDiameter * 3");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("= 36 mm")).toBeVisible();
    await hintField.fill("nope * 2");
    await expect(page.getByText('Unknown identifier "nope".')).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
    // The preview line follows the COMMITTED expression (the field's
    // inline verdict is the live part); restoring the text and committing
    // is what moves the preview.
    await hintField.fill("holeDiameter * 2");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("= 24 mm")).toBeVisible();

    // LEG 5 — THE SHARE LINK: copies the LIVE document (the two edits
    // included) and the fragment decodes back to a real native document.
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("viewer-share").click();
    await expect(page.getByTestId("viewer-action")).toContainText(
      "share link copied",
    );
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith(`${baseURL}/viewer#1`)).toBe(true);
    const decoded = await decodeNativeFromShare(
      copied.slice(copied.indexOf("#")),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const reparsed = JSON.parse(decoded.text) as {
        document: { parameters: { parameters: { name: string }[] } };
      };
      expect(reparsed.document.parameters.parameters.length).toBe(7);
    }

    // LEG 6 — THE STANDALONE EXPORT: one self-contained HTML lands with
    // the site chrome, the viewer bundle, and the native variable inside.
    const downloads = await collectDownloads(
      page,
      async () => {
        await page.getByTestId("viewer-export").click();
        await expect(page.getByTestId("viewer-action")).toContainText(
          "standalone HTML downloaded",
        );
      },
      1,
      20_000,
    );
    const download = downloads[0];
    if (download === undefined) throw new Error("the export never landed");
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    const downloadPath = await download.path();
    if (downloadPath === null) throw new Error("download has no path");
    const bytes = await readFile(downloadPath);
    // Size honesty: the renderer and the kernel travel inside — the file
    // is multi-megabyte by construction.
    expect(bytes.length).toBeGreaterThan(500_000);
    const html = bytes.toString("utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('window["__SLOPCAD_NATIVE__"] = ');
    expect(html).toContain('window["__SLOPCAD_TITLE__"] = ');
    expect(html).toContain("holeDiameter");
    expect(html).toContain("<style>");

    // LEG 7 — THE EMBED: the scoped header guarantee on the route, then a
    // REAL host page framing the viewer (?embed=1, no site bar) whose
    // part settles and whose form renders inside the frame. The header is
    // the policy module's value verbatim (scheme allow, not `*` — the
    // spec's `*` refuses opaque-origin embedders). The HOST is a local
    // file (an opaque origin, genuinely cross-origin to the app): a
    // data:-URL host would be refused by Chromium's local-network-access
    // checks — a dev-only artifact of framing a loopback server that no
    // real embedding site (public http/https) ever hits.
    const embedResponse = await page.request.get(`${baseURL}/viewer?embed=1`);
    expect(embedResponse.headers()["content-security-policy"]).toBe(
      VIEWER_FRAME_HEADERS["content-security-policy"],
    );
    const embedUrl = `${baseURL}/viewer?embed=1#${payload}`;
    const hostPage = `<!doctype html><html><body style="margin:0"><iframe id="embed" src="${embedUrl}" style="width:960px;height:640px;border:1px solid #ccc"></iframe></body></html>`;
    const hostPath = join(
      os.tmpdir(),
      `slopcad-session-embed-${String(Date.now())}.html`,
    );
    await writeFile(hostPath, hostPage, "utf8");
    try {
      await page.goto(`file://${hostPath}`);
      const frame = page.frameLocator("#embed");
      // The pristine shared document again: the embed proof is the link
      // exactly as a third site receives it.
      const frameRoot = frame.locator("#viewer-root");
      await expect(frameRoot).toBeVisible();
      await expect(frame.locator("header")).toHaveCount(0);
      await expect(frame.getByTestId("viewer-title")).toContainText("doc_");
      await expect
        .poll(
          async () => {
            const volume = await frameRoot.getAttribute("data-volume");
            const rendered = await frameRoot.getAttribute(
              "data-cad-rendered-volume",
            );
            return (
              volume !== null &&
              volume !== "" &&
              volume !== "…" &&
              volume === rendered
            );
          },
          { timeout: 25_000 },
        )
        .toBe(true);
      await expect(
        frame.getByLabel("holeDiameter", { exact: true }),
      ).toHaveValue("8");
    } finally {
      await rm(hostPath, { force: true });
    }

    extra("viewer-share-embed");
  });
});

// ---------------------------------------------------------------------------
// The agent chat walk (PLAN-AGENT-CHAT Phase 6): ONE serial user, the real
// production server, the real SQLite file, and the loopback agent fixture
// (see the fixture block near the top) — client-direct runs against the
// scripted OpenAI-compatible endpoint, the catalog refresh against the
// fixture's trimmed models.dev JSON, the relay against the same endpoint
// with the ENV key. Zero external network, zero page.route seams.
// ---------------------------------------------------------------------------

test("s34 agent chat: the right-sidebar view (D16), settings, and the four palette commands", async ({
  sessionPage: page,
}) => {
  await stage("s34 agent chat view + settings + palette commands", async () => {
    await openComplete(page);
    const dock = page.getByTestId("workbench-panels-dock");
    await expect(dock).toHaveAttribute("data-agent-view", "sidebar");
    await expect(page.getByTestId("right-sidebar-view-switch")).toBeVisible();

    // D16: the segmented switch flips the dock to the chat; the panels
    // column is hidden, never unmounted.
    await page.getByTestId("right-sidebar-view-chat").click();
    await expect(dock).toHaveAttribute("data-agent-view", "chat");
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();

    // D5: unconfigured is honest — the composer is disabled WITH a reason
    // and the empty state points at settings.
    const composer = page.getByLabel("Chat message");
    await expect(composer).toBeDisabled();
    await expect(page.getByTestId("agent-chat-empty")).toBeVisible();
    await expect(
      page.getByText(
        "Pick a provider and a model in agent settings — nothing is preselected.",
      ),
    ).toBeVisible();

    // THE FOUR PALETTE COMMANDS (the manifest entries this phase adds):
    // the toggle round-trips the view through the menu row itself.
    await runCommand(page, COMPLETE_ROOT, "agent-chat-toggle");
    await expect(dock).toHaveAttribute("data-agent-view", "sidebar");
    await runCommand(page, COMPLETE_ROOT, "agent-chat-toggle");
    await expect(dock).toHaveAttribute("data-agent-view", "chat");
    cover("agent-chat-toggle");

    // The settings sheet opens through its palette row; the seeded catalog
    // (zero network) feeds the picker for a NAMED provider, and the model
    // is chosen through it — nothing preselected, nothing typed by hand.
    await runCommand(page, COMPLETE_ROOT, "agent-settings");
    const dialog = page.getByTestId("agent-settings-dialog");
    await expect(dialog).toBeVisible();
    cover("agent-settings");
    await page.getByLabel("Provider", { exact: true }).click();
    await page.getByRole("option", { name: "OpenAI", exact: true }).click();
    const modelField = page.getByLabel("Model", { exact: true });
    await modelField.click();
    // The catalog option buttons carry the model id beneath the label.
    const catalogOption = dialog.locator("button:has(span.text-xs)").first();
    await expect(catalogOption).toBeVisible();
    await catalogOption.click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(dialog).toBeHidden();
    extra("agent-settings-catalog-picker");

    // D7 + the palette refresh command: force-refresh the configured named
    // provider against the loopback fixture's models.dev JSON — the REAL
    // refresh path runs (fetch → filter → replace rows), and the sheet
    // reports the outcome.
    await runCommand(page, COMPLETE_ROOT, "agent-catalog-refresh");
    cover("agent-catalog-refresh");
    await runCommand(page, COMPLETE_ROOT, "agent-settings");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("agent-settings-refresh-row")).toContainText(
      "Catalog refetched.",
    );

    // D14: reconfigure onto the BYO endpoint — the endpoint's OWN /models
    // list (browser-direct, the user's key, CORS against the loopback)
    // feeds the picker; sync is opted in for the persistence stages.
    await page.getByLabel("Provider", { exact: true }).click();
    await page
      .getByRole("option", { name: "OpenAI-compatible endpoint" })
      .click();
    await page.getByPlaceholder("sk-…").fill(AGENT_FIXTURE_USER_KEY);
    await page.getByLabel("Endpoint base URL").fill(`${AGENT_FIXTURE_URL}/v1`);
    // The raw model id field remembers the openai choice from the first
    // save and would OVERRIDE the picker (D5's explicit-string rule), so
    // it is emptied for the endpoint's own model to be the pick.
    await page.getByLabel("Model id", { exact: true }).fill("");
    await page.getByTestId("agent-settings-refetch-endpoint").click();
    // The picker's dropdown opens on focus; its options arrive from the
    // re-fetched endpoint list (async, debounced). The remembered Model
    // field still carries the openai pick, which would FILTER the endpoint
    // list — it is cleared so the empty query lists the endpoint's models.
    await modelField.fill("");
    await modelField.click();
    const endpointOption = dialog.getByRole("button", {
      name: "fixture-primary",
      exact: true,
    });
    await expect(endpointOption).toBeVisible();
    await endpointOption.click();
    await page
      .getByRole("switch", { name: "Sync conversations to the server" })
      .click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(dialog).toBeHidden();

    // Configured (D5): the composer opens and the model slot names the
    // provider + model pair the picker chose.
    await expect(composer).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Open agent settings" }),
    ).toContainText("openai-compatible · fixture-primary");
    extra("agent-settings-endpoint-picker");
  });
});

test("s35 agent client-direct run: a scripted tool call changes the real document", async ({
  sessionPage: page,
}) => {
  await stage("s35 agent tool loop on the real store", async () => {
    // A fresh boot plate (⌀8 bore); the chat view persisted from s34.
    await openComplete(page);
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();
    await expect
      .poll(async () =>
        Number(await rootAttribute(page, "data-cad-rendered-volume")),
      )
      .toBeCloseTo(BOOT_PLATE_VOLUME, -1);

    // The scripted wire: a model-emitted cad_apply_commands tool call,
    // then the text turn the continuation (with the tool result) answers.
    await scriptAgentResponses(page, [
      {
        kind: "tool-call",
        name: "cad_apply_commands",
        input: { commands: [AGENT_SET_HOLE_11] },
      },
      { kind: "text", text: "The hole diameter is now 11 mm." },
    ]);
    const callBaseline = (await agentFixtureCalls(page)).length;
    await page
      .getByLabel("Chat message")
      .fill("Set the hole diameter to 11 mm.");
    await page.getByRole("button", { name: "Send message" }).click();

    // The request side renders the applied command (D4's display-only diff).
    await expect(
      page.getByTestId("agent-tool-call-part").first(),
    ).toContainText("Apply 1 command");
    await expect(page.getByTestId("agent-command-row").first()).toContainText(
      "param_hole_diameter = 11 mm",
    );
    // The loop auto-continued and the assistant's final text arrived.
    await expect(
      page.getByText("The hole diameter is now 11 mm."),
    ).toBeVisible();

    // THE DOCUMENT CHANGED through the real store and the real command
    // path: the settled volume is the boot plate with the ⌀11 bore.
    await expect
      .poll(async () =>
        Number(await rootAttribute(page, "data-cad-rendered-volume")),
      )
      .toBeCloseTo(bootPlateVolumeWithHole(11), -1);
    await waitForRootSettle(page, COMPLETE_ROOT);

    // The wire proves the loop: call #1 declared the tools and carried the
    // USER's key (D1 — the browser called the endpoint itself); call #2
    // fed the executed tool's result back as a tool-role message.
    const runCalls = (await agentFixtureCalls(page)).slice(callBaseline);
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.declaredTools).toBe(true);
    expect(runCalls[0]?.authorization).toBe(`Bearer ${AGENT_FIXTURE_USER_KEY}`);
    expect(runCalls[1]?.roles).toContain("tool");
    await waitForAgentSyncSettled(page);
    extra("agent-client-tool-loop");
  });
});

test("s36 agent image feedback: cad_capture_views single view, then multi-angle (D10)", async ({
  sessionPage: page,
}) => {
  await stage("s36 agent capture views", async () => {
    await openComplete(page);
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();
    // The OPFS resume is async (worker + WASM under SwiftShader): the
    // prior conversation's tail must be back BEFORE the next send, or the
    // controller's documented live-work-wins fence would start a second
    // conversation for the incoming message.
    await expect(page.getByText("The hole diameter is now 11 mm.")).toBeVisible(
      { timeout: 15_000 },
    );

    // ONE view — the common case. The capture runs the page's own camera
    // overlay + frame-settle + live-canvas machinery under SwiftShader.
    await scriptAgentResponses(page, [
      {
        kind: "tool-call",
        name: "cad_capture_views",
        input: { views: [{ preset: "iso" }] },
      },
      { kind: "text", text: "Captured the isometric view." },
    ]);
    await page
      .getByLabel("Chat message")
      .fill("Capture the current model from the iso view.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("agent-view-label")).toHaveText("iso");
    await expect(page.getByTestId("agent-capture-gallery")).toBeVisible();
    await expect(page.getByTestId("agent-captured-view")).toHaveCount(1);

    // SEVERAL angles in ONE call (D10's option): the four standard views,
    // frame-settled per view, the user's camera restored on exit.
    await scriptAgentResponses(page, [
      {
        kind: "tool-call",
        name: "cad_capture_views",
        input: {
          views: [
            { preset: "front" },
            { preset: "top" },
            { preset: "right" },
            { preset: "iso" },
          ],
        },
      },
      { kind: "text", text: "Captured four angles in one call." },
    ]);
    await page
      .getByLabel("Chat message")
      .fill("Capture front, top, right, and iso in one call.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByText("Captured four angles in one call."),
    ).toBeVisible();
    // 1 (previous gallery) + 4 (this run) images, the gallery's summary
    // naming all four captured views in order.
    await expect(page.getByTestId("agent-captured-view")).toHaveCount(5);
    const gallery = page.getByTestId("agent-capture-gallery").last();
    await expect(gallery).toContainText(
      "Captured 4 views: view-front.png, view-top.png, view-right.png, view-iso.png.",
    );
    await expect(gallery.getByTestId("agent-captured-view")).toHaveCount(4);
    // The restored camera leaves the scene settled.
    await waitForRootSettle(page, COMPLETE_ROOT);
    await waitForAgentSyncSettled(page);
    extra("agent-capture-views");
  });
});

test("s37 agent tool errors: the deliberately bad command surfaces the D9 diagnostics", async ({
  sessionPage: page,
}) => {
  await stage("s37 agent diagnostics + error turn", async () => {
    await openComplete(page);
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();
    // The resumed conversation's tail (see s36): one conversation, resumed
    // before the next send.
    await expect(
      page.getByText("Captured four angles in one call."),
    ).toBeVisible({ timeout: 15_000 });
    // A fresh page load boots the ⌀8 plate (the s35 edit lived in that
    // page's store); the transcript, not the document, is what persists.
    const settledVolume = Number(
      await rootAttribute(page, "data-cad-rendered-volume"),
    );
    expect(settledVolume).toBeCloseTo(BOOT_PLATE_VOLUME, -1);

    // A deliberately malformed command (wrong format version): the strict
    // parser refuses, NOTHING applies, and the refusal surfaces BOTH as
    // the refused row on the request side and as the structured error part
    // rendered by the diagnostics chip (code + message, severity-colored).
    await scriptAgentResponses(page, [
      {
        kind: "tool-call",
        name: "cad_apply_commands",
        input: { commands: [AGENT_BAD_COMMAND] },
      },
      { kind: "text", text: "That command was refused; nothing was applied." },
    ]);
    await page
      .getByLabel("Chat message")
      .fill("Apply this deliberately malformed command.");
    await page.getByRole("button", { name: "Send message" }).click();
    const refusedRow = page.locator(
      '[data-testid="agent-command-row"][data-refused="true"]',
    );
    await expect(refusedRow).toContainText("formatVersion 1");
    const chip = page.getByTestId("agent-diagnostic-chip");
    await expect(chip).toHaveAttribute("data-severity", "error");
    await expect(chip).toContainText("command/version-unsupported");
    await expect(chip).toContainText("formatVersion 1");
    await expect(
      page.getByText("That command was refused; nothing was applied."),
    ).toBeVisible();
    // The document was NOT mutated by the refused batch.
    await expect
      .poll(async () =>
        Number(await rootAttribute(page, "data-cad-rendered-volume")),
      )
      .toBeCloseTo(BOOT_PLATE_VOLUME, -1);
    extra("agent-diagnostics-chip");

    // THE ERROR TURN: a provider failure on the next run surfaces as the
    // run's error line (never silent, never fake success). A 400 — the
    // OpenAI SDK auto-retries 5xx, which would burn the one scripted
    // response and then hit the fixture's loud unscripted 500.
    await scriptAgentResponses(page, [
      {
        kind: "http-error",
        status: 400,
        message: "fixture provider exploded",
      },
    ]);
    await page.getByLabel("Chat message").fill("This one will fail upstream.");
    await page.getByRole("button", { name: "Send message" }).click();
    const errorLine = page.getByTestId("agent-chat-error");
    await expect(errorLine).toBeVisible();
    await expect(errorLine).toContainText("fixture provider exploded");
    await waitForAgentSyncSettled(page);
    extra("agent-error-turn");
  });
});

test("s38 agent chat persistence: drag-resize persists, view switch and reload restore (D16/D3)", async ({
  sessionPage: page,
}) => {
  await stage("s38 agent resize + persistence + sync push", async () => {
    await openComplete(page);
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();
    // The resumed conversation's tail (see s36): the bad-command exchange.
    await expect(
      page.getByText("Apply this deliberately malformed command."),
    ).toBeVisible({ timeout: 15_000 });
    const dock = page.getByTestId("workbench-panels-dock");
    const dockWidth = async (): Promise<number> =>
      dock.evaluate((element) => element.getBoundingClientRect().width);
    const widthBefore = await dockWidth();

    // DRAG-RESIZE (D16): pointer capture on the separator handle, dragged
    // left — the right-anchored dock widens.
    const handleBox = await page
      .getByTestId("right-sidebar-resize-handle")
      .boundingBox();
    if (handleBox === null) throw new Error("the resize handle has no box");
    const handleY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleY);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 120, handleY, { steps: 8 });
    await page.mouse.up();
    const widthDragged = await dockWidth();
    expect(widthDragged).toBeGreaterThan(widthBefore);

    // RELOAD: the size persists, the chat view persists, and the whole
    // transcript restores from the OPFS-backed store (the 3.1 spike's
    // contract — one context, reload round-trip).
    await openComplete(page);
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();
    await expect
      .poll(dockWidth, { timeout: 15_000 })
      .toBeCloseTo(widthDragged, 0);
    await expect(
      page.getByText("The hole diameter is now 11 mm."),
    ).toBeVisible();
    await expect(page.getByTestId("agent-captured-view")).toHaveCount(5);

    // VIEW SWITCH away and back: the panels return with their state (the
    // fresh boot's ⌀8 parameter) and the chat restores its transcript.
    await page.getByTestId("right-sidebar-view-panels").click();
    await expect(dock).toHaveAttribute("data-agent-view", "sidebar");
    await expect(page.getByTestId("agent-chat-panel")).toHaveCount(0);
    await expect(page.getByLabel("holeDiameter", { exact: true })).toHaveValue(
      "8",
    );
    await page.getByTestId("right-sidebar-view-chat").click();
    await expect(dock).toHaveAttribute("data-agent-view", "chat");
    await expect(
      page.getByText("The hole diameter is now 11 mm."),
    ).toBeVisible();
    extra("agent-sidebar-resize-persistence");

    // SYNC PUSH (D3, opt-in since s34): the local conversation reached the
    // server through the real tRPC mutations — titled by its first user
    // message, listed for the signed-in session user.
    await expect
      .poll(async () => syncedConversationTitles(page), { timeout: 15_000 })
      .toContain("Set the hole diameter to 11 mm.");
    extra("agent-sync-push");
  });
});

test("s39 agent conversation clear: local rows and the synced server copy", async ({
  sessionPage: page,
}) => {
  await stage("s39 agent conversation clear", async () => {
    await openComplete(page);
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();

    // The clear rides its palette row (the manifest command), not the
    // header button.
    await runCommand(page, COMPLETE_ROOT, "agent-conversation-clear");
    cover("agent-conversation-clear");
    await expect(page.getByText("The hole diameter is now 11 mm.")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("agent-captured-view")).toHaveCount(0);
    await expect(page.getByTestId("agent-chat-header")).toContainText(
      "Agent chat",
    );

    // The synced server copy went with it (the outbox's delete drain).
    await expect
      .poll(async () => syncedConversationTitles(page), { timeout: 15_000 })
      .toEqual([]);
    await waitForAgentSyncSettled(page);
    extra("agent-conversation-clear");
  });
});

test("s40 agent server mode: the real relay against the loopback (env key, never the user's)", async ({
  sessionPage: page,
}) => {
  await stage("s40 agent server relay", async () => {
    await openComplete(page);
    await expect(page.getByTestId("agent-chat-panel")).toBeVisible();

    // Server mode (D2/D13): the option exists for this signed-in user
    // under the harness's AGENT_SERVER_AI_ALLOW_ALL posture; the relay is
    // the REAL server function calling the loopback with the ENV pair.
    await runCommand(page, COMPLETE_ROOT, "agent-settings");
    const dialog = page.getByTestId("agent-settings-dialog");
    await expect(dialog).toBeVisible();
    await page.getByLabel("Mode", { exact: true }).click();
    await page.getByRole("option", { name: "Server (slopcad relay)" }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(dialog).toBeHidden();

    const callBaseline = (await agentFixtureCalls(page)).length;
    await scriptAgentResponses(page, [
      { kind: "text", text: "Server-side reply through the real relay." },
    ]);
    await page.getByLabel("Chat message").fill("Answer from the server relay.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByText("Server-side reply through the real relay."),
    ).toBeVisible();

    // The provider call was made by the RELAY with the ENV key — and the
    // user's browser-stored key never crossed to our server (D1/D2).
    const relayCalls = (await agentFixtureCalls(page)).slice(callBaseline);
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]?.authorization).toBe("Bearer fixture-env-key");
    expect(relayCalls[0]?.model).toBe("fixture-primary");
    extra("agent-server-relay");
  });
});

test("s99 THE COVERAGE GATE: every manifest path and route was exercised", () => {
  const missingEntries = ENTRY_IDS.filter((id) => !ledger.covered.has(id));
  const missingDeclines = DECLINE_IDS.filter((id) => !ledger.declines.has(id));
  const missingRoutes = PLANNED_ROUTES.filter(
    (route) => !ledger.routes.has(route),
  );
  const failure: string[] = [];
  if (missingEntries.length > 0) {
    failure.push(`manifest entries untested: ${missingEntries.join(", ")}`);
  }
  if (missingDeclines.length > 0) {
    failure.push(`declines unrecorded: ${missingDeclines.join(", ")}`);
  }
  if (missingRoutes.length > 0) {
    failure.push(`routes unwalked: ${missingRoutes.join(", ")}`);
  }
  const summary = `${String(ledger.covered.size)}/${String(ENTRY_IDS.length)} manifest entries + ${String(ledger.declines.size)}/${String(DECLINE_IDS.length)} declines + ${String(ledger.routes.size)}/${String(PLANNED_ROUTES.length)} routes exercised (${String(ledger.extras.size)} extra surfaces)`;
  console.log(`[session coverage] ${summary}`);
  console.log(
    `[session timeline] ${stageTimings
      .map((item) => `${item.name}=${item.seconds.toFixed(1)}s`)
      .join(" ")}`,
  );
  expect(failure, summary).toEqual([]);
});
