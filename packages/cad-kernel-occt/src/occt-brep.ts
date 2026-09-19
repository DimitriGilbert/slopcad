/**
 * Native BREP exchange at the OpenCascade boundary (Phase 21.5): owned BREP
 * shapes → one OCCT ASCII BREP file, and raw BREP file bytes → extracted
 * BREP solids, through the binding's string-based `BRepToolsWrapper`
 * (`Write(shape): string` / `Read(string): TopoDS_Shape`). The kernel layer
 * (`./occt-kernel`) wraps extracted shapes into kernel-neutral solids and
 * resolves its handles back into shapes; everything OCCT-specific about BREP
 * exchange lives here.
 *
 * ## Why the string form is the proven path (probed, pre-spike §5)
 *
 * File-based `BRepTools.Read` is NOT callable in this build (its
 * `BRep_Builder&` parameter is unbound and the binding's own overload-error
 * path crashes), while the string wrapper round-trips exactly — replicad
 * ships it precisely to serialize shapes across its own worker boundary.
 * A direct consequence: BREP exchange touches the emscripten virtual
 * filesystem NOT AT ALL — there is no temp file to write, read, or leak on
 * any path (the STEP codec's unlink discipline has no work here), and the
 * malformed-input matrix cannot leave filesystem state behind by
 * construction.
 *
 * ## What the string contains (probed)
 *
 * Pure ASCII (zero non-ASCII bytes across every probe), opening with a
 * leading newline and the `CASCADE Topology V3, (c) Open Cascade` header,
 * then the location/curve/surface tables and the TShape section. It is
 * GEOMETRY ONLY — no timestamps, no counters, no product names, no wall
 * clock anywhere (probed: no date-shaped text in any output; the format has
 * no header field that carries one).
 *
 * ## Determinism (probed — and why there is no neutralizer)
 *
 * Unlike the STEP writer (whose FILE_NAME timestamp and process-global
 * product counter must be neutralized — see `./occt-step-export`), the BREP
 * writer's output was measured deterministic at EVERY site: the same shape
 * written twice in one process — including with unrelated exports
 * interleaved — is byte-identical, and two INDEPENDENT PROCESSES produce
 * byte-identical files (probed with `cmp` on the plate-with-hole). The
 * export therefore performs NO post-processing of the writer's string:
 * there is nothing to neutralize, and the cross-process pin is the test
 * comparing this suite's export against the committed fixture (written by
 * a different process of the same binding).
 *
 * ## Single shape vs compound (the multi-shape decision)
 *
 * An OCCT BREP file canonically carries ONE shape — `Write` takes a single
 * `TopoDS_Shape` and OCCT's own tooling writes one shape per file. This
 * adapter exports exactly that way: one solid writes itself; two or more
 * solids are carried in a `TopoDS_Compound` built with `TopoDS_Builder`
 * (`MakeCompound` + `Add`, both bound in this build) — the format's own
 * multi-shape container. Reader-side, extraction explores
 * `TopAbs_SOLID` from whatever the reader returned (the reader hands back
 * a top-level compound even for a written SOLID — probed), which resolves
 * single-shape and compound files symmetrically with the STEP importer's
 * `OneShape` handling, preserving file order (probed).
 *
 * ## Round-trip fidelity (probed on the plate-with-hole)
 *
 * The ASCII decimal text re-parses to last-ulp-rounded doubles: volume
 * relative error 3.3e-16 (inside the contract suite's 1e-9 exact band),
 * `BRepBndLib.AddOptimal` bounds exactly equal, and face/edge/vertex
 * counts identical (7/30/60) — the string form loses nothing measurable.
 *
 * ## Malformed bytes (probed: total, never a throw)
 *
 * `Read` rejects every malformed input by returning a NULL shape
 * (`IsNull() === true`) — empty string, garbage text, header-only text,
 * truncated valid text, and binary junk were all probed; none throws. The
 * honest split mirrors the STEP taxonomy: empty input → `empty`; bytes
 * that are not decodable text or do not open with the `CASCADE Topology`
 * header → `malformed`; header-shaped text the reader rejected (the null
 * shape) → `truncated`; a parse that yields no solid → `no-solids`. The
 * reader prints its own diagnostics ("Not a TShape table", …) to the
 * console through OCCT's message printer — the binding's documented
 * stdout, neither depended on nor suppressed (same stance as STEP).
 *
 * ## No parametric history fabrication
 *
 * A BREP file carries geometry and nothing else. The kernel layer's result
 * type marks that in DATA (`ImportedBrepSolid.origin` is the literal
 * `"imported-brep"`), exactly like the STEP import's provenance literal.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";

/**
 * Stable failure codes produced when BREP export rejects its input. There is
 * no `nondeterministic` code because there is no neutralizer — see the
 * module doc's determinism section.
 */
