#!/usr/bin/env node
/**
 * The tutorial cut + index generator (`pnpm --filter web tutorial:cut`).
 *
 * Reads the committed cut list `docs/tutorials/chapters.json` (written by
 * `e2e-tutorial/tutorial-reporter.ts` at record time) and the master
 * recording, and emits three things in one command:
 *
 *   1. Per-chapter clips  `docs/tutorials/media/clips/<chapter-id>.webm`
 *   2. Per-clip captions  `docs/tutorials/media/clips/<chapter-id>.vtt`
 *      — the chapter's cues shifted onto the clip's own zero, regenerated
 *      from chapters.json data (never a textual rewrite of master.vtt)
 *   3. The committed, searchable index `docs/tutorials/index.md` — every
 *      chapter with its summary, master-video window, clip paths, and the
 *      full timestamped cue transcript, plus the command-surface coverage
 *      map (checklist entry id → teaching chapter).
 *
 * Cut mechanics: Playwright's master webm (VP8) has sparse, irregular
 * keyframes, so STREAM COPY snaps every cut to a keyframe — minutes of
 * drift on a 13-minute recording. The cuts therefore DECODE-accurate-seek
 * and re-encode: input-side `-ss <start>` lands on the keyframe at or
 * before the chapter start, ffmpeg then decodes forward and discards
 * frames up to the exact timestamp, and the re-encode starts frame-exact
 * (input-side seeking is only inaccurate when combined with `-c copy`).
 * The encoder is libvpx-vp9 at its realtime deadline — a 13-minute run
 * cuts in a couple of minutes, and the clips stay readable. Every clip is
 * then probed and its duration must match the requested chapter window
 * within DURATION_TOLERANCE_S or the script fails loudly.
 *
 * The coverage map is CURATED DATA below (the tutorial-level analogue of
 * the session coverage gate), validated mechanically on every run: every
 * checklist entry id appears exactly once across the taught/not-taught
 * maps, every referenced chapter id and cue step id exists in
 * chapters.json, and every checklist decline is accounted for. A chapter
 * rename or a checklist edit that orphans the map fails the run instead
 * of silently shrinking the index.
 *
 * Idempotent: the clips folder is wiped and regenerated on every run, so
 * stale clips from earlier recordings cannot survive. Loud on every
 * missing prerequisite — ffmpeg absent, no cut list, no master recording
 * — with the exact command that fixes it; an empty artifact set is never
 * a success state.
 *
 * Usage: pnpm --filter web tutorial:cut
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DOCS = `${ROOT}/docs/tutorials`;
const MEDIA = `${DOCS}/media`;
const CLIPS = `${MEDIA}/clips`;
const MASTER = `${MEDIA}/master.webm`;
const CHAPTERS_JSON = `${DOCS}/chapters.json`;
const CHECKLIST = `${ROOT}/apps/web/e2e-workbench/command-surface.checklist.json`;
const INDEX = `${DOCS}/index.md`;

/** A probed clip may differ from its chapter window by at most this. */
const DURATION_TOLERANCE_S = 0.5;

/** VTT caption column — the same 42-char / 2-line budget narration.ts enforces. */
const VTT_LINE_MAX_CHARS = 42;
const VTT_LINE_MAX_COUNT = 2;

/**
 * Fails the run loudly. There is no warning channel and no fake success:
 * anything that would leave the artifacts stale or partial exits 1.
 */
function fail(message) {
  console.error(`[tutorial-cut] ${message}`);
  process.exit(1);
}

