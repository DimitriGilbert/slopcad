/**
 * Version of the kernel-neutral CAD document format (Phase 6 substrate)
 * implemented by `@slopcad/cad-core`.
 *
 * Serializable domain objects (documents, parameters, features, bodies,
 * references) stamp persisted data with this version so future format
 * migrations always have a base to migrate from. It must remain a positive
 * integer and only ever move forward.
 */
export const CAD_DOCUMENT_FORMAT_VERSION = 1;

/**
 * Version of the native parametric document format (Phase 17): the ONE
 * persisted serialization that carries the full parametric intent — document
 * state, applied transaction log, regeneration states, and metadata — as
 * emitted by `serializeNativeCadDocument` and consumed by
 * `parseNativeCadDocument`.
 *
 * It is versioned independently of {@link CAD_DOCUMENT_FORMAT_VERSION}: the
 * substrate sections nested inside a native document keep their own stamps
 * and evolve on their own schedule, so the native envelope's version moves
 * only when the envelope itself changes shape. It must remain a positive
 * integer and only ever move forward; older versions reach the current one
 * through the migration registry in `native-migration.ts`.
 *
 * v2 (Phase 36): the embedded sketch payloads' vocabulary grew — the sketch
 * domain's format v2 adds the entity kinds `ellipse`, `ellipticalArc`,
 * `spline`, `polygon`, and `slot` and the constraint kinds `pointOnEntity`,
 * `collinear`, `horizontalPair`, `verticalPair`, `distanceX`, and
 * `distanceY`. The envelope's own shape is unchanged; the version moves
 * because an old reader handed a v2 document would reject the embedded
 * sketch payloads, so the envelope stamp is the reader's only gate. The
 * v1→v2 migration carries old documents forward by bumping every embedded
 * sketch payload's stamp (the growth is additive — v1 payload content is
 * valid v2 content).
 */
export const CAD_NATIVE_FORMAT_VERSION = 2;

/**
 * Version of the renderer-neutral render projection wire format (Phase 11)
 * implemented by `@slopcad/cad-core`: the shape emitted by
 * `serializeRenderProjection` and consumed by `parseRenderProjection`. It is
 * versioned independently of the document format because projections cross a
 * different boundary (kernel worker → renderer) than persisted documents.
 * It must remain a positive integer and only ever move forward.
 */
export const CAD_PROJECTION_FORMAT_VERSION = 1;
