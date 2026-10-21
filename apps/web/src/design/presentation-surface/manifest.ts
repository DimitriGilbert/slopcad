/**
 * The presentation-surface manifest: the redesign's contract with automation.
 *
 * ## Why this exists
 *
 * A visual redesign touches every component that renders chrome, and the
 * cheapest way to break the test fleet (and assistive technology) is to
 * rename a `data-testid`, drop an `aria-label`, or stop publishing a
 * `data-*` state while "cleaning up" markup. This manifest snapshots the
 * whole handle surface — routes, WebMCP tool names, and every `aria-*` /
 * `role` / `data-*` declaration with per-value provenance — so a guard test
 * can fail the moment the surface moves.
 *
 * ## Ownership boundary
 *
 * COMMAND IDS ARE NOT OURS. The workbench command vocabulary is owned by
 * `apps/web/e2e-workbench/command-surface.checklist.json` and audited by
 * `scripts/command-surface-audit.mjs`. This manifest owns the PRESENTATION
 * surface and only cross-checks the checklist read-only (every route a
 * checklist entry names must still exist here).
 *
 * ## Drift policy
 *
 * The snapshot beside this file is the committed truth. The guard test never
 * self-heals: when the surface legitimately changes you run
 *
 *     pnpm run surface:manifest
 *
 * and COMMIT the regenerated JSON, so the diff is reviewable. A test that
 * rewrites its own baseline on red proves nothing.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { extractSurfaceAttributes, type SurfaceOrigin } from "./attributes";
import { extractRoutes, type RouteRecord } from "./routes";
import { extractWebMcpTools } from "./webmcp";

/** One literal attribute value and the files that declare it. */
export interface SurfaceValueRecord {
  readonly value: string;
  readonly files: readonly string[];
}

/** One attribute's whole declared surface across the scanned roots. */
export interface SurfaceAttributeEntry {
  readonly attribute: string;
  readonly origin: SurfaceOrigin;
  readonly values: readonly SurfaceValueRecord[];
  /** Files where this attribute's value is computed at runtime. */
  readonly dynamicFiles: readonly string[];
}

/** One WebMCP tool and the files that define it. */
export interface WebMcpToolManifestEntry {
  readonly name: string;
  readonly readOnly: boolean;
  readonly files: readonly string[];
}

/** The committed artifact's shape. */
export interface PresentationSurfaceManifest {
  readonly version: 1;
  /** Repo-relative directories scanned, in scan order. */
  readonly roots: readonly string[];
  readonly routes: readonly RouteRecord[];
  readonly webmcpTools: readonly WebMcpToolManifestEntry[];
  readonly attributes: readonly SurfaceAttributeEntry[];
}

/**
 * The scanned roots: every directory that renders app chrome. Fixture pages
 * are included on purpose — they are real routes with real `data-*`
 * contracts that the per-harness e2e suites read.
 */
export const SURFACE_ROOTS: readonly string[] = [
  "apps/web/src",
  "packages/ui/src",
  "packages/cad-react/src",
  "packages/cad-r3f/src",
  "packages/cad-components/src",
];

/** The generated route tree this manifest derives routes from. */
export const ROUTE_TREE_FILE = "apps/web/src/routeTree.gen.ts";

/** Where the committed snapshot lives, repo-relative. */
export const MANIFEST_FILE =
  "apps/web/src/design/presentation-surface/manifest.snapshot.json";

/** The command-surface checklist this manifest cross-checks, read-only. */
export const CHECKLIST_FILE =
  "apps/web/e2e-workbench/command-surface.checklist.json";

/** Test files CONSUME the surface; only production sources declare it. */
function isScannable(fileName: string): boolean {
  if (!fileName.endsWith(".ts") && !fileName.endsWith(".tsx")) return false;
  if (fileName.endsWith(".d.ts")) return false;
  if (fileName.endsWith(".gen.ts")) return false;
  if (/\.(?:test|spec)\.tsx?$/.test(fileName)) return false;
  if (fileName === "test-setup.ts") return false;
  return true;
}

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".output",
  "coverage",
]);

/** Every scannable source file under `directory`, repo-relative and sorted. */
function sourceFiles(repoRoot: string, directory: string): readonly string[] {
  const absolute = join(repoRoot, directory);
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(join(current, entry.name));
      } else if (entry.isFile() && isScannable(entry.name)) {
        found.push(
          relative(repoRoot, join(current, entry.name)).split(sep).join("/"),
        );
      }
    }
  };
  walk(absolute);
  return found.sort();
}

/** Walk up from `start` to the pnpm workspace root. */
export function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`no pnpm-workspace.yaml above ${start}`);
    }
    current = parent;
  }
}

/** The repo root resolved from this module's own location. */
export function repoRoot(): string {
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}

