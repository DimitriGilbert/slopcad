/**
 * Structural CAD-component boundary test (Phase 15.1 validation: the UI
 * package "does not import kernels"). Mirrors the executable allowlist
 * pattern of `packages/cad-r3f/src/renderer-boundary.test.ts`, scoped to
 * this directory — the CAD component area of `packages/ui`: every
 * non-test source file's import specifiers are checked against the public
 * CAD React/R3F surface and the package's own modules, so a kernel or
 * worker import cannot enter the CAD components without failing this
 * suite. The rest of `packages/ui` (shadcn primitives, formedible) keeps
 * its own dependency surface and is deliberately out of scope here.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the CAD component area may import: React, the two public CAD
 * packages (the React integration layer and the R3F renderer), the
 * shadcn-ui `cn` class-merging package (the registry-distribution import
 * the components share with the rest of the primitives), the package's
 * own modules (`@slopcad/ui/*` self-imports and relative paths), and Node
 * builtins. Kernels (`@slopcad/kernel-*`, `@slopcad/cad-kernel*`), worker
 * modules, and even direct three/R3F imports are NOT on the list — the
 * components compose `CadScene`, and a need for anything below it is a
 * boundary decision, not an import.
 */
const ALLOWED_IMPORT_SOURCES: ReadonlySet<string> = new Set([
  "react",
  "cn",
  "@slopcad/cad-react",
  "@slopcad/cad-r3f",
]);

/** Specifier prefixes the CAD component area may import under. */
const ALLOWED_IMPORT_PREFIXES: readonly string[] = [
  "@slopcad/ui/",
  "node:",
  "./",
  "../",
];

const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".tsx"];
const TEST_EXTENSIONS: readonly string[] = [".test.ts", ".test.tsx"];

/** The suite always runs with the package directory as the working directory. */
const CAD_COMPONENT_DIR = join("src", "components", "cad");

const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /from\s+"([^"]+)"/g,
  /import\s+"([^"]+)"/g,
  /import\(\s*"([^"]+)"\s*\)/g,
];

/** Recursively lists every non-test source file under a directory. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) &&
      !TEST_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    ) {
      files.push(path);
    }
  }
  return files;
}

function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/** Collects every allowlist violation in the source files under a directory. */
function boundaryViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const file of listSourceFiles(dir)) {
    const text = readFileSync(file, "utf8");
    for (const specifier of importSpecifiersOf(text)) {
      const allowed =
        ALLOWED_IMPORT_SOURCES.has(specifier) ||
        ALLOWED_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix));
      if (!allowed) {
        violations.push(`${file} imports "${specifier}"`);
      }
    }
  }
  return violations;
}

describe("CAD component import boundary", () => {
  it("imports only the public CAD surface and the package's own modules — never kernels or workers", () => {
    expect(boundaryViolations(CAD_COMPONENT_DIR)).toEqual([]);
  });

  it("descends into subdirectories, so a nested file cannot hide a kernel import", () => {
    const kernelSpecifier = "@slopcad/kernel-occt";
    // Assembled from fragments so this test file's own source never carries
    // the forbidden specifier in an import-shaped position: the boundary
    // scan reads candidate files it is pointed at, and tests stay out of
    // the production scan — this temp tree is scanned explicitly instead.
    const hiddenKernelImport = [
      "import { loadKernel } from",
      `"${kernelSpecifier}";`,
      "export { loadKernel };",
    ].join(" ");
    const root = mkdtempSync(join(tmpdir(), "slopcad-ui-cad-boundary-"));
    try {
      const nested = join(root, "cad", "worker-bridge");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "cad", "surface.ts"), "export {};\n", "utf8");
      writeFileSync(
        join(nested, "bridge.ts"),
        `${hiddenKernelImport}\n`,
        "utf8",
      );
      expect(boundaryViolations(join(root, "cad"))).toEqual([
        `${join(nested, "bridge.ts")} imports "${kernelSpecifier}"`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
