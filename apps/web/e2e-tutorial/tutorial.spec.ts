import type { Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";
import type { ChapterModule } from "./narration";

import { chapter as appearanceAndLightingChapter } from "./chapters/appearance-and-lighting";
import { chapter as baseToolsChapter } from "./chapters/base-tools";
import { chapter as booleansChapter } from "./chapters/booleans";
import { chapter as cameraViewsChapter } from "./chapters/camera-views";
import { chapter as deleteAndHistoryChapter } from "./chapters/delete-and-history";
import { chapter as displayModesChapter } from "./chapters/display-modes";
import { chapter as draftRibScaleChapter } from "./chapters/draft-rib-scale";
import { chapter as firstExtrudeChapter } from "./chapters/first-extrude";
import { chapter as helixFeatureChapter } from "./chapters/helix-feature";
import { chapter as holesAndPatternsChapter } from "./chapters/holes-and-patterns";
import { chapter as homeTourChapter } from "./chapters/home-tour";
import { chapter as loftFeatureChapter } from "./chapters/loft-feature";
import { chapter as sectionClippingChapter } from "./chapters/section-clipping";
import { chapter as selectionInspectChapter } from "./chapters/selection-inspect";
import { chapter as sketchOnFaceChapter } from "./chapters/sketch-on-face";
import { chapter as sketchWorkspaceChapter } from "./chapters/sketch-workspace";
import { chapter as surfacesChapter } from "./chapters/surfaces";
import { chapter as sweepFeatureChapter } from "./chapters/sweep-feature";
import { chapter as threadFeatureChapter } from "./chapters/thread-feature";
import { chapter as thickenSplitChapter } from "./chapters/thicken-split";
import { chapter as undoRedoRollbackChapter } from "./chapters/undo-redo-rollback";
import { chapterTimelines, installCursorOverlay, playChapter } from "./driver";
import {
  assembleChapters,
  attachVideoPath,
  markVideoStart,
  MIN_CUE_SECONDS,
  videoStart,
  writeLedgerFile,
} from "./narration";

/**
 * The tutorial harness — the recorded, narrated walk a new user watches.
 * ONE browser context for the whole run (worker-scoped fixture + serial
 * mode, the session harness's discipline), the cursor overlay injected on
 * the context, and the chapters played in teaching order as serial tests
 * (the three pilots, the workbench-fundamentals batch, then the
 * feature-authoring batch). The final
 * gate validates the narration ledger (every cue bound to a real recorded
 * step, timestamps monotonic, every cue watchable) and writes it to
 * `test-results/tutorial/ledger.json`; the fixture teardown then finalizes
 * the master video and attaches its path, and the reporter emits the
 * `docs/tutorials/` artifacts from the pair.
 */

/**
 * The chapters, in teaching order: the workbench fundamentals batch, then
 * the feature-authoring batch (the sketch-on-face verb on the default
 * route, then the OCCT-only features — sweep, loft, helix, thread, the
 * shaping family, structured holes and patterns, booleans, and the
 * surface pipeline — each on the kernel that executes them).
 */
const CHAPTERS: readonly ChapterModule[] = [
  homeTourChapter,
  sketchWorkspaceChapter,
  firstExtrudeChapter,
  baseToolsChapter,
  selectionInspectChapter,
  undoRedoRollbackChapter,
  deleteAndHistoryChapter,
  displayModesChapter,
  cameraViewsChapter,
  sectionClippingChapter,
  appearanceAndLightingChapter,
  sketchOnFaceChapter,
  sweepFeatureChapter,
  loftFeatureChapter,
  helixFeatureChapter,
  threadFeatureChapter,
  draftRibScaleChapter,
  thickenSplitChapter,
  holesAndPatternsChapter,
  booleansChapter,
  surfacesChapter,
];

const test = base.extend<object, { tutorialPage: Page }>({
  tutorialPage: [
    async ({ browser }, use) => {
      // ONE context for the whole tutorial = ONE master video. The config's
      // `use.video` never reaches a fixture-built context (the session
      // harness's recorded note), so the recording is wired here: the file
      // finalizes when the context closes after the last test.
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        recordVideo: {
          dir: "test-results/tutorial-video",
          size: { width: 1280, height: 720 },
        },
      });
      // The master video's clock starts at context creation: stamp the
      // zero every cue/chapter timestamp offsets onto.
      markVideoStart();
      await installCursorOverlay(context);
      const page = await context.newPage();
      await use(page);
      await context.close();
      // Only now does the video exist as a finalized file. Its path crosses
      // the worker→runner process boundary through the ledger file, which
      // the reporter reads at onEnd.
      const video = page.video();
      const videoPath = video === null ? null : await video.path();
      await attachVideoPath(videoPath);
    },
    { scope: "worker" },
  ],
});

