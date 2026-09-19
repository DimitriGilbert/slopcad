#!/usr/bin/env node
/**
 * Phase 33 registry validation: checks every source registry entry and
 * (with --artifacts) every built artifact in packages/ui/public/r.
 *
 * Source checks (always):
 *   - schema/name/homepage/items present; item fields typed and present
 *   - every declared file exists on disk, relative to its registry
 *   - file paths and targets are relative, no parent traversal, no URLs
 *   - dependencies are external package names (NO workspace:/file:/link:/
 *     catalog: protocols, no relative or URL specifiers)
 *   - registryDependencies are @slopcad/<item> addresses that resolve to an
 *     item in the union of all source registries
 *   - item names are unique across the union
 *   - the four Phase 33 categories are covered (anchors below)
 *
 * Artifact checks (--artifacts, after scripts/registry-build.sh):
 *   - one built item JSON per source item, and no stale extra items
 *   - each artifact's file content is byte-identical to its source file
 *   - no artifact anywhere contains a workspace/file/link/catalog protocol
 *     reference — the published set must be resolvable by an external
 *     consumer (the repo's documented stand-in: the @slopcad/cad-* packages
 *     are not on npm by owner decree; consumers predeclare them)
 *
 * Usage: node scripts/registry-validate.mjs [--artifacts]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WITH_ARTIFACTS = process.argv.includes("--artifacts");

/** The source registries, in build order. */
const SOURCE_REGISTRIES = [
  { label: "packages/ui", file: "packages/ui/registry.json" },
  {
    label: "packages/cad-components",
    file: "packages/cad-components/registry.json",
  },
  { label: "apps/web", file: "apps/web/registry.json" },
];

/** Anchors proving each Phase 33 category is published. */
const CATEGORY_ANCHORS = [
  { category: "33.1 ui registry", item: "cad-viewport" },
  { category: "33.2 cad component registry", item: "nema17-mount" },
  { category: "33.3 example registry", item: "plate-workbench" },
  { category: "33.3 example registry", item: "nema17-assembly-example" },
  { category: "33.4 tool registry", item: "bounds-inspection-tool" },
];

const ITEM_TYPES = new Set([
  "registry:item",
  "registry:block",
  "registry:component",
  "registry:lib",
  "registry:hook",
  "registry:ui",
  "registry:file",
  "registry:page",
  "registry:theme",
  "registry:style",
  "registry:font",
]);

const NPM_NAME_WITH_VERSION =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9][^/]*)?$/;
const FORBIDDEN_PROTOCOLS =
  /^(workspace:|file:|link:|catalog:|portal:|https?:)/;
/**
 * A pnpm internal protocol in published bytes: `workspace:`/`catalog:`
 * directly followed by a non-space (prose like "the workspace: tree"
 * leaves a space after the colon and must not match).
 */
const INTERNAL_PROTOCOL_IN_BYTES = /(workspace:[^\s"]|catalog:[^\s"])/;

const errors = [];
const error = (message) => errors.push(message);

/** A safe relative path: not absolute, no traversal, no URL, no backslash. */
function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[a-z]+:/i.test(value) &&
    !value.split("/").includes("..") &&
    !value.includes("\\")
  );
}

// -- collect + validate the sources -----------------------------------------

const unionItems = new Map(); // name -> { label, item }
for (const source of SOURCE_REGISTRIES) {
  const registryPath = join(ROOT, source.file);
  if (!existsSync(registryPath)) {
    error(`${source.file}: registry file is missing`);
    continue;
  }
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (parseError) {
    error(`${source.file}: not valid JSON (${parseError.message})`);
    continue;
  }
  if (typeof registry.name !== "string" || registry.name.length === 0) {
    error(`${source.file}: missing "name"`);
  }
  if (typeof registry.homepage !== "string" || registry.homepage.length === 0) {
    error(`${source.file}: missing "homepage"`);
  }
  if (!Array.isArray(registry.items) || registry.items.length === 0) {
    error(`${source.file}: "items" must be a non-empty array`);
    continue;
  }
  const baseDir = dirname(registryPath);
  for (const item of registry.items) {
    const id = `${source.file}#${item.name ?? "<unnamed>"}`;
    if (
      typeof item.name !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(item.name)
    ) {
      error(`${id}: "name" must be a lowercase kebab-case string`);
      continue;
    }
    if (unionItems.has(item.name)) {
      error(
        `${id}: duplicate item name (already declared by ${unionItems.get(item.name).label})`,
      );
      continue;
    }
    unionItems.set(item.name, { label: source.file, item });
    if (typeof item.title !== "string" || item.title.length === 0) {
      error(`${id}: missing "title"`);
    }
    if (typeof item.description !== "string" || item.description.length === 0) {
      error(`${id}: missing "description"`);
    }
    if (!ITEM_TYPES.has(item.type)) {
      error(`${id}: invalid "type" ${JSON.stringify(item.type)}`);
    }
    if (!Array.isArray(item.files) || item.files.length === 0) {
      error(`${id}: "files" must be a non-empty array`);
      continue;
    }
    for (const file of item.files) {
      if (!isSafeRelativePath(file.path)) {
        error(`${id}: unsafe file path ${JSON.stringify(file.path)}`);
        continue;
      }
      if (file.target !== undefined && !isSafeRelativePath(file.target)) {
        error(`${id}: unsafe file target ${JSON.stringify(file.target)}`);
      }
      const onDisk = join(baseDir, file.path);
      if (!existsSync(onDisk)) {
        error(`${id}: declared file does not exist: ${file.path}`);
      }
    }
    for (const dependency of item.dependencies ?? []) {
      if (
        typeof dependency !== "string" ||
        FORBIDDEN_PROTOCOLS.test(dependency) ||
        dependency.startsWith(".") ||
        !NPM_NAME_WITH_VERSION.test(dependency)
      ) {
        error(
          `${id}: dependency is not an external package name: ${JSON.stringify(dependency)}`,
        );
      }
    }
  }
}