/** Runs a binary sync; returns { status, stdout, stderr } or fails on spawn error. */
function runBinary(bin, args, what) {
  const res = spawnSync(bin, args, { encoding: "utf8" });
  if (res.error !== undefined && res.error !== null) {
    fail(
      `${what}: "${bin}" could not be executed (${res.error.message}). ` +
        `Install ffmpeg first — Fedora: sudo dnf install ffmpeg, ` +
        `otherwise https://ffmpeg.org/download.html — then re-run ` +
        `pnpm --filter web tutorial:cut`,
    );
  }
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// The manifest coverage map (curated data — keep it honest, the validator
// below keeps it complete)
// ---------------------------------------------------------------------------

/**
 * Every command-surface checklist entry the tutorial teaches, mapped to
 * the chapter that teaches it with the cue step ids that carry the
 * teaching. `scope` marks partial breadth — the surface is taught, but
 * only part of the checklist capability's range is walked.
 */
const TAUGHT = {
  "base-tool-select": {
    chapter: "base-tools",
    cues: ["strip", "digits", "status"],
  },
  "base-tool-measure": {
    chapter: "base-tools",
    cues: ["strip", "arm-measure", "status-flip"],
  },
  "base-tool-rotate": {
    chapter: "base-tools",
    cues: ["arm-rotate", "shortcut", "recap"],
  },
  "base-undo": {
    chapter: "undo-redo-rollback",
    cues: ["history-buttons", "undo"],
  },
  "base-redo": { chapter: "undo-redo-rollback", cues: ["redo"] },
  "base-clear-rollback": {
    chapter: "undo-redo-rollback",
    cues: ["gaps", "set-rollback", "parked", "clear-rollback", "recovers"],
  },
  "base-clear-selection": {
    chapter: "undo-redo-rollback",
    cues: ["pick-body", "clear-selection"],
  },
  "base-export": {
    chapter: "io-import-export",
    cues: ["export-dialog", "stl-hold"],
  },
  "base-import": {
    chapter: "io-import-export",
    cues: ["formats", "held-stl", "obj"],
  },
  "sketch-vocabulary-workspace": {
    chapter: "sketch-workspace",
    cues: ["menu", "palette", "sketch-row", "workspace", "tools", "save"],
  },
  "sketch-editing-operations": {
    chapter: "sketch-workspace",
    cues: ["tools", "arm-rectangle", "first-corner", "second-corner", "save"],
    scope:
      "partial — tool arming, drawing, commit, and save are walked; the " +
      "offset/mirror/array/extend/convert sketch ops and drag-with-constraints " +
      "re-solve are not narrated",
  },
  "sweep-feature": {
    chapter: "sweep-feature",
    cues: [
      "profile",
      "spine-start",
      "spine-end",
      "row",
      "pick",
      "create",
      "tube",
    ],
  },
  "loft-feature": {
    chapter: "loft-feature",
    cues: [
      "section-wide",
      "section-narrow",
      "row",
      "create",
      "volume",
      "station",
      "redrive",
    ],
  },
  "datum-geometry": {
    chapter: "thicken-split",
    cues: ["split-boot", "datum", "split-row"],
    scope:
      "partial — datum planes created and consumed as split/mirror/sheet " +
      "anchors (also in holes-and-patterns and surfaces); datum axes, points, " +
      "and coordinate systems are not walked",
  },
  "helix-feature": {
    chapter: "helix-feature",
    cues: ["meridian", "save", "throwaway", "pick", "create", "coil"],
  },
  "thread-feature": {
    chapter: "thread-feature",
    cues: ["rod", "row", "band", "edit", "deeper"],
  },
  "draft-taper-feature": {
    chapter: "draft-rib-scale",
    cues: ["draft-boot", "draft-unlock", "draft-create", "frustum", "flatten"],
  },
  "rib-feature": {
    chapter: "draft-rib-scale",
    cues: ["rib-boot", "rib-row", "rib-union", "rib-edit"],
  },
  "scale-feature": {
    chapter: "draft-rib-scale",
    cues: ["scale-boot", "eight", "twenty-seven"],
  },
  "thicken-shell-feature": {
    chapter: "thicken-split",
    cues: ["thicken-boot", "wall", "shell"],
  },
  "split-body-feature": {
    chapter: "thicken-split",
    cues: ["datum", "split-row", "half", "flip"],
  },
  "structured-hole-feature": {
    chapter: "holes-and-patterns",
    cues: ["hole-form", "counterbore", "ghost-and-cut"],
  },
  "plain-hole-bridge": {
    chapter: "holes-and-patterns",
    cues: ["hole-form", "ghost-and-cut"],
    scope:
      "partial — holes are cut through the structured Hole dialog that " +
      "completes the bridge verb; the bare pre-42 hole row is never clicked",
  },
  "feature-pattern": {
    chapter: "holes-and-patterns",
    cues: ["pattern-boot", "array", "redrive"],
  },
  "mirror-feature": {
    chapter: "holes-and-patterns",
    cues: ["mirror-boot", "merge", "standalone"],
  },
  "boolean-commands": {
    chapter: "booleans",
    cues: ["subtract-row", "removed", "union-row", "slab"],
  },
  "body-management-move": {
    chapter: "booleans",
    cues: ["move-boot", "move-row", "invariant"],
  },
  "sketch-on-face-verb": {
    chapter: "sketch-on-face",
    cues: ["top-face", "selection", "command", "on-face", "draw", "doubles"],
  },
  "camera-standard-views": {
    chapter: "camera-views",
    cues: ["front", "top", "iso", "convention", "fit", "look-at"],
  },
  "display-modes": {
    chapter: "display-modes",
    cues: ["panel", "shaded", "edges", "wire", "hidden"],
  },
  "section-clipping": {
    chapter: "section-clipping",
    cues: ["block", "select-body", "arm", "area", "view-cut", "halved", "off"],
  },
  "sheet-bodies-base-surfaces": {
    chapter: "surfaces",
    cues: ["datum", "sheet-one", "sheet-two"],
  },
  "surface-trim-op": { chapter: "surfaces", cues: ["trim"] },
  "surface-thicken-op": { chapter: "surfaces", cues: ["thicken"] },
  "surface-knit-op": { chapter: "surfaces", cues: ["knit", "honest"] },
  "surface-offset-op": { chapter: "surfaces", cues: ["offset"] },
  "assembly-structure": {
    chapter: "assembly-tree",
    cues: ["boot", "first", "add", "placed", "phantom", "remove"],
  },
  "mate-joint-solver": {
    chapter: "assembly-motion",
    cues: ["joint", "joint-home", "decline", "stale", "regenerate"],
    scope:
      "revolute joint walked; the joint-drag solver decline is narrated as an honest decline",
  },
  "interference-clearance": {
    chapter: "interference",
    cues: ["run", "verdict", "isolate", "show-all"],
  },
  "assembly-motion-explode": {
    chapter: "assembly-motion",
    cues: ["explode", "quarter", "full"],
  },
  "component-patterns-mirror": {
    chapter: "assembly-motion",
    cues: ["linear", "circular", "again", "mirror"],
  },
  "drawing-sheets-views": {
    chapter: "drawings",
    cues: ["sheet", "views", "section"],
  },
  "drawing-dimensions-annotations": {
    chapter: "drawings",
    cues: ["reference", "revision", "template"],
  },
  "drawing-output-bom": {
    chapter: "bom-output",
    cues: ["bom", "balloon", "canvas", "export"],
  },
  "exchange-import-formats": {
    chapter: "io-import-export",
    cues: ["formats", "obj"],
  },
  "duplicate-transform": {
    chapter: "iot-applied-var",
    cues: ["posts-turn", "posts-two"],
    scope:
      "partial — extrude-sourced duplicates with $-referenced step/angle " +
      "fields and a world-z half turn re-driven by the demos; the count " +
      "literal stays at 1 and the iterative duplicate-of-a-copy is not walked",
  },
};

/**
 * Checklist entries no chapter teaches, with the honest reason each. The
 * two checklist declines live here too — a decline is by definition not
 * taught as a workbench verb.
 */
const NOT_TAUGHT = {
  "sketch-solver-status":
    "the sketch editor is walked (sketch-workspace), but the solver " +
    "diagnostics readout — solving scope, under/over-constrained feedback — " +
    "never appears or is narrated",
  "path-pattern-feature":
    "no chapter opens the path-pattern row or narrates instances along a " +
    "sketch path; patterns are taught as linear/circular body patterns " +
    "(holes-and-patterns) and component stamps (assembly-motion)",
  "curve-authoring-3d":
    "no chapter opens the create-curve row or narrates 3D curve authoring; " +
    "helix is taught as a feature sweep (helix-feature), not as a curve entity",
  "sketch-exchange-import":
    "the exchange chapters walk the six-format import dialog and the .tsx " +
    "round trip; DXF/SVG import into the active sketch never appears",
  "visualization-snapshot-png":
    "the phase-59 viewport snapshot exports postdate the chapter set; no " +
    "chapter opens the PNG snapshot row",
  "visualization-snapshot-turntable":
    "the phase-59 viewport snapshot exports postdate the chapter set; no " +
    "chapter opens the turntable series row",
  "visualization-snapshot-isometric":
    "the phase-59 viewport snapshot exports postdate the chapter set; no " +
    "chapter opens the isometric series row",
  "iges-export-dwg-import":
    "documented decline — and the tutorial teaches the absence itself: " +
    "io-import-export narrates 'no IGES promise' and 'no DWG' while walking " +
    "the honest exporter/import families",
  "local-face-operations-verb":
    "documented decline — the kernel capability has no workbench verb at " +
    "this epoch, so no chapter can teach one",
};

// ---------------------------------------------------------------------------
// Validation (loud, both directions)
// ---------------------------------------------------------------------------

/** Validates chapters.json's shape; returns the chapters array. */
function loadChapters() {
  if (!existsSync(CHAPTERS_JSON)) {
    fail(
      `no cut list at docs/tutorials/chapters.json — record the tutorial ` +
        `first: pnpm --filter web tutorial:record`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CHAPTERS_JSON, "utf8"));
  } catch (cause) {
    fail(`docs/tutorials/chapters.json is not valid JSON: ${String(cause)}`);
  }
  const chapters = parsed?.chapters;
  if (!Array.isArray(chapters) || chapters.length === 0) {
    fail("chapters.json holds no chapters — the recording never landed");
  }
  for (const chapter of chapters) {
    for (const field of ["id", "title", "summary"]) {
      if (typeof chapter[field] !== "string" || chapter[field] === "") {
        fail(
          `chapter is missing a string "${field}": ${JSON.stringify(chapter.id ?? chapter)}`,
        );
      }
    }
    for (const field of ["start", "end"]) {
      if (
        typeof chapter[field] !== "number" ||
        !Number.isFinite(chapter[field])
      ) {
        fail(`chapter "${chapter.id}" is missing a finite number "${field}"`);
      }
    }
    if (chapter.end <= chapter.start) {
      fail(`chapter "${chapter.id}" has a non-positive window`);
    }
    if (!Array.isArray(chapter.cues) || chapter.cues.length === 0) {
      fail(`chapter "${chapter.id}" has no cues`);
    }
    for (const cue of chapter.cues) {
      if (
        typeof cue.stepId !== "string" ||
        typeof cue.text !== "string" ||
        cue.text === ""
      ) {
        fail(`chapter "${chapter.id}" has a cue missing stepId/text`);
      }
      if (typeof cue.start !== "number" || typeof cue.end !== "number") {
        fail(
          `chapter "${chapter.id}" cue "${cue.stepId}" has non-numeric timestamps`,
        );
      }
    }
  }
  return chapters;
}

