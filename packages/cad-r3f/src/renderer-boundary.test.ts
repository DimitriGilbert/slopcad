/**
 * Structural renderer-boundary test (Phase 11.2 validation: "No
 * kernel-specific imports exist in renderer"). Scans every source file's
 * import specifiers against the renderer's allowlist — the cad-core/cad-react
 * projection surface and the declared render peers — so a kernel or worker
 * import cannot enter cad-r3f without failing this suite.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Modules cad-r3f may import: the projection contract, its React re-export, and the declared render/test peers. */
const ALLOWED_IMPORT_SOURCES: ReadonlySet<string> = new Set([
  "three",
  "react",
  "react-dom",
  "@react-three/fiber",
  "@slopcad/cad-core",
  "@slopcad/cad-react",
  "vitest",
  "@testing-library/react",
  "@testing-library/dom",
]);

const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".tsx"];

/** The suite always runs with the package directory as the working directory. */
const SOURCE_DIR = "src";

const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /from\s+"([^"]+)"/g,
  /import\s+"([^"]+)"/g,
  /import\(\s*"([^"]+)"\s*\)/g,
];

/** Recursively lists every source file under a directory, descending into subdirectories. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
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
        specifier.startsWith("node:") ||
        specifier.startsWith("./");
      if (!allowed) {
        violations.push(`${file} imports "${specifier}"`);
      }
    }
  }
  return violations;
}

describe("renderer import boundary", () => {
  it("imports only the projection contract and declared render peers — never kernels or workers", () => {
    expect(boundaryViolations(SOURCE_DIR)).toEqual([]);
  });

  it("descends into source subdirectories, so a nested file cannot hide a kernel import", () => {
    const kernelSpecifier = "@slopcad/kernel-occt";
    // Assembled from fragments so this test file's own source never carries
    // the forbidden specifier in an import-shaped position: the boundary
    // scan below reads this file too.
    const hiddenKernelImport = [
      "import { loadKernel } from",
      `"${kernelSpecifier}";`,
      "export { loadKernel };",
    ].join(" ");
    const root = mkdtempSync(join(tmpdir(), "cad-r3f-renderer-boundary-"));
    try {
      const nested = join(root, "src", "worker-bridge");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "src", "surface.ts"), "export {};\n", "utf8");
      writeFileSync(join(nested, "bridge.ts"), `${hiddenKernelImport}\n`, "utf8");
      expect(boundaryViolations(join(root, "src"))).toEqual([
        `${join(nested, "bridge.ts")} imports "${kernelSpecifier}"`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
