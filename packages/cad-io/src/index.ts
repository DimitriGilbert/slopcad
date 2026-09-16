/**
 * Public entry of `@slopcad/cad-io`, the mesh import/export package
 * (Phase 18): the STL and 3MF adapters, joined by GLB export (Phase 19).
 * React-free and UI-free.
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
 *   paired unit normals) — one source of truth for the mesh shape. The GLB
 *   exporter (Phase 19) instead takes the cad-core `RenderProjection` — the
 *   renderer-neutral render data built from that same soup, kernel normals
 *   included — because glTF is a render-oriented format and the projection
 *   is the plan's stated input for it.
 * - Output is deterministic: the same input yields byte-identical files.
 * - Every format has one file per solid (STL has no part structure; richer
 *   formats may revisit this when they land). GLB is the exception with a
 *   scene: one named node per render object of the projection.
 * - Rejections are structured `ParseResult` failures with stable
 *   `<format>/<cause>` codes, following the cad-core failure convention.
 *
 * ## Environment note
 *
 * The 3MF importer supports deflate-compressed packages through `node:zlib`
 * and is therefore Node-targeted; see `./three-mf-import`'s header for the
 * documented browser constraint. Every other adapter — the GLB exporter
 * included — is browser-safe.
 */

export {
  GLB_BASE_COLOR_SRGB,
  GLB_BIN_CHUNK_TYPE,
  GLB_CHUNK_HEADER_BYTES,
  GLB_EXPORT_ERROR_CODES,
  GLB_GENERATOR,
  GLB_HEADER_BYTES,
  GLB_JSON_CHUNK_TYPE,
  GLB_MAGIC,
  GLB_MATERIAL_NAME,
  GLB_METALLIC_FACTOR,
  GLB_ROUGHNESS_FACTOR,
  GLB_UINT16_VERTEX_LIMIT,
  GLB_VERSION,
  exportGlb,
} from "./glb-export";
export type {
  GlbExportError,
  GlbExportErrorCode,
  GlbExportResult,
} from "./glb-export";
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
