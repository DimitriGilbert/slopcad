/**
 * STEP file import at the OpenCascade boundary (Phase 21.3): raw file bytes
 * → extracted BREP solids, one per `TopAbs_SOLID` in the file's transferred
 * model, through `STEPControl_Reader` over the emscripten virtual
 * filesystem. The kernel layer (`./occt-kernel`) wraps the extracted shapes
 * into kernel-neutral solids; everything OCCT-specific about STEP *reading*
 * lives here.
 *
 * ## Metadata scope (the pre-spike boundary, stated explicitly)
 *
 * What import preserves is GEOMETRY and UNITS: each imported solid is real
 * BREP (faces, edges, vertices — the Phase 22 topology surface works on it
 * unchanged), in canonical millimetres. What import does NOT preserve is
 * product-level NAME and COLOR metadata: reading those requires the XCAF
 * document layer (`STEPCAFControl_Reader`), and the `STEPCAFControl_*`
 * classes are NOT BOUND in this build — the strings exist in the WASM but
 * no class is callable (docs/architecture/occt-prespike-findings.md §5,
 * probed against the shipped d.ts). The plan's "preserve supported …
 * name/color metadata" is therefore scoped to what the binding supports:
 * body/topology and units. Names/colors wait on an upstream binding request.
 *
 * ## Units (verified behaviorally against the binding)
 *
 * The STEP format declares a file unit; OCCT's translator converts file
 * coordinates to the reader's "system length unit" during transfer, which
 * defaults to the millimetre position (probed: `SystemLengthUnit()` reads 1
 * on a fresh reader). Verified end-to-end: a plate written with
 * `write.step.unit = INCH` imports with the SAME millimetre volume and
 * bounds as its mm-written twin (agreement ~1e-12 relative, pinned by a
 * test in `./occt-step-import.test.ts`) — canonicalization to mm is the
 * binding's actual behavior, not an assumption. The file's declared unit
 * NAME is not retrievable: `FileUnits()` is bound in the d.ts but its
 * `NCollection_Sequence` argument type cannot be constructed (`NCollection
 * _BaseSequence` is an unbound dependency — probed), so this module reports
 * canonical mm and nothing else. Like 3MF (cad-io), imported geometry is
 * canonical millimetres by construction.
 *
 * ## No parametric history fabrication
 *
 * A STEP file carries BREP geometry and (XCAF-only, hence unreachable)
 * product metadata — never features, parameters, or construction history.
 * This module extracts shapes and nothing else; no document, feature, or
 * parameter machinery is imported or invented anywhere behind it. The
 * provenance distinction is carried in DATA by the kernel layer's result
 * type (`ImportedStepSolid.origin` is the literal `"imported-step"`), so a
 * consumer can always tell an imported geometry-only solid from a
 * feature-built one without inspecting the kernel.
 *
 * ## Bytes, text, and the virtual filesystem
 *
 * The reader takes a path, not bytes, so the input is written to a unique
 * `/slopcad-step-import-<n>.step` path in the emscripten MEMFS and unlinked
 * in a `finally` — no temp file survives any outcome. Before OCCT sees
 * anything, the bytes are classified structurally: empty → `empty`; not
 * decodable text or missing the `ISO-10303-21;` header → `malformed`;
 * ISO-header text the reader then rejects (`IFSelect_RetFail`, zero roots)
 * → `truncated` — the honest split between "not STEP at all" and "STEP
 * text that ends prematurely or parses invalid", both verified against the
 * binding (garbage, empty, and truncated files all return `RetFail` with
 * zero roots and never throw).
 *
 * ## Binding stdout (documented, not a hazard)
 *
 * OCCT prints its own transfer statistics and parse errors ("**** ERR
 * StepFile …") to the console through its internal message printer; the
 * classes for muting printers are not bound in this build. The noise is the
 * binding's documented stdout — worker code neither depends on it nor
 * suppresses it.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";

/** Stable failure codes produced when STEP import rejects its input. */
export const STEP_IMPORT_ERROR_CODES = {
  /** Zero-byte input — there is no file to import. */
  empty: "step-import/empty",
  /**
   * Bytes that are not ISO-10303-21 STEP text at all: undecodable bytes, or
   * decodable text missing the `ISO-10303-21;` header.
   */
  malformed: "step-import/malformed",
  /**
   * ISO-10303-21 text the STEP reader rejected (parse failure, zero roots):
   * a truncated data section or syntactically invalid STEP content.
   */
  truncated: "step-import/truncated",
  /**
   * Syntactically accepted STEP that transferred to zero shapes, or
   * transferred geometry containing no solid (shells/points/curves only) —
   * this importer's scope is solids, so there is nothing to import.
   */
  noSolids: "step-import/no-solids",
  /**
   * The reader returned a non-parse transport-level status for the file it
   * was handed (e.g. `IFSelect_RetError`), which the MEMFS round trip makes
   * an internal-condition failure rather than a defect of the bytes.
   */
  readerError: "step-import/reader-error",
  /** The binding threw inside the import boundary. */
  kernelFailure: "step-import/kernel-failure",
} as const;

export type StepImportErrorCode =
  (typeof STEP_IMPORT_ERROR_CODES)[keyof typeof STEP_IMPORT_ERROR_CODES];

/** Structured failure describing why STEP import rejected some bytes. */
export interface StepImportError extends ParseFailure {
  readonly code: StepImportErrorCode;
}

/**
 * The extracted result of a successful STEP read: one shape per
 * `TopAbs_SOLID`, in file order. The shapes are owned copies — they
 * outlive the reader and the virtual file (probed: reference-counted
 * TShapes survive reader teardown and file removal), and the kernel layer
 * takes responsibility for deleting them on dispose.
 */