// Registry dependencies must resolve inside the union (after collection).
for (const [name, { label, item }] of unionItems) {
  for (const address of item.registryDependencies ?? []) {
    if (typeof address !== "string" || !address.startsWith("@slopcad/")) {
      error(
        `${label}#${name}: registryDependency must be an @slopcad/<item> address, got ${JSON.stringify(address)}`,
      );
      continue;
    }
    const target = address.slice("@slopcad/".length);
    if (!unionItems.has(target)) {
      error(
        `${label}#${name}: registryDependency ${address} does not resolve to any source item`,
      );
    }
  }
}

// Category anchors.
for (const anchor of CATEGORY_ANCHORS) {
  if (!unionItems.has(anchor.item)) {
    error(
      `category "${anchor.category}" is not covered: item "${anchor.item}" is missing`,
    );
  }
}

// -- artifact checks ---------------------------------------------------------

if (WITH_ARTIFACTS) {
  const artifactDir = join(ROOT, "packages/ui/public/r");
  if (!existsSync(artifactDir)) {
    error(
      "artifacts: packages/ui/public/r does not exist (run scripts/registry-build.sh)",
    );
  } else {
    const builtNames = new Set(
      readdirSync(artifactDir)
        .filter((entry) => entry.endsWith(".json") && entry !== "registry.json")
        .map((entry) => entry.slice(0, -".json".length)),
    );
    for (const name of unionItems.keys()) {
      if (!builtNames.has(name)) {
        error(`artifacts: no built artifact for item "${name}"`);
        continue;
      }
      const artifact = JSON.parse(
        readFileSync(join(artifactDir, `${name}.json`), "utf8"),
      );
      for (const dependency of artifact.dependencies ?? []) {
        if (
          typeof dependency !== "string" ||
          FORBIDDEN_PROTOCOLS.test(dependency) ||
          dependency.startsWith(".")
        ) {
          error(
            `artifacts/${name}.json: non-external dependency ${JSON.stringify(dependency)}`,
          );
        }
      }
      const source = unionItems.get(name);
      for (const [index, file] of (artifact.files ?? []).entries()) {
        if (file.target !== undefined && !isSafeRelativePath(file.target)) {
          error(
            `artifacts/${name}.json: unsafe target ${JSON.stringify(file.target)}`,
          );
        }
        const declared = source.item.files[index];
        if (!declared) {
          error(`artifacts/${name}.json: file list does not match the source`);
          continue;
        }
        const onDisk = join(ROOT, dirname(source.label), declared.path);
        if (!existsSync(onDisk)) continue; // already reported above
        const sourceBytes = readFileSync(onDisk, "utf8");
        if (file.content !== sourceBytes) {
          error(
            `artifacts/${name}.json: embedded content of ${declared.path} is stale (rerun scripts/registry-build.sh)`,
          );
        }
      }
    }
    for (const name of builtNames) {
      if (!unionItems.has(name)) {
        error(
          `artifacts: stale built artifact "${name}.json" has no source item`,
        );
      }
    }
    // The blanket protocol scan: no pnpm-internal protocol (workspace:,
    // catalog:) may remain anywhere in the published bytes — every
    // dependency must resolve as a plain external package name.
    for (const entry of readdirSync(artifactDir).sort()) {
      if (!entry.endsWith(".json")) continue;
      const bytes = readFileSync(join(artifactDir, entry), "utf8");
      if (INTERNAL_PROTOCOL_IN_BYTES.test(bytes)) {
        error(
          `artifacts/${entry}: contains a workspace:/catalog: protocol reference`,
        );
      }
    }
  }
}

// -- report -------------------------------------------------------------------

const mode = WITH_ARTIFACTS ? "sources+artifacts" : "sources";
if (errors.length > 0) {
  console.error(
    `registry validation (${mode}) FAILED with ${errors.length} error(s):`,
  );
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `registry validation (${mode}) passed: ${unionItems.size} items across ${SOURCE_REGISTRIES.length} source registries; all categories covered (${CATEGORY_ANCHORS.map((a) => a.item).join(", ")})${WITH_ARTIFACTS ? "; artifacts byte-fresh, external-only" : ""}`,
);
