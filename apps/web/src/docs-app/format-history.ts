/**
 * The /docs page's exchange-format facts (Phase 34): which formats carry
 * parametric history and which are geometry-only, grounded in the IO and
 * native-format implementations. Every row cites the code that decides
 * it — the table is the guide's claim, the source is the proof.
 */

/** One row of the format-history table. */
export interface FormatRow {
  /** The format's display name. */
  readonly format: string;
  /** Which directions the repo implements. */
  readonly direction: "save / open" | "export / import" | "export" | "import";
  /** What a file of this format carries out of the repo. */
  readonly carries: string;
  /** Whether reopening it restores the parametric model. */
  readonly history: boolean;
  /** The deciding implementation. */
  readonly source: string;
}

/** The formats, native first. */
export const FORMAT_ROWS: readonly FormatRow[] = [
  {
    format: "Native slopcad document",
    direction: "save / open",
    carries:
      "Parameters with expressions, feature graph, bodies, the full transaction log (undo/redo reach), regeneration states, rollback marker",
    history: true,
    source: "packages/cad-core/src/native-format.ts",
  },
  {
    format: "STEP (AP214IS / AP203 / AP242DIS)",
    direction: "export / import",
    carries:
      'BREP solids in canonical millimetres; import mints provenance-marked solids (origin "imported-step")',
    history: false,
    source:
      "packages/cad-kernel-occt/src/occt-step-export.ts, occt-step-import.ts",
  },
  {
    format: "OCCT BREP",
    direction: "export / import",
    carries: 'BREP solids; import provenance "imported-brep"',
    history: false,
    source: "packages/cad-kernel-occt/src/occt-brep.ts",
  },
  {
    format: "IGES",
    direction: "import",
    carries:
      "Meshes only (the occt-import-js fallback reads tessellations, never BREP solids) — the same class of body an STL import produces",
    history: false,
    source: "packages/cad-kernel-occt/src/occt-iges-import.ts",
  },
  {
    format: "STL (binary)",
    direction: "export / import",
    carries:
      "One triangle soup per solid, canonical millimetres, no part structure",
    history: false,
    source: "packages/cad-io/src/stl-export.ts, stl-import.ts",
  },
  {
    format: "3MF",
    direction: "export / import",
    carries:
      "Mesh + well-known metadata (Title/Designer/Description) + declared unit; import is Node-targeted (node:zlib)",
    history: false,
    source: "packages/cad-io/src/three-mf-export.ts, three-mf-import.ts",
  },
  {
    format: "GLB (glTF 2.0)",
    direction: "export",
    carries:
      "The render projection: one named node per render object, POSITION/NORMAL accessors, the CadScene material",
    history: false,
    source: "packages/cad-io/src/glb-export.ts",
  },
];