/** Validates the coverage maps against the checklist and the chapters. */
function validateCoverage(checklist, chapters) {
  const taughtIds = Object.keys(TAUGHT);
  const notTaughtIds = Object.keys(NOT_TAUGHT);
  const duplicated = taughtIds.filter((id) => notTaughtIds.includes(id));
  if (duplicated.length > 0) {
    fail(`coverage maps double-book: ${duplicated.join(", ")}`);
  }
  const entryIds = checklist.entries.map((entry) => entry.id);
  const declineIds = (
    Array.isArray(checklist.declines) ? checklist.declines : []
  ).map((decline) => decline.id);
  const knownIds = [...entryIds, ...declineIds];
  const unknown = [...taughtIds, ...notTaughtIds].filter(
    (id) => !knownIds.includes(id),
  );
  if (unknown.length > 0) {
    fail(
      `coverage map names ids absent from the checklist ` +
        `(stale map — update TAUGHT/NOT_TAUGHT): ${unknown.join(", ")}`,
    );
  }
  const unmapped = entryIds.filter(
    (id) => !taughtIds.includes(id) && !notTaughtIds.includes(id),
  );
  if (unmapped.length > 0) {
    fail(
      `checklist entries absent from the coverage map — map them or ` +
        `declare them not taught: ${unmapped.join(", ")}`,
    );
  }
  for (const [id, map] of Object.entries(TAUGHT)) {
    const chapter = chapters.find((candidate) => candidate.id === map.chapter);
    if (chapter === undefined) {
      fail(
        `coverage entry "${id}" points at chapter "${map.chapter}", which ` +
          `chapters.json does not hold (stale map after a chapter rename)`,
      );
    }
    const stepIds = new Set(chapter.cues.map((cue) => cue.stepId));
    const missing = map.cues.filter((cue) => !stepIds.has(cue));
    if (missing.length > 0) {
      fail(
        `coverage entry "${id}" cites cues missing from "${map.chapter}": ` +
          `${missing.join(", ")}`,
      );
    }
  }
  const unaccounted = declineIds.filter((id) => !Object.hasOwn(NOT_TAUGHT, id));
  if (unaccounted.length > 0) {
    fail(
      `checklist declines absent from the coverage map: ${unaccounted.join(", ")}`,
    );
  }
  return { taughtCount: taughtIds.length, notTaughtCount: notTaughtIds.length };
}