export const BREP_EXPORT_ERROR_CODES = {
  /** Zero solids — there is no geometry to export. */
  empty: "brep-export/empty",
  /**
   * The writer returned an empty string — no observable failure status
   * exists on the string API, so an empty output is refused rather than
   * shipped as a success.
   */
  writeFailed: "brep-export/write-failed",
  /** The binding threw inside the export boundary. */
  kernelFailure: "brep-export/kernel-failure",
} as const;

export type BrepExportErrorCode =
  (typeof BREP_EXPORT_ERROR_CODES)[keyof typeof BREP_EXPORT_ERROR_CODES];

/** Structured failure describing why BREP export rejected its input. */
export interface BrepExportError extends ParseFailure {
  readonly code: BrepExportErrorCode;
}

/** Stable failure codes produced when BREP import rejects its input. */
export const BREP_IMPORT_ERROR_CODES = {
  /** Zero-byte input — there is no file to import. */
  empty: "brep-import/empty",
  /**
   * Bytes that are not OCCT BREP text at all: undecodable bytes, or
   * decodable text missing the `CASCADE Topology` header.
   */
  malformed: "brep-import/malformed",
  /**
   * Header-shaped text the BREP reader rejected (the null shape): a
   * truncated table section or otherwise invalid BREP content.
   */
  truncated: "brep-import/truncated",
  /**
   * Parsed BREP containing no solid (shells/wires/vertices only) — this
   * importer's scope is solids, so there is nothing to import.
   */
  noSolids: "brep-import/no-solids",
  /** The binding threw inside the import boundary. */
  kernelFailure: "brep-import/kernel-failure",
} as const;

export type BrepImportErrorCode =
  (typeof BREP_IMPORT_ERROR_CODES)[keyof typeof BREP_IMPORT_ERROR_CODES];

/** Structured failure describing why BREP import rejected some bytes. */
export interface BrepImportError extends ParseFailure {
  readonly code: BrepImportErrorCode;
}

/**
 * The extracted result of a successful BREP read: one shape per
 * `TopAbs_SOLID` in the file, in file order. The shapes are owned copies —
 * they outlive the reader's returned top-level shape (reference-counted
 * TShapes, the same mechanics the STEP importer's extraction relies on) —
 * and the kernel layer takes responsibility for deleting them on dispose.
 */
export interface OcctBrepImport {
  readonly shapes: readonly TopoDS_Shape[];
}

function brepImportError(
  code: BrepImportErrorCode,
  message: string,
  bytes: Uint8Array,
): BrepImportError {
  return { code, message, input: bytes };
}

function brepExportError(
  code: BrepExportErrorCode,
  message: string,
): BrepExportError {
  return { code, message, input: null };
}

/**
 * Whether `text` opens like an OCCT BREP file — every `BRepTools` ASCII
 * file's first non-blank bytes are the `CASCADE Topology V<n>,` header
 * (the writer's own leading blank line tolerated for the structural gate
 * only; the reader makes its own grammar judgement on the text).
 */
function opensLikeBrep(text: string): boolean {
  return /^\uFEFF?\s*CASCADE Topology V\d+,/.test(text);
}

/**
 * Extracts one `TopAbs_SOLID` per solid from the reader's returned shape,
 * in exploration order. Deleting the top-level shape and explorer
 * afterwards frees only the wrapper handles — the extracted solids are
 * independent, reference-counted copies (the STEP extractor's discipline).
 */
function extractSolids(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): TopoDS_Shape[] {
  const solids: TopoDS_Shape[] = [];
  const explorer = new oc.TopExp_Explorer(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
  );
  while (explorer.More()) {
    solids.push(explorer.Value());
    explorer.Next();
  }
  explorer.delete();
  return solids;
}

/**
 * Writes one already-built carrier shape into a BREP file's bytes, refusing
 * an empty writer output (no observable failure status exists on the string
 * API, so an empty output is rejected rather than shipped as a success).
 */
function writeBrepFile(
  oc: OpenCascadeInstance,
  carrier: TopoDS_Shape,
): ParseResult<Uint8Array, BrepExportError> {
  const text = oc.BRepToolsWrapper.Write(carrier);
  if (text === "") {
    return fail(
      brepExportError(
        BREP_EXPORT_ERROR_CODES.writeFailed,
        "The OCCT BREP writer produced an empty string; refusing to ship it as a file.",
      ),
    );
  }
  // Pure ASCII (probed) — UTF-8 encoding is byte-exact for it.
  return ok(new TextEncoder().encode(text));
}

