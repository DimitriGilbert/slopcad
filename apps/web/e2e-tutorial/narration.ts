import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";
import type { TutorialDriver } from "./driver";

/**
 * The tutorial's narration layer — deliberately runtime-pure (node builtins
 * plus type imports only), because BOTH processes read it: the worker runs
 * the chapters and writes the ledger, and the runner's reporter reads the
 * same file and formats the captions. Playwright runs reporters in the
 * runner process while tests live in worker processes — module state cannot
 * cross that boundary, but this module's types and pure formatters are
 * shared and the JSON ledger file is the vehicle.
 */

// ---------------------------------------------------------------------------
// The chapter schema (what a chapters/*.ts module exports)
// ---------------------------------------------------------------------------

/** One narration cue, bound to the step id its beat records at runtime. */
export interface ChapterCue {
  readonly stepId: string;
  readonly text: string;
}

/** A chapter's identity and its ordered cue list (the narration script). */
export interface ChapterDefinition {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly cues: readonly ChapterCue[];
}

/** A pilot chapter: its narration script plus the script that walks it. */
export interface ChapterModule {
  readonly definition: ChapterDefinition;
  run(page: Page, driver: TutorialDriver): Promise<void>;
}

// ---------------------------------------------------------------------------
// The raw timeline (what the driver records) and the bound ledger
// ---------------------------------------------------------------------------

/** One step's raw wall-clock stamps (closed when the next step opens). */
export interface RawStepRecord {
  readonly chapterId: string;
  readonly stepId: string;
  /** Wall-clock ms at the step's opening stamp. */
  readonly t0: number;
  /** Wall-clock ms at the next step's opening (or the chapter's close). */
  readonly t1: number;
}

/** One chapter's raw wall-clock timeline. */
export interface RawChapterRecord {
  readonly id: string;
  readonly title: string;
  readonly t0: number;
  readonly t1: number;
  readonly steps: readonly RawStepRecord[];
}

/** One cue with its recorded, video-relative timestamps. */
export interface CueRecord {
  /** The stable narration id (`chapterId/stepId`) — the TTS source key. */
  readonly id: string;
  readonly stepId: string;
  readonly text: string;
  /** Start seconds on the master video's timeline. */
  readonly start: number;
  /** End seconds on the master video's timeline. */
  readonly end: number;
}

/** One chapter with its recorded, video-relative window and cues. */
export interface ChapterRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly start: number;
  readonly end: number;
  readonly cues: readonly CueRecord[];
}

/** The ledger file's shape (written by the spec, amended by the fixture). */
export interface TutorialLedger {
  /** Wall-clock ms at context creation — the master video's zero. */
  readonly videoT0: number | null;
  /** The finalized master video path, attached when the context closed. */
  readonly videoPath: string | null;
  readonly chapters: readonly ChapterRecord[];
}

// ---------------------------------------------------------------------------
// Caption rules
// ---------------------------------------------------------------------------

/** The shortest readable on-screen life of one caption cue. */
export const MIN_CUE_SECONDS = 1.0;
/** VTT caption line budget (the classic 42-char caption column). */
const VTT_LINE_MAX_CHARS = 42;
/** VTT caption line count budget. */
const VTT_LINE_MAX_COUNT = 2;

/** The ledger file both the spec (write) and the reporter (read) share. */
export const LEDGER_FILE = "test-results/tutorial/ledger.json";

// ---------------------------------------------------------------------------
// The video clock (stamped by the fixture at context creation)
// ---------------------------------------------------------------------------

let videoStartClock: number | null = null;

/** Stamps the master video's zero — call the moment the context exists. */
export function markVideoStart(): void {
  videoStartClock = Date.now();
}

/** The stamped video zero; throws if the fixture never stamped it. */
export function videoStart(): number {
  if (videoStartClock === null) {
    throw new Error(
      "markVideoStart() was never called — the fixture must stamp context creation",
    );
  }
  return videoStartClock;
}

// ---------------------------------------------------------------------------
// Binding: cue scripts × raw timelines → video-relative records
// ---------------------------------------------------------------------------

const toSeconds = (wallMs: number, zeroMs: number): number =>
  (wallMs - zeroMs) / 1000;

/**
 * Binds every chapter's cue list onto its recorded timeline. Loud on every
 * defect a validator would catch: a chapter that never ran, a cue whose
 * step id was never recorded (or a recorded step with no cue — the counts
 * must match exactly, both directions), timestamps out of order, or a cue
 * shorter than the readable floor.
 */
