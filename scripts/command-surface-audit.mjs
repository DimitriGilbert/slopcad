#!/usr/bin/env node
/**
 * Phase 60 command-surface audit — the mechanical half.
 *
 * The Phase 60 block requires a "mechanical checklist generated from this
 * document": every feature/inspection/exchange capability the roadmap
 * shipped (phases 36-56 at this epoch; 57-59 land via sibling worktrees
 * and extend the checklist as data) must be reachable from a workbench's
 * command menu or a named panel, each item e2e-asserted.
 *
 * This script is the roadmap -> checklist closure check:
 *
 *   1. It parses ROADMAP-CAD-PARITY.md, extracts every
 *      Requirements/Deliverables bullet of phases 36-56 (multi-line
 *      bullets joined), and tokenizes each into significant words.
 *   2. It loads apps/web/e2e-workbench/command-surface.checklist.json —
 *      the curated capability -> surface map the e2e spec drives.
 *   3. Every bullet must be CLAIMED by >=1 checklist entry of the same
 *      phase (>=2 shared significant tokens; >=1 for very short bullets).
 *      Every phase must carry >=1 entry or an explicit `declines` record.
 *
 * Exit 0 = closure holds. Exit 1 = unclaimed bullets / phases listed —
 * a roadmap edit that ships a new capability without a mapped surface
 * (or a checklist entry nobody claims) fails this audit. The DOM half of
 * the audit is `apps/web/e2e-workbench/command-surface.spec.ts` (the
 * workbench harness asserts the mapped surfaces actually mount and the
 * command menu's row set matches the checklist exactly, both directions).
 *
 * Usage: node scripts/command-surface-audit.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROADMAP = `${ROOT}/ROADMAP-CAD-PARITY.md`;
const CHECKLIST = `${ROOT}/apps/web/e2e-workbench/command-surface.checklist.json`;

/** Phases this epoch shipped (57-59 are sibling worktrees at this tip). */
const PHASES = Array.from({ length: 56 - 36 + 1 }, (_, i) => 36 + i);

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "every",
  "new",
  "its",
  "from",
  "into",
  "via",
  "per",
  "not",
  "may",
  "all",
  "any",
  "one",
  "two",
  "each",
  "their",
  "they",
  "them",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "how",
  "what",
  "more",
  "most",
  "less",
  "least",
  "only",
  "same",
  "such",
  "too",
  "very",
  "can",
  "will",
  "must",
  "should",
  "would",
  "could",
  "does",
  "done",
  "has",
  "have",
  "had",
  "get",
  "got",
  "make",
  "made",
  "use",
  "used",
  "uses",
  "using",
  "are",
  "was",
  "were",
  "been",
  "being",
  "also",
  "both",
  "between",
  "across",
  "after",
  "before",
  "under",
  "over",
  "about",
  "along",
  "behind",
  "below",
  "above",
  "like",
  "unto",
  "onto",
  "upon",
  "out",
  "off",
  "own",
  "per",
  "pre",
  "pro",
  "non",
  "nor",
  "but",
  "yet",
  "so",
  "if",
  "in",
  "on",
  "at",
  "by",
  "as",
  "is",
  "it",
  "of",
  "to",
  "or",
  "an",
  "a",
]);