/**
 * Exports `shapes` — one or more owned BREP shapes — into ONE deterministic
 * OCCT ASCII BREP file's bytes: a single shape writes itself (the format's
 * canonical single-shape form), two or more ride inside a `TopoDS_Compound`
 * (see the module doc's multi-shape decision). Total: any input either
 * exports or fails with a structured `brep-export/*` code — never a throw —
 * and no filesystem state is touched on any path (the string API bypasses
 * the virtual filesystem entirely). The compound's deleting span opens
 * immediately after its allocation, so the whole build (`MakeCompound`,
 * `Add`) and the write run inside it: a binding throw anywhere in the span
 * deletes the wrapper on the way out (delete-on-partially-built is safe —
 * OCCT shapes are reference-counted handles and the input shapes are
 * caller-owned) instead of leaking it past the outer catch.
 */
export function exportBrepShapes(
  oc: OpenCascadeInstance,
  shapes: readonly TopoDS_Shape[],
): ParseResult<Uint8Array, BrepExportError> {
  if (shapes.length === 0) {
    return fail(
      brepExportError(
        BREP_EXPORT_ERROR_CODES.empty,
        "The export received zero solids; there is no geometry to export.",
      ),
    );
  }
  try {
    if (shapes.length === 1) {
      const only = shapes[0];
      if (only === undefined) {
        throw new Error(
          "Invariant violation: a non-empty shape list is dense.",
        );
      }
      return writeBrepFile(oc, only);
    }
    const compound = new oc.TopoDS_Compound();
    try {
      const builder = new oc.TopoDS_Builder();
      try {
        builder.MakeCompound(compound);
        for (const shape of shapes) {
          builder.Add(compound, shape);
        }
      } finally {
        builder.delete();
      }
      return writeBrepFile(oc, compound);
    } finally {
      compound.delete();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      brepExportError(
        BREP_EXPORT_ERROR_CODES.kernelFailure,
        `BREP export failed inside the OpenCascade boundary: ${detail}`,
      ),
    );
  }
}

/**
 * Imports `bytes` as an OCCT ASCII BREP file into extracted BREP solids —
 * one per `TopAbs_SOLID` in the file, in file order, geometry only.
 * Deterministic and total: any byte input either imports or fails with a
 * structured `brep-import/*` code — never a throw — with no filesystem
 * state involved on any path.
 */
export function importBrepShapes(
  oc: OpenCascadeInstance,
  bytes: Uint8Array,
): ParseResult<OcctBrepImport, BrepImportError> {
  if (bytes.byteLength === 0) {
    return fail(
      brepImportError(
        BREP_IMPORT_ERROR_CODES.empty,
        "The input is empty (0 bytes); there is no BREP file to import.",
        bytes,
      ),
    );
  }
  // Structural text gate, before OCCT sees anything: the BREP ASCII form is
  // text. Decoding is lenient here only to CLASSIFY — replacement characters
  // mean the bytes are not text, i.e. not BREP; the reader still receives
  // the decoded text verbatim (the string API takes text, not bytes).
  const decoded = new TextDecoder("utf-8").decode(bytes);
  if (!opensLikeBrep(decoded)) {
    return fail(
      brepImportError(
        BREP_IMPORT_ERROR_CODES.malformed,
        decoded.includes("\uFFFD")
          ? "The input is not decodable text, so it cannot be OCCT BREP data."
          : "The input does not open with the CASCADE Topology header, so it is not an OCCT BREP file.",
        bytes,
      ),
    );
  }
  try {
    const shape = oc.BRepToolsWrapper.Read(decoded);
    try {
      // The reader's total rejection signature (probed): a NULL shape for
      // every malformed input — truncated tables, header-only text — with
      // no exception. A parse that returns a non-null shape is accepted.
      if (shape.IsNull()) {
        return fail(
          brepImportError(
            BREP_IMPORT_ERROR_CODES.truncated,
            "The BREP text was rejected by the OCCT reader (a null shape); the table sections are typically truncated or invalid.",
            bytes,
          ),
        );
      }
      const solids = extractSolids(oc, shape);
      if (solids.length === 0) {
        return fail(
          brepImportError(
            BREP_IMPORT_ERROR_CODES.noSolids,
            "The BREP file carries no solid (shells, wires, or vertices only); this importer imports solids.",
            bytes,
          ),
        );
      }
      return ok({ shapes: solids });
    } finally {
      // The extracted solids keep their shared TShapes alive
      // (reference-counted); releasing the reader's wrapper is safe.
      shape.delete();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      brepImportError(
        BREP_IMPORT_ERROR_CODES.kernelFailure,
        `BREP import failed inside the OpenCascade boundary: ${detail}`,
        bytes,
      ),
    );
  }
}
