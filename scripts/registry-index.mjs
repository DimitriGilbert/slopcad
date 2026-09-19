#!/usr/bin/env node
/**
 * Regenerates the merged registry index (registry.json) of a built shadcn
 * registry artifact directory. `shadcn build` writes one index per source
 * registry (its own items only); this script unions every per-item JSON in
 * the directory into the single index the @slopcad namespace serves, so
 * `shadcn list`-style discovery sees all items from all source registries.
 *
 * The index is a summary (no file contents): name, type, title,
 * description, dependencies, registryDependencies, and file paths.
 *
 * Usage: node scripts/registry-index.mjs <artifact-directory>
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
if (typeof directory !== "string" || directory.length === 0) {
  console.error("Usage: node scripts/registry-index.mjs <artifact-directory>");
  process.exit(1);
}

const ITEM_SCHEMA = "https://ui.shadcn.com/schema/registry-item.json";
const items = [];
for (const entry of readdirSync(directory).sort()) {
  if (!entry.endsWith(".json") || entry === "registry.json") continue;
  const parsed = JSON.parse(readFileSync(join(directory, entry), "utf8"));
  if (parsed?.$schema !== ITEM_SCHEMA) continue;
  items.push({
    name: parsed.name,
    type: parsed.type,
    title: parsed.title,
    description: parsed.description,
    ...(Array.isArray(parsed.dependencies) && parsed.dependencies.length > 0
      ? { dependencies: parsed.dependencies }
      : {}),
    ...(Array.isArray(parsed.registryDependencies) &&
    parsed.registryDependencies.length > 0
      ? { registryDependencies: parsed.registryDependencies }
      : {}),
    files: (parsed.files ?? []).map((file) => ({
      path: file.path,
      type: file.type,
      ...(typeof file.target === "string" ? { target: file.target } : {}),
    })),
  });
}
items.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  join(directory, "registry.json"),
  `${JSON.stringify(
    {
      $schema: "https://ui.shadcn.com/schema/registry.json",
      name: "slopcad",
      homepage: "https://github.com/slopcad/slopcad",
      items,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `registry index: ${items.length} items -> ${join(directory, "registry.json")}`,
);
