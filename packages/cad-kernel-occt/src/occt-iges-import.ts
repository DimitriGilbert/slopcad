/**
 * IGES import (Phase 21.5) — the plan-sanctioned dormant fallback, executed.
 * The plan's binding decision left IGES to `occt-import-js` "as an
 * import-only fallback at most" because the primary binding
 * (`replicad-opencascadejs`) ships ZERO callable IGES classes — the
 * `IGESControl_*` strings exist in its wasm only inside STEP-toolkit
 * doc comments (probed, pre-spike §5). The 21.5 probe of the fallback
 * (docs/architecture/occt-prespike-findings.md's addendum) found it viable:
 * `occt-import-js@0.0.23` (LGPL-2.1, zero runtime dependencies, a 7.3 MB
 * emscripten wasm, dormant since 2024-12) initializes in ~37 ms under Node,
 * reads a real IGES file to meshes deterministically, and answers every
 * malformed input with `success: false` instead of a throw. This module is
 * that fallback, import-only, kept OPTIONAL alongside the primary binding.
 *
 * ## What IGES import yields here — MESHES, not solids (the honest scope)
 *
 * `occt-import-js` reads CAD files to TESSELLATIONS: its reader returns
 * three.js-compatible position/normal/index arrays plus per-face triangle
 * ranges, never OCCT BREP shapes — its wasm simply does not expose the
 * shape layer this repo's primary binding does. An IGES import through
 * this module therefore produces mesh bodies whose provenance is the
 * cad-io MESH-import discipline (`"imported-iges"`), NOT the OCCT-solids
 * discipline of `./occt-step-import`/`./occt-brep`: nothing here mints a
 * kernel solid, answers a `GeometryKernel` operation, or participates in
 * parametric history — an IGES mesh is a triangle soup with a name, the
 * same class of body an STL import produces. Pretending otherwise (e.g.
 * re-emitting the meshes as solids of the primary kernel) would fabricate
 * exactness the mesh does not have; the soup's numbers are triangulation
 * output, not BREP measurements.
 *
 * ## Units
 *
 * The reader's documented `linearUnit` parameter converts file coordinates
 * on read and defaults to `millimeter` — this repo's canonical unit — so
 * the default read is canonical mm by the library's own behavior (probed:
 * the committed fixture declares `2HMM` and reads back 10 mm extents). The
 * optional {@link IgesImportParams} passes the library's triangulation
 * parameters through unchanged when a caller needs them; the default is
 * the library's documented default set (`null`).
 *
 * ## The engine boundary
 *
 * {@link createIgesEngine} initializes the wasm once per JavaScript
 * context (memoized, with a failed initialization clearing the memo so it
 * can be retried — the twin discipline of `./occt-runtime`) and returns
 * an opaque {@link IgesEngine} handle; under Node the binding's own asset
 * resolution finds the wasm next to its glue (probed), and in the browser
 * the caller pins the asset through the standard emscripten `locateFile`
 * hook (the `?url` pattern every other wasm in this repo uses). The type
 * declarations the package does not ship live in `./occt-import-js.d.ts`.
 *
 * ## Malformed bytes (probed: total, never a throw)
 *
 * The honest split mirrors the STEP/BREP taxonomy: empty input → `empty`;
 * bytes that are not decodable text or carry no IGES fixed-format section
 * letters → `malformed`; IGES-shaped text the reader rejected
 * (`success: false`) → `failed`; a successful read with no mesh →
 * `no-meshes`. The reader prints its own diagnostics ("Total number of
 * loaded entities …") to the console through its internal printer — the
 * binding's documented stdout, neither depended on nor suppressed.
 *
 * ## No parametric history fabrication
 *
 * An IGES file carries geometry and product metadata — never this
 * document's features, parameters, or construction history. The result
 * marks the distinction in DATA (`"imported-iges"`), and nothing behind
 * this module invents any of it.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";
import occtimportjs, {
  type OcctImportJsInstance,
  type OcctImportJsParams,
} from "occt-import-js";

/** Stable failure codes produced when IGES import rejects its input. */
export const IGES_IMPORT_ERROR_CODES = {
  /** Zero-byte input — there is no file to import. */
  empty: "iges-import/empty",
  /**
   * Bytes that are not IGES text at all: undecodable bytes, or decodable
   * text without the format's fixed-width section letters.
   */
  malformed: "iges-import/malformed",
  /**
   * IGES-shaped text the reader rejected (`success: false`): typically a
   * truncated or syntactically invalid data section.
   */
  failed: "iges-import/failed",
  /**
   * A successful read that produced no mesh (empty assembly, or geometry
   * outside this reader's solid/triangulation scope).
   */
  noMeshes: "iges-import/no-meshes",
  /** The engine threw inside the import boundary. */
  kernelFailure: "iges-import/kernel-failure",
} as const;

