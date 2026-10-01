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
 *
 * v3 (Phase 39): the document substrate grew named datum records — the
 * additive `datums` section, the `datum` id-generator counter, and the
 * `datum` feature-input kind that addresses datums. The growth is
 * content-additive (v2 content is valid v3 content and the v2→v3
 * migration is content-preserving), but the version moves because an old
 * reader can no longer load every v3 document faithfully: a feature input
 * of kind `datum` fails an old reader's input-kind validation outright,
 * and a standalone `datums` section is silently dropped by the old
 * reader's unknown-field tolerance — both are data the old reader cannot
 * carry, so the envelope stamp is the gate.
 *
 * v4 (Phase 50): the document substrate grew component occurrences — the
 * assembly-as-document decision (docs/architecture/
 * adr-assemblies-structure.md). The additive `occurrences` section and
 * the `occurrence` id-generator counter are content-additive (v3 content
 * is valid v4 content and the v3→v4 migration is content-preserving),
 * but the version moves because an old reader would silently drop the
 * standalone section and its counter — assembly structure is data the
 * old reader cannot carry, so the envelope stamp is the gate.
 *
 * v5 (Phase 51): the document substrate grew the assembly vocabulary —
 * the additive `mates` and `joints` sections and their `mate`/`joint`
 * id-generator counters. Content-additive exactly like its predecessors
 * (v4 content is valid v5 content; the v4→v5 migration is the
 * identity), but the version moves because an old reader would silently
 * drop the standalone sections and counters — mate and joint records
 * are data the old reader cannot carry, so the envelope stamp is the
 * gate.
 *
 * v6 (Phase 57): the document substrate grew configurations — the
 * additive `configurations` section and the `configuration`
 * id-generator counter: named parameter-set rows over the document,
 * evaluated into effective document views
 * (docs/architecture/adr-configurations.md). Content-additive exactly
 * like its predecessors (v5 content is valid v6 content; the v5→v6
 * migration is the identity), but the version moves because an old
 * reader would silently drop the standalone section and counter —
 * configuration rows are data the old reader cannot carry, so the
 * envelope stamp is the gate.
 *
 * v7 (Phase 22): the command vocabulary grew expression payloads —
 * `parameter.set` can carry a defining-expression AST (and its
 * `expression: null` clear form), and `parameter.create` can carry one
 * beside its value. The envelope's own sections are unchanged — the
 * document substrate has serialized parameter expressions since Phase 5 —
 * but the TRANSACTION LOG is no longer old-reader-faithful: an old reader
 * parsing an expression-bearing `parameter.set` drops the unknown field
 * and replays a different document (its log/head replay check refuses the
 * file with a confusing history mismatch). The version moves so the gate
 * is the predictable migration refusal, not a corrupted replay; the
 * v6→v7 migration is the identity (v6 content is valid v7 content).
 */
export const CAD_NATIVE_FORMAT_VERSION = 7;

/**
 * Version of the renderer-neutral render projection wire format (Phase 11)
 * implemented by `@slopcad/cad-core`: the shape emitted by
 * `serializeRenderProjection` and consumed by `parseRenderProjection`. It is
 * versioned independently of the document format because projections cross a
 * different boundary (kernel worker → renderer) than persisted documents.
 * It must remain a positive integer and only ever move forward.
 */
export const CAD_PROJECTION_FORMAT_VERSION = 1;
