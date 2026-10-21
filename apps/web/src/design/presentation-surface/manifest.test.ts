import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractSurfaceAttributes } from "./attributes";
import {
  buildPresentationSurfaceManifest,
  CHECKLIST_FILE,
  diffManifests,
  MANIFEST_FILE,
  readManifestSnapshot,
  repoRoot,
  serializeManifest,
} from "./manifest";
import { extractRoutes } from "./routes";
import { extractWebMcpTools } from "./webmcp";

const root = repoRoot();

const REGENERATE =
  "The presentation surface moved. If that was deliberate, run\n" +
  "    pnpm run surface:manifest\n" +
  "and COMMIT the regenerated snapshot so the diff is reviewable. If it was\n" +
  "not deliberate, restore the handle (aria-label / data-testid / data-* state)\n" +
  "the redesign dropped — the e2e fleet and assistive tech read it.";

describe("the presentation-surface guard", () => {
  const built = buildPresentationSurfaceManifest(root);

  it("matches the committed snapshot", () => {
    const committed = readManifestSnapshot(root);
    const drift = diffManifests(committed, built);
    expect(drift.join("\n"), `${REGENERATE}\n\ndrift:`).toBe("");
  });

  it("stores the snapshot in the serialization the generator writes", () => {
    // Byte equality: the snapshot is `JSON.stringify(…, null, 2)` + newline.
    // Prettier is told to leave the file alone (`.prettierignore`, same
    // rationale as the other generated artifacts), so THIS is the only thing
    // keeping a hand-edit from drifting the bytes the CLI would write.
    expect(readFileSync(join(root, MANIFEST_FILE), "utf8")).toBe(
      serializeManifest(readManifestSnapshot(root)),
    );
  });

  it("covers a non-trivial surface", () => {
    // A guard that silently extracts nothing would pass forever. Floors, not
    // ceilings: they only ever rise, and only by a deliberate edit here.
    expect(built.routes.length).toBeGreaterThanOrEqual(33);
    expect(built.webmcpTools.length).toBeGreaterThanOrEqual(22);
    const testIds = built.attributes.find(
      (entry) => entry.attribute === "data-testid" && entry.origin === "jsx",
    );
    expect(testIds?.values.length ?? 0).toBeGreaterThanOrEqual(240);
    const ariaLabels = built.attributes.find(
      (entry) => entry.attribute === "aria-label" && entry.origin === "jsx",
    );
    expect(ariaLabels?.values.length ?? 0).toBeGreaterThanOrEqual(90);
  });

  it("cross-checks the command-surface checklist's routes read-only", () => {
    // The checklist (command ids, e2e-owned) is NOT ours to edit; we only
    // verify every route it points a capability at still exists.
    const checklist = JSON.parse(
      readFileSync(join(root, CHECKLIST_FILE), "utf8"),
    ) as {
      entries?: readonly { readonly id: string; readonly route: string }[];
    };
    const routes = new Set(built.routes.map((route) => route.fullPath));
    const missing = (checklist.entries ?? [])
      .filter((entry) => !routes.has(entry.route))
      .map((entry) => `${entry.id} -> ${entry.route}`);
    expect(missing).toEqual([]);
  });
});

describe("the attribute extractor", () => {
  it("reads literals, boolean shorthand, and conditional state pairs", () => {
    const occurrences = extractSurfaceAttributes(
      "sample.tsx",
      `const view = (
         <div
           aria-label="Undo"
           role="toolbar"
           data-open
           data-state={open ? "open" : "closed"}
           data-count={2}
         />
       );`,
    );
    expect(occurrences).toEqual([
      {
        attribute: "aria-label",
        origin: "jsx",
        values: ["Undo"],
        dynamic: false,
      },
      { attribute: "data-count", origin: "jsx", values: ["2"], dynamic: false },
      {
        attribute: "data-open",
        origin: "jsx",
        values: ["true"],
        dynamic: false,
      },
      {
        attribute: "data-state",
        origin: "jsx",
        values: ["closed", "open"],
        dynamic: false,
      },
      { attribute: "role", origin: "jsx", values: ["toolbar"], dynamic: false },
    ]);
  });

  it("marks computed values dynamic instead of inventing one", () => {
    const [occurrence] = extractSurfaceAttributes(
      "sample.tsx",
      "const view = <li data-testid={`row-${id}`} aria-label={label(name)} />;",
    );
    expect(occurrence).toEqual({
      attribute: "aria-label",
      origin: "jsx",
      values: [],
      dynamic: true,
    });
  });

  it("never harvests a string buried in a call argument", () => {
    const occurrences = extractSurfaceAttributes(
      "sample.tsx",
      'const view = <div data-label={translate("settings.title")} />;',
    );
    expect(occurrences).toEqual([
      { attribute: "data-label", origin: "jsx", values: [], dynamic: true },
    ]);
  });

  it("records imperative DOM writes separately from JSX", () => {
    const occurrences = extractSurfaceAttributes(
      "sample.ts",
      'root.setAttribute("data-settled", String(n));\n' +
        'root.setAttribute("data-phase", "ready");\n' +
        'root.getAttribute("data-ignored");',
    );
    expect(occurrences).toEqual([
      {
        attribute: "data-phase",
        origin: "setAttribute",
        values: ["ready"],
        dynamic: false,
      },
      {
        attribute: "data-settled",
        origin: "setAttribute",
        values: [],
        dynamic: true,
      },
    ]);
  });

  it("ignores styling attributes and JSX spreads", () => {
    expect(
      extractSurfaceAttributes(
        "sample.tsx",
        'const view = <div className="grid" title="t" {...rest} />;',
      ),
    ).toEqual([]);
  });
});

describe("the route extractor", () => {
  it("reads id, path, fullPath and module from the generated tree", () => {
    const routes = extractRoutes(
      `import { Route as DocsRouteImport } from './routes/docs'
       declare module '@tanstack/react-router' {
         interface FileRoutesByPath {
           '/docs': {
             id: '/docs'
             path: '/docs'
             fullPath: '/docs'
             preLoaderRoute: typeof DocsRouteImport
             parentRoute: typeof rootRouteImport
           }
         }
       }`,
    );
    expect(routes).toEqual([
      { id: "/docs", path: "/docs", fullPath: "/docs", module: "routes/docs" },
    ]);
  });
});

describe("the WebMCP extractor", () => {
  it("reads tool names and the read-only hint", () => {
    expect(
      extractWebMcpTools(
        "tools.ts",
        `const tools = [
           defineWebMcpTool({
             annotations: { readOnlyHint: true },
             description: "d",
             inputSchema: z.object({}),
             name: "cad_get_document",
             execute: () => ({ ok: true }),
           }),
           defineWebMcpTool({
             description: "d",
             inputSchema: z.object({}),
             name: "cad_undo",
             execute: () => ({ ok: true }),
           }),
         ];`,
      ),
    ).toEqual([
      { name: "cad_get_document", readOnly: true },
      { name: "cad_undo", readOnly: false },
    ]);
  });
});