export type IgesImportErrorCode =
  (typeof IGES_IMPORT_ERROR_CODES)[keyof typeof IGES_IMPORT_ERROR_CODES];

/** Structured failure describing why IGES import rejected some bytes. */
export interface IgesImportError extends ParseFailure {
  readonly code: IgesImportErrorCode;
}

/**
 * The triangulation parameters pass through to the reader, when a caller
 * needs them; omitted means the library's documented defaults
 * (`linearUnit: "millimeter"` among them — the canonical-unit stance).
 */
export type IgesImportParams = OcctImportJsParams;

/** The opaque initialized-engine handle (the runtime-brand discipline). */
export interface IgesEngine {
  readonly [IGES_ENGINE_BRAND]: OcctImportJsInstance;
}

/** The private brand separating {@link IgesEngine} from raw wasm handles. */
const IGES_ENGINE_BRAND = Symbol("slopcadIgesEngine");

/** The memoized engine promise: one wasm instance per JavaScript context. */
let sharedEngine: Promise<IgesEngine> | undefined;

/**
 * Initializes (or reuses) the occt-import-js wasm engine. Under Node the
 * binding resolves its own wasm asset (probed); a browser caller passes
 * `locateFile` pinning the asset URL — the `?url` import the /io wiring
 * supplies.
 */
export function createIgesEngine(options?: {
  readonly locateFile?: (path: string, scriptDirectory: string) => string;
}): Promise<IgesEngine> {
  const existing = sharedEngine;
  if (existing !== undefined) return existing;
  const engine = occtimportjs({
    ...(options?.locateFile === undefined
      ? {}
      : { locateFile: options.locateFile }),
  })
    .then((instance): IgesEngine => ({
      [IGES_ENGINE_BRAND]: instance,
    }))
    .catch((error: unknown) => {
      // A failed initialization clears the memo so an environment fix can
      // be retried (the twin discipline of `./occt-runtime`); concurrent
      // callers still await the same initialization.
      sharedEngine = undefined;
      throw error;
    });
  sharedEngine = engine;
  return engine;
}

/** One imported mesh body: the validated soup plus its IGES-carried name. */
export interface ImportedIgesMesh {
  readonly tessellation: Tessellation;
  /** The mesh's name from the file's product structure, or null when blank. */
  readonly name: string | null;
  /** The source BREP face count (per-face triangle ranges of the soup). */
  readonly brepFaces: number;
}

/** The result of a successful IGES import: mesh bodies, in file order. */
export interface ImportedIgesModel {
  readonly meshes: readonly ImportedIgesMesh[];
  readonly origin: "imported-iges";
}

function igesError(
  code: IgesImportErrorCode,
  message: string,
  bytes: Uint8Array,
): IgesImportError {
  return { code, message, input: bytes };
}

/**
 * Whether `text` carries IGES structure: the format is fixed-width 80-char
 * records whose section letter (S, G, D, P, or T) sits at column 73. A real
 * IGES file has many; one anywhere is the structural gate (the reader
 * makes its own grammar judgement on the text it receives).
 */
function looksLikeIges(text: string): boolean {
  return /^.{72}[SGDPT]/m.test(text);
}

/**
 * Maps one reader mesh into a {@link Tessellation}, validating the flat
 * arrays' structure: finite positions, integer in-range indices, normals
 * paired index-for-index when present. A mesh that fails validation is a
 * reader-contract violation, reported as the structured kernel failure —
 * never shipped as geometry.
 */