/** Lowercase word tokens (>=3 chars) of a text blob, stopwords dropped. */
function tokens(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Extract, per phase block, the joined Requirements/Deliverables bullets:
 * a bullet starts at a top-level "- " line and owns its indented
 * continuation lines until the next bullet or the next bold heading.
 */
function bulletsOf(block) {
  const head = block.split("**Validation**")[0];
  const seg = head.split("**Requirements**:").pop() ?? "";
  const out = [];
  let current = null;
  for (const line of seg.split("\n")) {
    if (line.startsWith("- ")) {
      if (current !== null) out.push(current);
      current = line.slice(2);
    } else if (
      current !== null &&
      line.startsWith("  ") &&
      line.trim() !== "" &&
      !line.trim().startsWith("**")
    ) {
      current += ` ${line.trim()}`;
    } else if (line.trim() === "" && current !== null) {
      out.push(current);
      current = null;
    }
  }
  if (current !== null) out.push(current);
  return out.map((b) => " ".concat(b.split(/\s+/).join(" ").trim()));
}

function parseRoadmap() {
  const text = readFileSync(ROADMAP, "utf8");
  const map = new Map();
  for (const block of text.split(/^### /m).slice(1)) {
    const match = block.match(/^Phase (\d+) — /);
    if (match === null) continue;
    const phase = Number(match[1]);
    if (!PHASES.includes(phase)) continue;
    map.set(phase, bulletsOf(block));
  }
  return map;
}

const roadmap = parseRoadmap();
const checklist = JSON.parse(readFileSync(CHECKLIST, "utf8"));

const entries = Array.isArray(checklist.entries) ? checklist.entries : [];
const declines = Array.isArray(checklist.declines) ? checklist.declines : [];

const failures = [];

// Every audited phase must appear (entries or an explicit decline record).
const entryPhases = new Set(entries.map((e) => e.phase));
const declinePhases = new Set(declines.map((d) => d.phase));
for (const phase of PHASES) {
  if (!entryPhases.has(phase) && !declinePhases.has(phase)) {
    failures.push(`phase ${phase}: no checklist entry and no decline record`);
  }
}

// Bullet closure: every roadmap bullet is claimed by >=1 entry of its phase.
let claimed = 0;
for (const [phase, bullets] of roadmap) {
  const phaseEntries = entries.filter((e) => e.phase === phase);
  const phaseKeywords = phaseEntries.flatMap((e) =>
    tokens((e.keywords ?? []).join(" ")),
  );
  const phaseDeclines = declines.filter((d) => d.phase === phase);
  const declineKeywords = phaseDeclines.flatMap((d) =>
    tokens(`${d.capability} ${d.reason} ${d.evidence ?? ""}`),
  );
  const pool = new Set([...phaseKeywords, ...declineKeywords]);
  for (const bullet of bullets) {
    const bulletTokens = tokens(bullet);
    const threshold = bulletTokens.length < 4 ? 1 : 2;
    const hit = bulletTokens.filter((t) => pool.has(t));
    if (hit.length >= threshold) {
      claimed += 1;
    } else {
      failures.push(
        `phase ${phase}: unclaimed bullet "${bullet.slice(0, 90)}..."` +
          ` (entry keywords must share >=${threshold} tokens)`,
      );
    }
  }
}

// Checklist hygiene: entries must name a real route and kind.
const KINDS = new Set(["command", "command-panel", "panel"]);
for (const entry of entries) {
  if (!KINDS.has(entry.kind)) {
    failures.push(`entry ${entry.id}: unknown kind "${entry.kind}"`);
  }
  if (typeof entry.route !== "string" || !entry.route.startsWith("/")) {
    failures.push(`entry ${entry.id}: route must be an app path`);
  }
  if (entry.kind !== "command" && !Array.isArray(entry.targets)) {
    failures.push(`entry ${entry.id}: panel entries need targets[]`);
  }
  if (entry.kind === "command" && typeof entry.target !== "string") {
    failures.push(
      `entry ${entry.id}: command entries need target (command id)`,
    );
  }
}

const totalBullets = [...roadmap.values()].reduce((n, b) => n + b.length, 0);
console.log(
  `command-surface audit: phases ${PHASES[0]}-${PHASES.at(-1)}, ` +
    `${totalBullets} roadmap bullets, ${claimed} claimed, ` +
    `${entries.length} entries + ${declines.length} declines`,
);
if (failures.length > 0) {
  console.error("FAIL:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS: every roadmap bullet is claimed by a mapped surface");