// ---------------------------------------------------------------------------
// The cut (accurate seek + re-encode — see the header)
// ---------------------------------------------------------------------------

/** Probes a media file's duration in seconds; fails loudly on anything else. */
function probeDurationSeconds(path, what) {
  const res = runBinary(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    `probing ${what}`,
  );
  if (res.status !== 0) {
    fail(`ffprobe could not read ${what} (${path}): ${res.stderr.trim()}`);
  }
  const seconds = Number(res.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(`ffprobe returned no duration for ${what} (${path})`);
  }
  return seconds;
}

/** Cuts one chapter clip and verifies its duration against the window. */
function cutClip(chapter, index, total) {
  const duration = chapter.end - chapter.start;
  const out = `${CLIPS}/${chapter.id}.webm`;
  const res = runBinary(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      // Input-side seek: land on the keyframe at/before the start, then
      // DECODE forward to the exact timestamp — frame-accurate because the
      // clip is re-encoded (stream copy would snap to the keyframe).
      "-ss",
      chapter.start.toFixed(3),
      "-i",
      MASTER,
      "-t",
      duration.toFixed(3),
      "-map",
      "0:v:0",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-row-mt",
      "1",
      "-crf",
      "28",
      "-b:v",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-y",
      out,
    ],
    `cutting chapter "${chapter.id}"`,
  );
  if (res.status !== 0) {
    fail(`ffmpeg failed on chapter "${chapter.id}": ${res.stderr.trim()}`);
  }
  const probed = probeDurationSeconds(out, `clip "${chapter.id}"`);
  if (Math.abs(probed - duration) > DURATION_TOLERANCE_S) {
    fail(
      `clip "${chapter.id}" duration ${probed.toFixed(3)}s differs from its ` +
        `chapter window ${duration.toFixed(3)}s by more than ` +
        `${String(DURATION_TOLERANCE_S)}s — the cut is misaligned`,
    );
  }
  const bytes = statSync(out).size;
  console.log(
    `[tutorial-cut] ${String(index)}/${String(total)} ${chapter.id} ` +
      `${chapter.start.toFixed(1)}s→${chapter.end.toFixed(1)}s ` +
      `(${duration.toFixed(1)}s, ${(bytes / 1024 / 1024).toFixed(1)} MB)`,
  );
  return bytes;
}