function meshTessellation(
  meshIndex: number,
  positions: readonly number[],
  indices: readonly number[],
  normals: readonly number[] | undefined,
  bytes: Uint8Array,
): ParseResult<Tessellation, IgesImportError> {
  if (
    positions.length % 3 !== 0 ||
    positions.some((value) => !Number.isFinite(value))
  ) {
    return fail(
      igesError(
        IGES_IMPORT_ERROR_CODES.kernelFailure,
        `The reader produced mesh ${meshIndex} with invalid positions (non-finite or untripled numbers).`,
        bytes,
      ),
    );
  }
  if (
    indices.some(
      (value) =>
        !Number.isInteger(value) || value < 0 || value >= positions.length / 3,
    )
  ) {
    return fail(
      igesError(
        IGES_IMPORT_ERROR_CODES.kernelFailure,
        `The reader produced mesh ${meshIndex} with indices that are not integers referencing existing vertices.`,
        bytes,
      ),
    );
  }
  if (normals !== undefined) {
    if (
      normals.length !== positions.length ||
      normals.some((value) => !Number.isFinite(value))
    ) {
      return fail(
        igesError(
          IGES_IMPORT_ERROR_CODES.kernelFailure,
          `The reader produced mesh ${meshIndex} with normals that do not pair index-for-index with finite positions.`,
          bytes,
        ),
      );
    }
    return ok({
      positions: [...positions],
      indices: [...indices],
      normals: [...normals],
    });
  }
  return ok({ positions: [...positions], indices: [...indices] });
}

/**
 * Imports `bytes` as an IGES file into mesh bodies — one per mesh the
 * reader triangulated, in file order, canonical millimetres, mesh-level
 * provenance (`"imported-iges"`). Deterministic and total: any byte input
 * either imports or fails with a structured `iges-import/*` code — never a
 * throw.
 */
export function importIgesMeshes(
  engine: IgesEngine,
  bytes: Uint8Array,
  params?: IgesImportParams,
): ParseResult<ImportedIgesModel, IgesImportError> {
  if (bytes.byteLength === 0) {
    return fail(
      igesError(
        IGES_IMPORT_ERROR_CODES.empty,
        "The input is empty (0 bytes); there is no IGES file to import.",
        bytes,
      ),
    );
  }
  // Structural text gate, before the engine sees anything: IGES is
  // fixed-format ASCII. Decoding is lenient here only to CLASSIFY —
  // replacement characters mean the bytes are not text, i.e. not IGES; the
  // reader still receives the original bytes verbatim.
  const decoded = new TextDecoder("utf-8").decode(bytes);
  if (decoded.includes("\uFFFD") || !looksLikeIges(decoded)) {
    return fail(
      igesError(
        IGES_IMPORT_ERROR_CODES.malformed,
        decoded.includes("\uFFFD")
          ? "The input is not decodable text, so it cannot be IGES data."
          : "The input carries no IGES fixed-format section records, so it is not an IGES file.",
        bytes,
      ),
    );
  }
  try {
    const result = engine[IGES_ENGINE_BRAND].ReadIgesFile(
      bytes,
      params ?? null,
    );
    if (!result.success) {
      return fail(
        igesError(
          IGES_IMPORT_ERROR_CODES.failed,
          "The IGES text was rejected by the occt-import-js reader (success false); the data section is typically truncated or invalid.",
          bytes,
        ),
      );
    }
    const meshes = result.meshes ?? [];
    if (meshes.length === 0) {
      return fail(
        igesError(
          IGES_IMPORT_ERROR_CODES.noMeshes,
          "The IGES file read successfully but produced no mesh; there is no geometry this importer can render.",
          bytes,
        ),
      );
    }
    const imported: ImportedIgesMesh[] = [];
    for (const [index, mesh] of meshes.entries()) {
      const tessellation = meshTessellation(
        index,
        mesh.attributes.position.array,
        mesh.index.array,
        mesh.attributes.normal?.array,
        bytes,
      );
      if (!tessellation.ok) return fail(tessellation.error);
      imported.push({
        tessellation: tessellation.value,
        name: mesh.name === "" ? null : mesh.name,
        brepFaces: mesh.brep_faces.length,
      });
    }
    return ok({ meshes: imported, origin: "imported-iges" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      igesError(
        IGES_IMPORT_ERROR_CODES.kernelFailure,
        `IGES import failed inside the occt-import-js boundary: ${detail}`,
        bytes,
      ),
    );
  }
}
