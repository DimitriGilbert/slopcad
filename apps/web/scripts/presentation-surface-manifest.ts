/**
 * Regenerate the committed presentation-surface manifest.
 *
 * This is the DELIBERATE half of the drift policy: the guard test
 * (`src/design/presentation-surface/manifest.test.ts`) never rewrites its own
 * baseline — when the handle surface legitimately changes, a human runs this
 * script and commits the JSON, so the diff is reviewable.
 *
 * Usage: `pnpm run surface:manifest` (repo root) or
 *        `npx tsx scripts/presentation-surface-manifest.ts [--check]`
 *
 * `--check` writes nothing and exits non-zero on drift, printing it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildPresentationSurfaceManifest,
  diffManifests,
  MANIFEST_FILE,
  repoRoot,
  serializeManifest,
  type PresentationSurfaceManifest,
} from "../src/design/presentation-surface/manifest";

const root = repoRoot();
const target = join(root, MANIFEST_FILE);
const checkOnly = process.argv.includes("--check");

const manifest = buildPresentationSurfaceManifest(root);
const serialized = serializeManifest(manifest);

const valueCount = manifest.attributes.reduce(
  (total, entry) => total + entry.values.length,
  0,
);
const summary =
  `${String(manifest.routes.length)} routes, ` +
  `${String(manifest.webmcpTools.length)} webmcp tools, ` +
  `${String(manifest.attributes.length)} attributes, ` +
  `${String(valueCount)} literal values`;

if (!checkOnly) {
  writeFileSync(target, serialized, "utf8");
  console.log(`presentation surface written: ${MANIFEST_FILE} — ${summary}`);
  process.exit(0);
}

const committed = JSON.parse(
  readFileSync(target, "utf8"),
) as PresentationSurfaceManifest;
const drift = diffManifests(committed, manifest);
console.log(`presentation surface: ${summary}`);
if (drift.length > 0) {
  console.error(`FAIL: ${String(drift.length)} drift line(s):`);
  for (const line of drift) console.error(`  ${line}`);
  process.exit(1);
}
console.log("PASS: committed manifest matches the working tree");