test.describe.configure({ mode: "serial" });

test("chapter: home-tour", async ({ tutorialPage: page }) => {
  // Teaching pace, not machine pace: every cue is held for reading and
  // every pointer move glides — the session's series stages set the
  // explicit-setTimeout precedent for stages that legitimately need it.
  test.setTimeout(120_000);
  await playChapter(page, homeTourChapter);
});

test("chapter: sketch-workspace", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, sketchWorkspaceChapter);
});

test("chapter: first-extrude", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, firstExtrudeChapter);
});

test("chapter: base-tools", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, baseToolsChapter);
});

test("chapter: selection-inspect", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, selectionInspectChapter);
});

test("chapter: undo-redo-rollback", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, undoRedoRollbackChapter);
});

test("chapter: delete-and-history", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, deleteAndHistoryChapter);
});

test("chapter: display-modes", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, displayModesChapter);
});

test("chapter: camera-views", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, cameraViewsChapter);
});

test("chapter: section-clipping", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, sectionClippingChapter);
});

test("chapter: appearance-and-lighting", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, appearanceAndLightingChapter);
});

test("chapter: sketch-on-face", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, sketchOnFaceChapter);
});

test("chapter: sweep-feature", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, sweepFeatureChapter);
});

test("chapter: loft-feature", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, loftFeatureChapter);
});

test("chapter: helix-feature", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, helixFeatureChapter);
});

test("chapter: thread-feature", async ({ tutorialPage: page }) => {
  test.setTimeout(120_000);
  await playChapter(page, threadFeatureChapter);
});

// The merged shaping chapter walks THREE session stages (s14, s14b, s14c
// — each a ≤ 30 s stage at session machine pace) plus their teaching
// pace: 120 s cannot hold that floor, so the budget mirrors the session's
// own elevated-stage precedent (s11b's 90 s / s11c's 150 s).
test("chapter: draft-rib-scale", async ({ tutorialPage: page }) => {
  test.setTimeout(240_000);
  await playChapter(page, draftRibScaleChapter);
});

// Two merged session stages (s14d + s14e) on the OCCT kernel: the two
// boots and four kernel settles alone eat the 120 s floor.
test("chapter: thicken-split", async ({ tutorialPage: page }) => {
  test.setTimeout(180_000);
  await playChapter(page, thickenSplitChapter);
});

// FOUR merged session stages (s15, s15b, s16, s16c — the hole family and
// the pattern family): four boots, four kernel creates, two re-drives.
test("chapter: holes-and-patterns", async ({ tutorialPage: page }) => {
  test.setTimeout(300_000);
  await playChapter(page, holesAndPatternsChapter);
});

// Three merged boolean stages (s16d, s16e, s16f) with four sketch
// extrusions on the OCCT kernel between them.
test("chapter: booleans", async ({ tutorialPage: page }) => {
  test.setTimeout(240_000);
  await playChapter(page, booleansChapter);
});

// The whole surface pipeline (s17 + s17b): one boot, six kernel dialog
// operations, each with its own settle.
test("chapter: surfaces", async ({ tutorialPage: page }) => {
  test.setTimeout(180_000);
  await playChapter(page, surfacesChapter);
});

test("tutorial gate: the narration ledger is complete and watchable", async () => {
  const timelines = chapterTimelines();
  const definitions = CHAPTERS.map((chapter) => chapter.definition);
  // Binding throws loudly on any defect: a chapter that never ran, a cue
  // without its recorded step (or a step without a cue), or timestamps
  // out of order.
  const chapters = assembleChapters(definitions, timelines, videoStart());
  for (const chapter of chapters) {
    expect(
      chapter.cues.length,
      `${chapter.id} must teach with at least 4 cues`,
    ).toBeGreaterThanOrEqual(4);
    expect(chapter.end, `${chapter.id} has a positive window`).toBeGreaterThan(
      chapter.start,
    );
    let previousStart = chapter.start;
    for (const cue of chapter.cues) {
      expect(cue.start, `${cue.id} starts in cue order`).toBeGreaterThanOrEqual(
        previousStart,
      );
      expect(
        cue.end - cue.start,
        `${cue.id} stays on screen for a readable beat`,
      ).toBeGreaterThanOrEqual(MIN_CUE_SECONDS);
      previousStart = cue.start;
    }
  }
  // The ledger the reporter consumes (the video path is amended by the
  // fixture teardown after this test — the file only exists at close).
  await writeLedgerFile(definitions, timelines);
  console.log(
    `[tutorial ledger] ${chapters
      .map(
        (chapter) =>
          `${chapter.id}=${String(chapter.cues.length)}cues/${(chapter.end - chapter.start).toFixed(1)}s`,
      )
      .join(" ")}`,
  );
});