export interface OcctStepImport {
  readonly shapes: readonly TopoDS_Shape[];
}

function stepError(
  code: StepImportErrorCode,
  message: string,
  bytes: Uint8Array,
): StepImportError {
  return { code, message, input: bytes };
}

/** MEMFS path counter: unique per import, deterministic per context. */
let memfsPathCounter = 0;

/**
 * Whether `text` opens like a Part 21 file — every ISO-10303-21 file's
 * first bytes are the `ISO-10303-21;` keyword (an optional byte-order mark
 * and whitespace tolerated for the structural gate only; the reader does
 * its own grammar judgement on the raw bytes).
 */
function opensLikeStep(text: string): boolean {
  return /^\uFEFF?\s*ISO-10303-21\s*;/.test(text);
}

/**
 * Extracts one `TopAbs_SOLID` per solid from the transferred model's one
 * shape, in exploration order. Deleting the compound wrapper and explorer
 * afterwards frees only the wrapper handles — the extracted solids are
 * independent, reference-counted copies (probed).
 */
function extractSolids(
  oc: OpenCascadeInstance,
  oneShape: TopoDS_Shape,
): TopoDS_Shape[] {
  const solids: TopoDS_Shape[] = [];
  const explorer = new oc.TopExp_Explorer(
    oneShape,
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
 * Imports `bytes` as a STEP file into extracted BREP solids — one per solid
 * in the file's transferred model, canonical millimetres, geometry only.
 * Deterministic, and total: any byte input either imports or fails with a
 * structured `step-import/*` code — never a throw. The virtual file the
 * reader consumes is unlinked on every path; nothing leaks.
 */
export function importStepShapes(
  oc: OpenCascadeInstance,
  bytes: Uint8Array,
): ParseResult<OcctStepImport, StepImportError> {
  if (bytes.byteLength === 0) {
    return fail(
      stepError(
        STEP_IMPORT_ERROR_CODES.empty,
        "The input is empty (0 bytes); there is no STEP file to import.",
        bytes,
      ),
    );
  }
  // Structural text gate, before OCCT sees anything: STEP Part 21 is text.
  // Decoding is lenient here only to CLASSIFY — replacement characters mean
  // the bytes are not text, i.e. not STEP; the reader still receives the
  // original bytes verbatim.
  const decoded = new TextDecoder("utf-8").decode(bytes);
  if (!opensLikeStep(decoded)) {
    return fail(
      stepError(
        STEP_IMPORT_ERROR_CODES.malformed,
        decoded.includes("\uFFFD")
          ? "The input is not decodable text, so it cannot be ISO-10303-21 STEP data."
          : "The input does not open with the ISO-10303-21 header, so it is not a STEP Part 21 file.",
        bytes,
      ),
    );
  }

  const memfsPath = `/slopcad-step-import-${(memfsPathCounter += 1)}.step`;
  const reader = new oc.STEPControl_Reader();
  try {
    try {
      oc.FS.writeFile(memfsPath, bytes);
      const status = reader.ReadFile(memfsPath);
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
        // Probed classification: garbage, empty, and truncated ISO text all
        // land on RetFail with zero roots and no exception. RetError (and
        // the never-observed RetVoid/RetStop) name reader-level failures of
        // the just-written virtual file — an internal condition, not a
        // verdict on the bytes.
        if (status === oc.IFSelect_ReturnStatus.IFSelect_RetFail) {
          return fail(
            stepError(
              STEP_IMPORT_ERROR_CODES.truncated,
              "The STEP text was rejected by the OCCT reader (parse failure with no transferable roots); the data section is typically truncated or syntactically invalid.",
              bytes,
            ),
          );
        }
        return fail(
          stepError(
            STEP_IMPORT_ERROR_CODES.readerError,
            `The OCCT STEP reader could not read the file: ${String(status)}.`,
            bytes,
          ),
        );
      }
      reader.TransferRoots();
      if (reader.NbShapes() === 0) {
        return fail(
          stepError(
            STEP_IMPORT_ERROR_CODES.noSolids,
            "The STEP file transferred to zero shapes; there is no geometry to import.",
            bytes,
          ),
        );
      }
      const oneShape = reader.OneShape();
      if (oneShape.IsNull()) {
        return fail(
          stepError(
            STEP_IMPORT_ERROR_CODES.noSolids,
            "The STEP file transferred no shape; there is no geometry to import.",
            bytes,
          ),
        );
      }
      const solids = extractSolids(oc, oneShape);
      oneShape.delete();
      if (solids.length === 0) {
        return fail(
          stepError(
            STEP_IMPORT_ERROR_CODES.noSolids,
            "The STEP file carries no solid (shells, wires, points, or curves only); this importer imports solids.",
            bytes,
          ),
        );
      }
      return ok({ shapes: solids });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(
        stepError(
          STEP_IMPORT_ERROR_CODES.kernelFailure,
          `STEP import failed inside the OpenCascade boundary: ${detail}`,
          bytes,
        ),
      );
    } finally {
      // Reader teardown after every outcome: the extracted solids keep the
      // shared TShapes alive (reference-counted, probed), so releasing the
      // reader's own transferred-shape list is safe.
      try {
        reader.ClearShapes();
      } finally {
        reader.delete();
      }
    }
  } finally {
    // The virtual file is removed on every path — no MEMFS leakage.
    try {
      oc.FS.unlink(memfsPath);
    } catch {
      // The write itself failed, or OCCT removed the path — nothing to
      // clean; the import's own outcome stands.
    }
  }
}