// ---------------------------------------------------------------------------
// Per-clip captions (regenerated from chapters.json — mirrors narration.ts)
// ---------------------------------------------------------------------------

/** Seconds → WebVTT timestamp (`MM:SS.mmm`, or `H:MM:SS.mmm` past an hour). */
function formatVttTime(seconds) {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const fraction = Math.round((clamped - whole) * 1000);
  const carry = fraction === 1000 ? 1 : 0;
  const ms = carry === 1 ? 0 : fraction;
  const total = whole + carry;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const stamp = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  return h > 0 ? `${String(h)}:${stamp}` : stamp;
}

/**
 * The narration.ts caption wrap, mirrored: greedy wrap at 42 chars, max
 * 2 lines, throw (never truncate) when a cue cannot fit. The TS module
 * cannot be imported from a plain node script, so the rules live here
 * too — keep them in sync.
 */
function wrapCueText(text) {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines = [];
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
    fail(
      `cue text needs ${String(lines.length)} caption lines (max ` +
        `${String(VTT_LINE_MAX_COUNT)} × ${String(VTT_LINE_MAX_CHARS)} chars): "${text}"`,
    );
  }
  return lines.join("\n");
}

/** The chapter's cues, shifted onto the clip's own zero. */
function clipVtt(chapter) {
  const blocks = chapter.cues.map((cue) =>
    [
      cue.id,
      `${formatVttTime(cue.start - chapter.start)} --> ${formatVttTime(cue.end - chapter.start)}`,
      wrapCueText(cue.text),
    ].join("\n"),
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// The committed index (prettier-stable markdown: lists, never tables)
// ---------------------------------------------------------------------------

/** Seconds → `MM:SS` (or `H:MM:SS` past an hour) for chapter windows. */
function clockStamp(seconds) {
  const total = Math.round(Math.max(0, seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const stamp = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${String(h)}:${stamp}` : stamp;
}

/** One chapter's index block: identity, window, clip paths, transcript. */
function chapterBlock(chapter, number) {
  const lines = [];
  lines.push(`### ${String(number)}. ${chapter.id} — ${chapter.title}`);
  lines.push("");
  lines.push(chapter.summary);
  lines.push("");
  lines.push(
    `- Master window: ${clockStamp(chapter.start)}–${clockStamp(chapter.end)} ` +
      `(${(chapter.end - chapter.start).toFixed(1)} s) · clip: ` +
      `\`media/clips/${chapter.id}.webm\` + \`media/clips/${chapter.id}.vtt\``,
  );
  lines.push("");
  lines.push("Transcript (clip-relative):");
  lines.push("");
  for (const cue of chapter.cues) {
    lines.push(
      `- \`${cue.id}\` ${formatVttTime(cue.start - chapter.start)}–${formatVttTime(
        cue.end - chapter.start,
      )} — ${cue.text}`,
    );
  }
  lines.push("");
  return lines;
}

/** The coverage map's index section: taught, not taught, declines. */
function coverageBlocks(checklist, chapterNumbers) {
  const lines = [];
  const taught = Object.keys(TAUGHT).length;
  const entries = checklist.entries.length;
  const declines = Array.isArray(checklist.declines)
    ? checklist.declines.length
    : 0;
  lines.push("## Command-surface coverage map");
  lines.push("");
  lines.push(
    `The tutorial-level analogue of the session coverage gate: every ` +
      `\`apps/web/e2e-workbench/command-surface.checklist.json\` entry id and ` +
      `the chapter that teaches it. ${String(taught)} of ${String(entries)} entries ` +
      `taught · ${String(Object.keys(NOT_TAUGHT).length - declines)} not taught · ` +
      `${String(declines)} declines (not taught, by design). Curated in ` +
      `\`apps/web/scripts/tutorial-cut.mjs\` and validated on every run.`,
  );
  lines.push("");
  lines.push("### Taught");
  lines.push("");
  const order = new Map(
    checklist.entries.map((entry, index) => [entry.id, index]),
  );
  for (const id of Object.keys(TAUGHT).sort(
    (a, b) => order.get(a) - order.get(b),
  )) {
    const map = TAUGHT[id];
    const number = chapterNumbers.get(map.chapter);
    const scope = map.scope === undefined ? "" : ` (${map.scope})`;
    lines.push(
      `- \`${id}\` → ch. ${String(number)} \`${map.chapter}\`${scope} ` +
        `(cues: ${map.cues.join(", ")})`,
    );
  }
  lines.push("");
  lines.push("### Not taught");
  lines.push("");
  for (const id of Object.keys(NOT_TAUGHT)) {
    lines.push(`- \`${id}\` — ${NOT_TAUGHT[id]}.`);
  }
  lines.push("");
  return lines;
}

/** Builds the whole index.md content. */
function buildIndex(chapters, checklist, masterSeconds, chapterNumbers) {
  const cueCount = chapters.reduce(
    (total, chapter) => total + chapter.cues.length,
    0,
  );
  const lines = [];
  lines.push("# Tutorial index");
  lines.push("");
  lines.push(
    `The slopcad tutorial — ${String(chapters.length)} recorded chapters that walk ` +
      `the whole app at teaching pace — in searchable form. GENERATED by ` +
      "`pnpm --filter web tutorial:cut` from `docs/tutorials/chapters.json` and the " +
      "command-surface checklist; do not edit by hand. Timestamps change per " +
      "recording — regenerate after every `pnpm --filter web tutorial:record`. " +
      "The how-to lives in [the tutorials guide](../guides/tutorials.md).",
  );
  lines.push("");
  lines.push(
    `- Master recording: \`media/master.webm\` — ${String(chapters.length)} chapters, ` +
      `${String(cueCount)} cues, ${clockStamp(masterSeconds)} total`,
  );
  lines.push(
    "- Watch whole: the master with `media/master.vtt` captions and " +
      "`media/chapters.vtt` chapter markers (VLC/players that read WebVTT)",
  );
  lines.push(
    "- Watch per chapter: the clips + per-clip captions under `media/clips/`, " +
      "listed below with master-video windows",
  );
  lines.push(
    "- Regenerate: `pnpm --filter web tutorial:record` (records master + cut " +
      "list) then `pnpm --filter web tutorial:cut` (clips, per-clip captions, " +
      "this index) — requires ffmpeg on PATH",
  );
  lines.push("");
  lines.push("## Chapters");
  lines.push("");
  chapters.forEach((chapter, index) => {
    lines.push(...chapterBlock(chapter, index + 1));
  });
  lines.push(...coverageBlocks(checklist, chapterNumbers));
  return `${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const started = Date.now();

runBinary("ffmpeg", ["-version"], "checking ffmpeg");
const encoders = runBinary(
  "ffmpeg",
  ["-hide_banner", "-encoders"],
  "listing ffmpeg encoders",
);
if (encoders.status !== 0 || !encoders.stdout.includes("libvpx-vp9")) {
  fail(
    "ffmpeg lacks the libvpx-vp9 encoder this cut re-encodes with — install " +
      "a full build (Fedora: sudo dnf install ffmpeg, otherwise " +
      "https://ffmpeg.org/download.html) and re-run pnpm --filter web tutorial:cut",
  );
}
if (!existsSync(MASTER)) {
  fail(
    "no master recording at docs/tutorials/media/master.webm — record first: " +
      "pnpm --filter web tutorial:record",
  );
}

const chapters = loadChapters();
const checklistRaw = readFileSync(CHECKLIST, "utf8");
let checklist;
try {
  checklist = JSON.parse(checklistRaw);
} catch (cause) {
  fail(`command-surface checklist is not valid JSON: ${String(cause)}`);
}
if (!Array.isArray(checklist?.entries) || checklist.entries.length === 0) {
  fail("command-surface checklist holds no entries");
}
const coverage = validateCoverage(checklist, chapters);

const masterSeconds = probeDurationSeconds(MASTER, "the master recording");
const lastChapter = chapters[chapters.length - 1];
if (
  lastChapter === undefined ||
  lastChapter.end > masterSeconds + DURATION_TOLERANCE_S
) {
  fail(
    `the cut list runs to ${lastChapter?.end.toFixed(1) ?? "?"}s but the master ` +
      `recording is only ${masterSeconds.toFixed(1)}s — chapters.json and ` +
      `master.webm are from different runs; re-record`,
  );
}
const firstChapter = chapters[0];
if (firstChapter !== undefined && firstChapter.start < 0) {
  fail("the cut list starts before the recording's zero");
}

// Idempotent regeneration: stale clips cannot survive the wipe.
rmSync(CLIPS, { recursive: true, force: true });
mkdirSync(CLIPS, { recursive: true });

let totalBytes = 0;
chapters.forEach((chapter, index) => {
  totalBytes += cutClip(chapter, index + 1, chapters.length);
  writeFileSync(`${CLIPS}/${chapter.id}.vtt`, clipVtt(chapter));
});

const chapterNumbers = new Map(
  chapters.map((chapter, index) => [chapter.id, index + 1]),
);
writeFileSync(
  INDEX,
  buildIndex(chapters, checklist, masterSeconds, chapterNumbers),
);

console.log(
  `[tutorial-cut] ${String(chapters.length)} clips ` +
    `(${(totalBytes / 1024 / 1024).toFixed(1)} MB) + per-clip VTTs in ` +
    `docs/tutorials/media/clips/, index written to docs/tutorials/index.md ` +
    `(${String(coverage.taughtCount)} taught / ` +
    `${String(coverage.notTaughtCount)} not taught of ` +
    `${String(checklist.entries.length)} checklist entries) in ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s`,
);
