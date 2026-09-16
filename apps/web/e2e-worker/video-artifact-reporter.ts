import { copyFile, mkdir } from "node:fs/promises";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/** Reporter options, passed as the second element of a config reporter entry. */
export interface VideoArtifactReporterOptions {
  /** Stable directory the recorded videos are copied to at run end. */
  readonly outputFolder?: string;
}

/**
 * Phase 10 video-artifact reporter: Playwright finalizes a test's video
 * only after its fixtures (the recorded page among them) are torn down, so
 * the stable artifact copy cannot live in an `afterEach` hook — the
 * attachment does not exist yet at that point. This reporter sees every
 * test's completed attachments at `onTestEnd` and, once the whole run has
 * ended, copies each recorded video to a stable, run-independent path under
 * the output folder (default `e2e-artifacts/worker/`, the phase-level
 * gate's deliverable; other harnesses pass their own folder, e.g. the
 * Phase 11.3 render fixture's `e2e-artifacts/render/`).
 */

interface RecordedVideo {
  readonly name: string;
  readonly path: string;
}

export default class VideoArtifactReporter implements Reporter {
  private readonly videos: RecordedVideo[] = [];
  private readonly outputFolder: string;

  constructor(options: VideoArtifactReporterOptions = {}) {
    this.outputFolder = options.outputFolder ?? "e2e-artifacts/worker";
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name === "video" && attachment.path !== undefined) {
        this.videos.push({ name: test.title, path: attachment.path });
      }
    }
  }

  async onEnd(): Promise<void> {
    if (this.videos.length === 0) return;
    await mkdir(this.outputFolder, { recursive: true });
    for (const video of this.videos) {
      const name = video.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      await copyFile(video.path, `${this.outputFolder}/${name}.webm`);
    }
  }
}