export function assembleChapters(
  definitions: readonly ChapterDefinition[],
  timelines: readonly RawChapterRecord[],
  zeroMs: number,
): readonly ChapterRecord[] {
  if (definitions.length !== timelines.length) {
    throw new Error(
      `${String(definitions.length)} chapter definitions vs ${String(timelines.length)} recorded timelines — every chapter must play exactly once`,
    );
  }
  return definitions.map((definition, index) => {
    const timeline = timelines[index];
    if (timeline === undefined || timeline.id !== definition.id) {
      throw new Error(
        `chapter "${definition.id}" never ran (timeline ${String(index)} is "${timeline?.id ?? "absent"}")`,
      );
    }
    if (timeline.steps.length !== definition.cues.length) {
      throw new Error(
        `chapter "${definition.id}": ${String(timeline.steps.length)} recorded steps vs ${String(definition.cues.length)} cues — every step() needs exactly one cue and vice versa`,
      );
    }
    const textByStepId = new Map(
      definition.cues.map((cue) => [cue.stepId, cue.text]),
    );
    let previousStart = toSeconds(timeline.t0, zeroMs);
    const cues: CueRecord[] = timeline.steps.map((record, stepIndex) => {
      const text = textByStepId.get(record.stepId);
      if (text === undefined) {
        throw new Error(
          `chapter "${definition.id}": step "${record.stepId}" was recorded but has no narration cue`,
        );
      }
      if (text.trim() === "") {
        throw new Error(
          `chapter "${definition.id}": cue "${record.stepId}" has empty text`,
        );
      }
      const start = toSeconds(record.t0, zeroMs);
      if (start < previousStart) {
        throw new Error(
          `chapter "${definition.id}": cue "${record.stepId}" starts at ${start.toFixed(3)}s, before its predecessor at ${previousStart.toFixed(3)}s`,
        );
      }
      const nextT0 = timeline.steps[stepIndex + 1]?.t0 ?? timeline.t1;
      const end = Math.max(toSeconds(nextT0, zeroMs), start + MIN_CUE_SECONDS);
      previousStart = start;
      return {
        id: `${definition.id}/${record.stepId}`,
        stepId: record.stepId,
        text,
        start,
        end,
      };
    });
    const firstCue = cues[0];
    if (
      firstCue !== undefined &&
      firstCue.start < toSeconds(timeline.t0, zeroMs)
    ) {
      throw new Error(
        `chapter "${definition.id}": a cue starts before its chapter window`,
      );
    }
    const lastCue = cues[cues.length - 1];
    const chapterEnd = Math.max(
      toSeconds(timeline.t1, zeroMs),
      lastCue === undefined ? toSeconds(timeline.t1, zeroMs) : lastCue.end,
    );
    return {
      id: definition.id,
      title: definition.title,
      summary: definition.summary,
      start: toSeconds(timeline.t0, zeroMs),
      end: chapterEnd,
      cues,
    };
  });
}

// ---------------------------------------------------------------------------
// VTT formatting (tiny, no deps)
// ---------------------------------------------------------------------------

/** Seconds → WebVTT timestamp (`MM:SS.mmm`, or `H:MM:SS.mmm` past an hour). */
function formatVttTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const fraction = Math.round((clamped - whole) * 1000);
  const carry = fraction === 1000 ? 1 : 0;
  const ms = carry === 1 ? 0 : fraction;
  const totalSeconds = whole + carry;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const stamp = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  return h > 0 ? `${String(h)}:${stamp}` : stamp;
}

/**
 * Wraps cue text to the caption column (greedy word wrap). Throws — never
 * silently truncates — when a cue cannot fit its lines.
 */
function wrapCueText(text: string): string {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= VTT_LINE_MAX_CHARS) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    line = word;
  }
  if (line !== "") lines.push(line);
  if (lines.length > VTT_LINE_MAX_COUNT) {
    throw new Error(
      `cue text needs ${String(lines.length)} lines (max ${String(VTT_LINE_MAX_COUNT)} × ${String(VTT_LINE_MAX_CHARS)} chars): "${text}"`,
    );
  }
  return lines.join("\n");
}

/** The caption track: every cue with its stable id and recorded window. */
export function formatCaptionsVtt(chapters: readonly ChapterRecord[]): string {
  const blocks = chapters.flatMap((chapter) =>
    chapter.cues.map((cue) =>
      [
        cue.id,
        `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}`,
        wrapCueText(cue.text),
      ].join("\n"),
    ),
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/** The chapter track: one marker per chapter at its recorded start. */
export function formatChaptersVtt(chapters: readonly ChapterRecord[]): string {
  const blocks = chapters.map((chapter) =>
    [
      chapter.id,
      `${formatVttTime(chapter.start)} --> ${formatVttTime(chapter.end)}`,
      chapter.title,
    ].join("\n"),
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// The ledger file (written by the gate test, amended by the fixture)
// ---------------------------------------------------------------------------

/**
 * Validates the run (binding + ordering, via {@link assembleChapters}) and
 * writes the ledger the reporter consumes. `videoPath` stays null here —
 * the video only finalizes when the fixture closes the context, AFTER the
 * last test; the teardown amends it.
 */
export async function writeLedgerFile(
  definitions: readonly ChapterDefinition[],
  timelines: readonly RawChapterRecord[],
): Promise<void> {
  const zero = videoStart();
  const ledger: TutorialLedger = {
    videoT0: zero,
    videoPath: null,
    chapters: assembleChapters(definitions, timelines, zero),
  };
  await mkdir(dirname(LEDGER_FILE), { recursive: true });
  await writeFile(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Amends the ledger with the finalized master video path. If the gate test
 * never wrote the ledger (a chapter failed and serial mode skipped the
 * rest), a minimal ledger lands anyway — with zero chapters, so the
 * reporter still fails loudly while the video stays diagnosable.
 */
export async function attachVideoPath(videoPath: string | null): Promise<void> {
  let ledger: TutorialLedger;
  try {
    ledger = JSON.parse(await readFile(LEDGER_FILE, "utf8")) as TutorialLedger;
  } catch {
    console.error(
      `[tutorial] ${LEDGER_FILE} missing at video attach — the gate test did not run`,
    );
    ledger = { videoT0: videoStartClock, videoPath: null, chapters: [] };
  }
  await writeFile(
    LEDGER_FILE,
    `${JSON.stringify({ ...ledger, videoPath }, null, 2)}\n`,
  );
}
