#!/usr/bin/env node
/**
 * Phase 60 api-audit epoch — the mechanical barrel counter.
 *
 * Re-runs the Phase 35 audit's export inventory at the new epoch
 * (docs/architecture/api-audit.md): for every workspace CAD/service
 * package, enumerate the barrel's (`src/index.ts`) exported NAMES with
 * the TypeScript compiler API — explicit named exports, aliased re-exports,
 * and `export *` chains resolved (cad-react re-exports cad-core
 * wholesale) — and compare each count against the recorded epoch.
 *
 * A count CHANGE is not a failure (phases 36-60 legitimately grew the
 * surfaces); a change that the audit document was not updated for IS.
 * Run with `--check` to exit 1 on any drift from the counts embedded
 * below (update them alongside docs/architecture/api-audit.md when the
 * epoch moves).
 *
 * Usage: node scripts/api-audit-epoch.mjs [--check]
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Phase 60 epoch's expected counts (see the audit doc's table). */
const EPOCH = {
  epoch: "phase-60",
  counts: {
    "@slopcad/cad-core": 946,
    "@slopcad/cad-kernel": 382,
    "@slopcad/cad-kernel-manifold": 15,
    "@slopcad/cad-kernel-occt": 53,
    "@slopcad/cad-jscad": 10,
    "@slopcad/cad-r3f": 112,
    "@slopcad/cad-react": 984,
    "@slopcad/cad-sketch": 286,
    "@slopcad/cad-io": 91,
    "@slopcad/cad-components": 60,
    "@slopcad/api": 4,
    "@slopcad/auth": 2,
    "@slopcad/db": 4,
  },
};

const PACKAGES = Object.keys(EPOCH.counts).filter((name) => {
  const dir = name.replace("@slopcad/", "");
  return existsSync(join(ROOT, "packages", dir, "src", "index.ts"));
});

function readSource(file) {
  return readFileSync(file, "utf8");
}

/** Exported names of one barrel file (`export *` chains resolved). */
function directExports(sourceFile, seen) {
  if (seen.has(sourceFile)) return [];
  seen.add(sourceFile);
  if (!existsSync(sourceFile)) return [];

  const source = ts.createSourceFile(
    sourceFile,
    readSource(sourceFile),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = [];

  const resolveModule = (specifier) => {
    if (specifier.startsWith(".")) {
      return join(
        dirname(sourceFile),
        specifier.endsWith(".ts") ? specifier : `${specifier}.ts`,
      );
    }
    // Workspace-package re-export (cad-react `export * from "@slopcad/cad-core"`).
    const match = specifier.match(/^@slopcad\/([a-z-]+)$/);
    if (match !== null) {
      return join(ROOT, "packages", match[1], "src", "index.ts");
    }
    return null;
  };

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier?.text;
      if (specifier === undefined) continue;
      const target = resolveModule(specifier);
      if (target === null) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
      } else if (statement.exportClause === undefined) {
        // `export * from "..."` — recurse.
        names.push(...directExports(target, seen));
      }
    } else if (
      ts.canHaveModifiers(statement) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      // Inline exports in the barrel itself: export const/function/class/
      // interface/type/enum/namespace/declare.
      if (
        ts.isVariableStatement(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
      ) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              names.push(declaration.name.text);
            }
          }
        } else if (statement.name !== undefined) {
          names.push(statement.name.text);
        }
      }
    }
  }
  return names;
}

const results = {};
for (const name of PACKAGES) {
  const dir = name.replace("@slopcad/", "");
  const barrel = join(ROOT, "packages", dir, "src", "index.ts");
  const names = directExports(barrel, new Set());
  results[name] = [...new Set(names)].sort();
}

let drift = false;
for (const name of PACKAGES) {
  const count = results[name].length;
  const expected = EPOCH.counts[name];
  const marker =
    expected === 0 ? "recorded" : expected === count ? "ok" : "DRIFT";
  if (expected !== 0 && expected !== count) drift = true;
  console.log(`${name.padEnd(30)} ${String(count).padStart(4)}  ${marker}`);
}

// Machine-readable appendix for the audit document's epoch table.
if (!drift || process.argv.includes("--json")) {
  console.log(`\nepoch: ${EPOCH.epoch}`);
  for (const name of PACKAGES) {
    console.log(`${name}: ${results[name].length}`);
  }
}
if (drift && process.argv.includes("--check")) {
  console.error(
    "FAIL: barrel counts drifted from the recorded epoch — re-run the " +
      "audit and update docs/architecture/api-audit.md + this script's " +
      "EPOCH table together.",
  );
  process.exit(1);
}
