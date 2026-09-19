/**
 * Independence and public-API tests (Phase 32, phase-level): the three
 * components are independently usable — importing one never loads the
 * others — and every module in the package builds exclusively on public
 * slopcad surfaces (cad-core's and cad-kernel's package entries, plus
 * this package's own modules), never on kernel/worker internals.
 *
 * This file deliberately uses DYNAMIC imports for each component subpath:
 * its own module graph carries none of them, so each import proves the
 * subpath stands alone.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createJscadKernel } from "@slopcad/cad-jscad";
import type { GeometryKernel } from "@slopcad/cad-kernel";

import { directComponentKernel } from "./component-kernel";

const SRC = path.resolve(import.meta.dirname);

/** The import specifiers of one source file, in order. */
async function importsOf(file: string): Promise<readonly string[]> {
  const text = await readFile(path.join(SRC, file), "utf8");
  const specifiers: string[] = [];
  for (const match of text.matchAll(/import[^'"]*?from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** The public external surfaces a cad-components module may import. */
const PUBLIC_EXTERNAL_SURFACES: ReadonlySet<string> = new Set([
  "@slopcad/cad-core",
  "@slopcad/cad-kernel",
  "@slopcad/cad-kernel/opaque",
]);

const COMPONENT_FILES = [
  "nema17-mount.ts",
  "arduino-mount.ts",
  "enclosure.ts",
] as const;

describe("independently usable components", () => {
  it("no component module imports any other component (static graph)", async () => {
    for (const file of COMPONENT_FILES) {
      const imports = await importsOf(file);
      for (const specifier of imports) {
        const otherComponents = COMPONENT_FILES.filter(
          (candidate) =>
            candidate !== file &&
            (specifier === `./${candidate.replace(/\.ts$/, "")}` ||
              specifier.includes(candidate.replace(/\.ts$/, ""))),
        );
        expect(otherComponents, `${file} must not import ${specifier}`).toEqual(
          [],
        );
      }
    }
  });

  it("each component subpath builds on its own (dynamic import, no index)", async () => {
    const kernel: GeometryKernel = createJscadKernel();
    const cases = [
      {
        file: "nema17-mount",
        build: async () => {
          const module = await import("./nema17-mount");
          return module.nema17Mount.build(
            directComponentKernel(kernel),
            module.NEMA17_MOUNT_DEFAULT_PARAMETERS,
          );
        },
      },
      {
        file: "arduino-mount",
        build: async () => {
          const module = await import("./arduino-mount");
          return module.arduinoMount.build(
            directComponentKernel(kernel),
            module.ARDUINO_MOUNT_DEFAULT_PARAMETERS,
          );
        },
      },
      {
        file: "enclosure",
        build: async () => {
          const module = await import("./enclosure");
          return module.enclosure.build(
            directComponentKernel(kernel),
            module.ENCLOSURE_DEFAULT_PARAMETERS,
          );
        },
      },
    ];
    for (const component of cases) {
      const build = await component.build();
      expect(build.ok, component.file).toBe(true);
      if (build.ok) {
        expect(build.value.bodies.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("public-APIs-only import graph", () => {
  it("every package module imports only public external surfaces", async () => {
    const files = [
      "index.ts",
      "component-contract.ts",
      "cad-component.ts",
      "component-kernel.ts",
      "context-kernel.ts",
      "component-fixtures.ts",
      ...COMPONENT_FILES,
    ];
    for (const file of files) {
      const imports = await importsOf(file);
      for (const specifier of imports) {
        if (specifier.startsWith("@slopcad/")) {
          expect(
            PUBLIC_EXTERNAL_SURFACES.has(specifier),
            `${file} imports non-public surface ${specifier}`,
          ).toBe(true);
        }
      }
    }
  });

  it("no module reaches outside the package or into deep kernel paths", async () => {
    const files = [
      "index.ts",
      "component-contract.ts",
      "cad-component.ts",
      "component-kernel.ts",
      "context-kernel.ts",
      "component-fixtures.ts",
      ...COMPONENT_FILES,
    ];
    for (const file of files) {
      for (const specifier of await importsOf(file)) {
        expect(
          specifier.startsWith("../"),
          `${file} must not import outside the package (${specifier})`,
        ).toBe(false);
        expect(
          specifier.includes("cad-kernel/src/"),
          `${file} must not deep-import kernel internals (${specifier})`,
        ).toBe(false);
        expect(
          specifier.includes("worker-"),
          `${file} must not import worker internals (${specifier})`,
        ).toBe(false);
      }
    }
  });
});
