/**
 * Public entry of `@slopcad/cad-io`, the mesh import/export package
 * (Phase 18): the STL and 3MF adapters today, GLB export (Phase 19) after
 * it. React-free and UI-free.
 *
 * ## Dependency direction
 *
 * The package sits *above* the geometry stack — it may depend on the kernel
 * contract (`@slopcad/cad-kernel`) and cad-core's result discipline, and it
 * must never become a dependency of cad-core: no I/O format knowledge leaks
 * into the document model (the Phase 18 plan constraint). Format code lives
 * here and only here.
 *
 * ## What the adapters share
 *
 * - Geometry travels as the kernel contract's `Tessellation` (flat xyz
 *   positions in canonical millimetres, flat triangle indices, optional
 *   paired unit normals) — one source of truth for the mesh shape.
 * - Output is deterministic: the same input yields byte-identical files.
 * - Every format has one file per solid (STL has no part structure; richer
 *   formats may revisit this when they land).
 * - Rejections are structured `ParseResult` failures with stable
 *   `<format>/<cause>` codes, following the cad-core failure convention.
 *
 * ## Environment note
 *
 * The 3MF importer supports deflate-compressed packages through `node:zlib`
 * and is therefore Node-targeted; see `./three-mf-import`'s header for the
 * documented browser constraint.
 */

export {
  STL_BINARY_HEADER_TEXT,
  STL_COUNT_BYTES,
  STL_EXPORT_ERROR_CODES,
  STL_HEADER_BYTES,
  STL_MIN_BYTES,
  STL_TRIANGLE_BYTES,
  exportStlBinary,
} from "./stl-export";
export type {
  StlExportError,
  StlExportErrorCode,
  StlExportResult,
} from "./stl-export";
export {
  STL_IMPORT_ERROR_CODES,
  STL_IMPORT_NORMAL_UNIT_TOLERANCE,
  importStl,
} from "./stl-import";
export type {
  ImportedStlMesh,
  StlImportError,
  StlImportErrorCode,
  StlImportFlavor,
  StlImportResult,
} from "./stl-import";
export {
  THREE_MF_CONTENT_TYPES_NAMESPACE,
  THREE_MF_CONTENT_TYPES_PART_NAME,
  THREE_MF_CORE_NAMESPACE,
  THREE_MF_EXPORT_ERROR_CODES,
  THREE_MF_MODEL_CONTENT_TYPE,
  THREE_MF_MODEL_PART_NAME,
  THREE_MF_MODEL_RELATIONSHIP_TYPE,
  THREE_MF_MODEL_UNIT,
  THREE_MF_RELATIONSHIPS_NAMESPACE,
  THREE_MF_RELS_PART_NAME,
  exportThreeMf,
} from "./three-mf-export";
export type {
  ThreeMfExportError,
  ThreeMfExportErrorCode,
  ThreeMfExportResult,
  ThreeMfMetadata,
} from "./three-mf-export";
export {
  THREE_MF_IMPORT_ERROR_CODES,
  THREE_MF_IMPORT_MAX_PART_BYTES,
  THREE_MF_UNIT_TO_MILLIMETER_FACTORS,
  importThreeMf,
} from "./three-mf-import";
export type {
  ImportedThreeMfMesh,
  ThreeMfImportError,
  ThreeMfImportErrorCode,
  ThreeMfImportResult,
  ThreeMfUnit,
} from "./three-mf-import";