/** Build the manifest by scanning the working tree at `root`. */
export function buildPresentationSurfaceManifest(
  root: string,
): PresentationSurfaceManifest {
  const valueFiles = new Map<string, Map<string, Set<string>>>();
  const dynamicFiles = new Map<string, Set<string>>();
  const tools = new Map<string, WebMcpToolManifestEntry>();

  const keyOf = (attribute: string, origin: SurfaceOrigin): string =>
    `${origin}\u0000${attribute}`;

  for (const scanRoot of SURFACE_ROOTS) {
    for (const file of sourceFiles(root, scanRoot)) {
      const sourceText = readFileSync(join(root, file), "utf8");

      for (const occurrence of extractSurfaceAttributes(file, sourceText)) {
        const key = keyOf(occurrence.attribute, occurrence.origin);
        const values = valueFiles.get(key) ?? new Map<string, Set<string>>();
        for (const value of occurrence.values) {
          const files = values.get(value) ?? new Set<string>();
          files.add(file);
          values.set(value, files);
        }
        valueFiles.set(key, values);
        if (occurrence.dynamic) {
          const files = dynamicFiles.get(key) ?? new Set<string>();
          files.add(file);
          dynamicFiles.set(key, files);
        }
      }

      for (const tool of extractWebMcpTools(file, sourceText)) {
        const existing = tools.get(tool.name);
        tools.set(tool.name, {
          name: tool.name,
          readOnly: tool.readOnly || (existing?.readOnly ?? false),
          files: [...new Set([...(existing?.files ?? []), file])].sort(),
        });
      }
    }
  }

  const attributes: SurfaceAttributeEntry[] = [...valueFiles.keys()]
    .concat([...dynamicFiles.keys()])
    .filter((key, index, all) => all.indexOf(key) === index)
    .map((key) => {
      const [origin, attribute] = key.split("\u0000");
      const values = valueFiles.get(key) ?? new Map<string, Set<string>>();
      return {
        attribute: attribute ?? "",
        origin: origin === "setAttribute" ? "setAttribute" : "jsx",
        values: [...values.entries()]
          .map(([value, files]) => ({ value, files: [...files].sort() }))
          .sort((a, b) => a.value.localeCompare(b.value)),
        dynamicFiles: [...(dynamicFiles.get(key) ?? new Set<string>())].sort(),
      } satisfies SurfaceAttributeEntry;
    })
    .sort(
      (a, b) =>
        a.attribute.localeCompare(b.attribute) ||
        a.origin.localeCompare(b.origin),
    );

  return {
    version: 1,
    roots: SURFACE_ROOTS,
    routes: extractRoutes(readFileSync(join(root, ROUTE_TREE_FILE), "utf8")),
    webmcpTools: [...tools.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    attributes,
  };
}

/** Serialize the manifest exactly as the committed snapshot stores it. */
export function serializeManifest(
  manifest: PresentationSurfaceManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Read the committed snapshot. */
export function readManifestSnapshot(
  root: string,
): PresentationSurfaceManifest {
  const text = readFileSync(join(root, MANIFEST_FILE), "utf8");
  return JSON.parse(text) as PresentationSurfaceManifest;
}

/** One human-readable drift line. */
export type SurfaceDrift = string;

function labelOf(entry: SurfaceAttributeEntry): string {
  return entry.origin === "jsx"
    ? entry.attribute
    : `${entry.attribute} (setAttribute)`;
}

/**
 * Describe how `actual` differs from `expected`, as reviewable lines. An
 * empty array means the surface is unchanged.
 */
export function diffManifests(
  expected: PresentationSurfaceManifest,
  actual: PresentationSurfaceManifest,
): readonly SurfaceDrift[] {
  const drift: string[] = [];

  const setDrift = (
    what: string,
    before: readonly string[],
    after: readonly string[],
  ): void => {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    for (const value of after) {
      if (!beforeSet.has(value)) drift.push(`+ ${what}: ${value}`);
    }
    for (const value of before) {
      if (!afterSet.has(value)) drift.push(`- ${what}: ${value}`);
    }
  };

  setDrift(
    "route",
    expected.routes.map((route) => `${route.id} -> ${route.module}`),
    actual.routes.map((route) => `${route.id} -> ${route.module}`),
  );
  setDrift(
    "webmcp tool",
    expected.webmcpTools.map((tool) => tool.name),
    actual.webmcpTools.map((tool) => tool.name),
  );

  const expectedAttributes = new Map(
    expected.attributes.map((entry) => [labelOf(entry), entry]),
  );
  const actualAttributes = new Map(
    actual.attributes.map((entry) => [labelOf(entry), entry]),
  );
  setDrift(
    "attribute",
    [...expectedAttributes.keys()],
    [...actualAttributes.keys()],
  );

  for (const [label, actualEntry] of actualAttributes) {
    const expectedEntry = expectedAttributes.get(label);
    if (expectedEntry === undefined) continue;
    setDrift(
      `${label} value`,
      expectedEntry.values.map((value) => value.value),
      actualEntry.values.map((value) => value.value),
    );
    setDrift(
      `${label} provenance`,
      expectedEntry.values.flatMap((value) =>
        value.files.map((file) => `${value.value} @ ${file}`),
      ),
      actualEntry.values.flatMap((value) =>
        value.files.map((file) => `${value.value} @ ${file}`),
      ),
    );
    setDrift(
      `${label} dynamic`,
      expectedEntry.dynamicFiles,
      actualEntry.dynamicFiles,
    );
  }

  return drift;
}
