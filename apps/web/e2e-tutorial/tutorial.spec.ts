import type { Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";
import type { ChapterModule } from "./narration";

import { chapter as firstExtrudeChapter } from "./chapters/first-extrude";
import { chapter as homeTourChapter } from "./chapters/home-tour";
import { chapter as sketchWorkspaceChapter } from "./chapters/sketch-workspace";
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
 * the context, and the three pilot chapters played in teaching order as
 * serial tests. The final gate validates the narration ledger (every cue
 * bound to a real recorded step, timestamps monotonic, every cue watchable)
 * and writes it to `test-results/tutorial/ledger.json`; the fixture
 * teardown then finalizes the master video and attaches its path, and the
 * reporter emits the `docs/tutorials/` artifacts from the pair.
 */

/** The pilot chapters, in teaching order. */
const CHAPTERS: readonly ChapterModule[] = [
  homeTourChapter,
  sketchWorkspaceChapter,
  firstExtrudeChapter,
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
