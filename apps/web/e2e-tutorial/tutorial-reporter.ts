import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { FullResult, Reporter } from "@playwright/test/reporter";
import type { TutorialLedger } from "./narration";

import { formatCaptionsVtt, formatChaptersVtt, LEDGER_FILE } from "./narration";

/** Reporter options, passed as the second element of a config reporter entry. */
export interface TutorialReporterOptions {
  /** The narration ledger the spec's gate test wrote. */
  readonly ledgerFile?: string;
  /**
   * The tutorial metadata root (relative to the apps/web cwd Playwright
   * runs from). `chapters.json` inside it is COMMITTED; `media/` is
   * gitignored and regenerated per recording.
   */
  readonly docsFolder?: string;
}

/**
 * The tutorial reporter. Playwright finalizes a context's video only when
 * the context closes — after the last test — and runs reporters in the
 * RUNNER process while tests live in worker processes, so neither an
 * `afterEach` hook nor shared module state can carry the narration ledger
 * here. The vehicle is the ledger FILE: the gate test writes it (cue
 * bindings + video-relative timestamps), the worker fixture's teardown
 * amends the finalized video path into it, and this reporter reads it at
 * `onEnd` and emits the `docs/tutorials/` artifacts. Every missing piece
 * fails loudly — an empty artifact set is never a success state.
 */
export default class TutorialReporter implements Reporter {
  private readonly ledgerFile: string;
  private readonly docsFolder: string;

  constructor(options: TutorialReporterOptions = {}) {
    this.ledgerFile = options.ledgerFile ?? LEDGER_FILE;
    this.docsFolder = options.docsFolder ?? "../../docs/tutorials";
  }

  async onEnd(result: FullResult): Promise<void> {
    let ledger: TutorialLedger;
    try {
      ledger = JSON.parse(
        await readFile(this.ledgerFile, "utf8"),
      ) as TutorialLedger;
    } catch (cause) {
      throw new Error(
        `[tutorial] no narration ledger at ${this.ledgerFile} — the gate test never wrote it (run status: ${result.status})`,
        { cause },
      );
    }
    if (ledger.chapters.length === 0) {
      throw new Error(
        `[tutorial] the ledger holds no chapters — nothing was recorded (run status: ${result.status})`,
      );
    }
    if (ledger.videoT0 === null) {
      throw new Error(
        "[tutorial] the ledger has no video zero — cue timestamps cannot map onto the recording",
      );
    }
    if (ledger.videoPath === null) {
      throw new Error(
        "[tutorial] the ledger has no finalized video path — the fixture teardown never attached it",
      );
    }
    const video = await stat(ledger.videoPath).catch((): null => null);
    if (video === null) {
      throw new Error(
        `[tutorial] the master video is missing at ${ledger.videoPath}`,
      );
    }
    if (video.size === 0) {
      throw new Error(
        `[tutorial] the master video at ${ledger.videoPath} is empty`,
      );
    }

    const mediaFolder = `${this.docsFolder}/media`;
    await mkdir(mediaFolder, { recursive: true });
    await copyFile(ledger.videoPath, `${mediaFolder}/master.webm`);
    await writeFile(
      `${mediaFolder}/master.vtt`,
      formatCaptionsVtt(ledger.chapters),
    );
    await writeFile(
      `${mediaFolder}/chapters.vtt`,
      formatChaptersVtt(ledger.chapters),
    );
    // The committed cut list: the TTS source of truth and the edit decision
    // list, fully derived from the recorded ledger.
    await writeFile(
      `${this.docsFolder}/chapters.json`,
      `${JSON.stringify({ chapters: ledger.chapters }, null, 2)}\n`,
    );
    console.log(
      `[tutorial] ${String(ledger.chapters.length)} chapters, ${String(
        ledger.chapters.reduce(
          (total, chapter) => total + chapter.cues.length,
          0,
        ),
      )} cues, master video ${String(video.size)} bytes → ${this.docsFolder}`,
    );
  }
}
