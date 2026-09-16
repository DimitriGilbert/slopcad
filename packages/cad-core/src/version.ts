/**
 * Version of the kernel-neutral CAD document format implemented by
 * `@slopcad/cad-core`.
 *
 * Serializable domain objects (documents, parameters, features, bodies,
 * references) stamp persisted data with this version so future format
 * migrations always have a base to migrate from. It must remain a positive
 * integer and only ever move forward.
 */
export const CAD_DOCUMENT_FORMAT_VERSION = 1;

/**
 * Version of the renderer-neutral render projection wire format (Phase 11)
 * implemented by `@slopcad/cad-core`: the shape emitted by
 * `serializeRenderProjection` and consumed by `parseRenderProjection`. It is
 * versioned independently of the document format because projections cross a
 * different boundary (kernel worker → renderer) than persisted documents.
 * It must remain a positive integer and only ever move forward.
 */
export const CAD_PROJECTION_FORMAT_VERSION = 1;
