/**
 * The /docs documentation application's topic map (Phase 34): the 24
 * documented topics plus the package-boundaries guide, each with its
 * guide's repository path and the runnable example that proves it. One
 * source of truth for the sidebar navigation and the topic map table;
 * the guide files live under `docs/guides/` and the examples under
 * `packages/docs-examples/src/`.
 */

/** One documentation topic. */
export interface DocsTopic {
  /** The topic's stable id (matches the guide file name). */
  readonly id: string;
  /** The human title. */
  readonly title: string;
  /** One line saying what the topic covers. */
  readonly summary: string;
  /** The guide file's repository path. */
  readonly guide: string;
  /** The runnable example's repository path, when the topic has one. */
  readonly example: string | null;
}

/** One navigation group of topics. */
export interface DocsGroup {
  readonly id: string;
  readonly title: string;
  readonly topics: readonly DocsTopic[];
}

const core = "packages/docs-examples/src/core";
const kernel = "packages/docs-examples/src/kernel";
const io = "packages/docs-examples/src/io";
const sketch = "packages/docs-examples/src/sketch";
const components = "packages/docs-examples/src/components";

/** The documented topics, in reading order. */
export const DOCS_GROUPS: readonly DocsGroup[] = [
  {
    id: "foundations",
    title: "Foundations",
    topics: [
      {
        id: "installation",
        title: "Installation",
        summary:
          "Monorepo checkout, the verify gate, and the external-consumer registry install.",
        guide: "docs/guides/installation.md",
        example: null,
      },
      {
        id: "cad-core",
        title: "CAD core",
        summary:
          "The kernel-neutral document: bodies, parameters, features, ids, diagnostics.",
        guide: "docs/guides/cad-core.md",
        example: `${core}/document.ts`,
      },
      {
        id: "parameters",
        title: "Parameters",
        summary:
          "The parameter collection: creation, metadata, expressions, edits as commands.",
        guide: "docs/guides/parameters.md",
        example: `${core}/document.ts`,
      },
      {
        id: "expressions",
        title: "Expressions",
        summary:
          "The expression engine: AST, unit literals, functions, dependency extraction.",
        guide: "docs/guides/expressions.md",
        example: `${core}/document.ts`,
      },
      {
        id: "units",
        title: "Units",
        summary:
          "Dimensional values: length/angle/area/volume, conversion, dimensioned arithmetic.",
        guide: "docs/guides/units.md",
        example: `${core}/units.ts`,
      },
    ],
  },
  {
    id: "geometry",
    title: "Geometry",
    topics: [
      {
        id: "primitives",
        title: "Primitives",
        summary:
          "Box, sphere, cylinder, cone through the kernel contract, measured and tessellated.",
        guide: "docs/guides/primitives.md",
        example: `${kernel}/primitives.ts`,
      },
      {
        id: "booleans",
        title: "Booleans",
        summary:
          "Union, subtract, intersect: exact for mesh kernels, banded for the fake.",
        guide: "docs/guides/booleans.md",
        example: `${kernel}/primitives.ts`,
      },
      {
        id: "features",
        title: "Features",
        summary:
          "The feature graph, transactions, undo/redo, regeneration, rollback, suppression.",
        guide: "docs/guides/features.md",
        example: `${kernel}/features.ts`,
      },
      {
        id: "kernels",
        title: "Kernels",
        summary:
          "The pluggable kernel contract and the capability flags every backend declares.",
        guide: "docs/guides/kernels.md",
        example: `${kernel}/capabilities.ts`,
      },
      {
        id: "workers",
        title: "Workers",
        summary:
          "The versioned worker protocol: node channels, web workers, stale-result guards.",
        guide: "docs/guides/workers.md",
        example: `${kernel}/workers.ts`,
      },
    ],
  },
  {
    id: "rendering",
    title: "Rendering & interaction",
    topics: [
      {
        id: "r3f",
        title: "R3F",
        summary:
          "The renderer-neutral projection and the React Three Fiber scene that consumes it.",
        guide: "docs/guides/r3f.md",
        example: `${core}/projection.ts`,
      },
      {
        id: "selection",
        title: "Selection",
        summary:
          "Selection state, pick modes, synthetic faces, persistent topology references.",
        guide: "docs/guides/selection.md",
        example: `${core}/projection.ts`,
      },
      {
        id: "tools",
        title: "Tools",
        summary:
          "The headless tool system: runtime, manager, registry, inspection tools.",
        guide: "docs/guides/tools.md",
        example: `${core}/custom-tool.ts`,
      },
      {
        id: "ui",
        title: "UI",
        summary:
          "The @slopcad/ui CAD components and their installation through the registry.",
        guide: "docs/guides/ui.md",
        example: null,
      },
    ],
  },
  {
    id: "exchange",
    title: "Data exchange",
    topics: [
      {
        id: "native-files",
        title: "Native files",
        summary:
          "The one format that preserves parametric history: dual-persisted, replay-checked.",
        guide: "docs/guides/native-files.md",
        example: `${core}/native.ts`,
      },
      {
        id: "mesh-exchange",
        title: "STL / 3MF / GLB",
        summary:
          "The cad-io mesh adapters: deterministic bytes, one file per solid, GLB scenes.",
        guide: "docs/guides/mesh-exchange.md",
        example: `${io}/mesh.ts`,
      },
      {
        id: "step-iges",
        title: "STEP / IGES",
        summary:
          "The OpenCascade exchange paths: exact BREP solids in, geometry-only provenance out.",
        guide: "docs/guides/step-iges.md",
        example: `${kernel}/occt.ts`,
      },
    ],
  },
  {
    id: "sketching",
    title: "Sketching",
    topics: [
      {
        id: "sketches",
        title: "Sketches",
        summary:
          "Workplanes, entities, serialization, profile resolution for extrusion.",
        guide: "docs/guides/sketches.md",
        example: `${sketch}/sketch.ts`,
      },
      {
        id: "constraints",
        title: "Constraints",
        summary:
          "The constraint vocabulary and the deterministic reference solver.",
        guide: "docs/guides/constraints.md",
        example: `${sketch}/sketch.ts`,
      },
    ],
  },
  {
    id: "distribution",
    title: "Distribution",
    topics: [
      {
        id: "registry",
        title: "Registry",
        summary:
          "The Phase 33 registry model: three source registries, byte-reproducible artifacts.",
        guide: "docs/guides/registry.md",
        example: null,
      },
      {
        id: "components",
        title: "Reusable components",
        summary:
          "The component contract, the execution surfaces, and the shipped three.",
        guide: "docs/guides/components.md",
        example: `${components}/components.ts`,
      },
      {
        id: "custom-tools",
        title: "Custom tools",
        summary:
          "Writing a tool: state, reducer, registry entry, manager lifecycle.",
        guide: "docs/guides/custom-tools.md",
        example: `${core}/custom-tool.ts`,
      },
      {
        id: "custom-kernels",
        title: "Custom kernel adapters",
        summary:
          "Implementing the kernel contract; the shared suite judges any backend.",
        guide: "docs/guides/custom-kernels.md",
        example: `${kernel}/custom-adapter.ts`,
      },
    ],
  },
  {
    id: "engineering",
    title: "Engineering",
    topics: [
      {
        id: "testing",
        title: "Testing",
        summary:
          "The contract suite, semantic assertions, in-memory database, e2e harnesses.",
        guide: "docs/guides/testing.md",
        example: "packages/docs-examples/src/contract-suite.test.ts",
      },
      {
        id: "package-boundaries",
        title: "Package boundaries",
        summary:
          "What may import what: the allowed-import map and its enforcement.",
        guide: "docs/guides/package-boundaries.md",
        example: null,
      },
    ],
  },
];

/** Every topic, flattened. */
export const ALL_TOPICS: readonly DocsTopic[] = DOCS_GROUPS.flatMap(
  (group) => group.topics,
);
