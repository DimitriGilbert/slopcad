/**
 * Assembly resolution (Phase 50): the pure walk that turns a root
 * document's occurrence tree into PLACED INSTANCES — leaf bodies with
 * composed world transforms — plus the cross-document staleness rule.
 *
 * ## What resolution is (and is not)
 *
 * An occurrence's geometry IS its source's regenerated output: resolution
 * never re-executes a feature, never touches a kernel. It walks sources —
 * a body of the same document, another document through the host-supplied
 * document seam, a registry component through the host-supplied component
 * seam — copies provenance, and composes placements. Unresolvable sources
 * are structured `assembly/*` failures, never silent drops.
 *
 * ## Composition order is the instance path order — fixed
 *
 * The world transform of an instance at path `[occ_a, occ_b, …]` is
 * `M(occ_a) ∘ M(occ_b) ∘ …` (outermost first — see placement.ts and the
 * assembly ADR). The order is a property of the path, never of traversal
 * state, so identical paths compose identically everywhere.
 *
 * ## Direct content vs placed content
 *
 * A document's bodies that NO occurrence claims are its DIRECT content:
 * at the root they render as the document's own (unplaced) objects — the
 * existing pipeline — and inside a sub-assembly they render as placed
 * instances at the composed transform of the occurrence that pulled the
 * sub-assembly in. Cycles (a document transitively containing itself,
 * by either the cad-core id or the opaque persistence id) and paths past
 * {@link ASSEMBLY_INSTANCE_DEPTH_LIMIT} are structured refusals: the
 * walk stops, it never recurses into itself.
 *
 * ## Staleness (project-local first)
 *
 * {@link computeAssemblyStaleness} derives staleness from host-supplied
 * revision data — the persistence layer's save ordinals — with one rule:
 * an assembly is stale iff any TRANSITIVE source document's revision is
 * newer than the assembly's own. The effective revision folds the maximum
 * up the source graph (cycle-safe), so a sub-sub-source edit marks the
 * whole chain stale in one pure pass; no clock, no mutable "seen" state,
 * bitwise-deterministic.
 */

import type {
  CadDocument,
  DocumentDatum,
  DocumentOccurrence,
} from "./document";

import {
  parseDatumPayload,
  resolveDatumPayload,
  orthonormalDatumFrame,
  datumCross,
  type DatumVec3,
  type ResolvedDatum,
} from "./datum";
import { type BodyId, type DatumId, type OccurrenceId } from "./ids";
import {
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  parsePlacementTransform,
  placementTransformFromFrame,
  type PlacementTransform,
} from "./placement";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes produced by assembly resolution. */
export const ASSEMBLY_ERROR_CODES = {
  sourceUnresolved: "assembly/source-unresolved",
  cycleDetected: "assembly/cycle-detected",
  depthExceeded: "assembly/depth-exceeded",
  datumUnresolved: "assembly/datum-unresolved",
  placementUnresolvable: "assembly/placement-unresolvable",
} as const;

export type AssemblyErrorCode =
  (typeof ASSEMBLY_ERROR_CODES)[keyof typeof ASSEMBLY_ERROR_CODES];

/** Structured failure describing why an assembly could not resolve. */
export interface AssemblyError extends ParseFailure {
  readonly code: AssemblyErrorCode;
}

function assemblyError(
  code: AssemblyErrorCode,
  message: string,
  input: unknown,
): AssemblyError {
  return { code, message, input };
}

/**
 * How deep an occurrence path may nest (occurrences on the deepest path).
 * A runaway guard, not a modeling limit: real assemblies sit orders of
 * magnitude below it, and a cycle that would walk forever is refused at
 * the cycle check first.
 */
export const ASSEMBLY_INSTANCE_DEPTH_LIMIT = 16;

/**
 * The host seams resolution resolves sources through — both optional, both
 * host-owned: cad-core never imports the persistence layer or the
 * component registry. A source whose seam is missing (or that the seam
 * cannot resolve) surfaces as `assembly/source-unresolved` naming it.
 */
export interface AssemblyResolverSeams {
  /** Resolves a document source id (the persistence layer's) to its document. */
  readonly document?: (documentId: string) => CadDocument | undefined;
  /** Resolves a registry component id to the stable body ids it provides. */
  readonly component?: (componentId: string) => readonly BodyId[] | undefined;
}

/**
 * One placed leaf body: the resolution output a renderer consumes. The
 * same body may appear many times (that is the point of an assembly);
 * the PATH — not the body id — is the instance's identity.
 */
export interface PlacedBodyInstance {
  /** The occurrence path, OUTERMOST FIRST (the root document's occurrence first). */
  readonly path: readonly OccurrenceId[];
  /**
   * The body placed at the path's tip. For a component source these are
   * the component manifest's stable body ids, supplied by the host seam.
   */
  readonly bodyId: BodyId;
  /** The composed world transform (path order, outermost first). */
  readonly transform: PlacementTransform;
  /** The BOM flags along the path, outermost first (absent = default). */
  readonly bomFlags: readonly (DocumentOccurrence["bomFlag"] | undefined)[];
}

/** The outcome of resolving an assembly's instances. */
export type AssemblyResolution =
  | { readonly ok: true; readonly instances: readonly PlacedBodyInstance[] }
  | { readonly ok: false; readonly error: AssemblyError };

/**
 * Resolves a document's placed instances. Direct root content is NOT
 * included — the root's unclaimed bodies render as the document's own
 * objects; only OCCURRENCE-placed bodies come back here. Deterministic:
 * the walk visits occurrences in document order and bodies in document
 * order, so identical inputs produce identical instance lists.
 */
export function resolveAssemblyInstances(
  root: CadDocument,
  seams: AssemblyResolverSeams = {},
): AssemblyResolution {
  const instances: PlacedBodyInstance[] = [];
  const failure = walkDocument(root, {
    seams,
    isRoot: true,
    path: [],
    transform: IDENTITY_PLACEMENT_TRANSFORM,
    bomFlags: [],
    ancestors: new Set([root.id]),
    opaqueAncestors: new Set<string>(),
    instances,
  });
  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, instances };
}

interface WalkContext {
  readonly seams: AssemblyResolverSeams;
  readonly isRoot: boolean;
  readonly path: readonly OccurrenceId[];
  readonly transform: PlacementTransform;
  readonly bomFlags: readonly (DocumentOccurrence["bomFlag"] | undefined)[];
  /** Cad-core document ids on the active chain (cycle detection). */
  readonly ancestors: Set<string>;
  /** Opaque persistence document ids on the active chain (cycle detection). */
  readonly opaqueAncestors: Set<string>;
  readonly instances: PlacedBodyInstance[];
}

/** Emits one instance into the walk's accumulator. */
function emitInstance(
  context: WalkContext,
  path: readonly OccurrenceId[],
  bodyId: BodyId,
  transform: PlacementTransform,
  bomFlags: readonly (DocumentOccurrence["bomFlag"] | undefined)[],
): void {
  context.instances.push({
    path: [...path],
    bodyId,
    transform,
    bomFlags: [...bomFlags],
  });
}

/** The one recursive walk; returns a structured refusal or `undefined`. */
function walkDocument(
  document: CadDocument,
  context: WalkContext,
): AssemblyError | undefined {
  const claimed = new Set<BodyId>();
  for (const occurrence of document.occurrences) {
    if (occurrence.source.kind === "body")
      claimed.add(occurrence.source.bodyId);
  }
  // Direct content of a NON-root document renders placed at the transform
  // that pulled the document in; the root's direct content is the
  // document's own unplaced rendering and never appears here.
  if (!context.isRoot) {
    for (const body of document.bodies) {
      if (claimed.has(body.id)) continue;
      emitInstance(
        context,
        context.path,
        body.id,
        context.transform,
        context.bomFlags,
      );
    }
  }
  for (const occurrence of document.occurrences) {
    const placement = resolveOccurrencePlacement(
      occurrence.placement,
      document.datums,
    );
    if (!placement.ok) return placement.error;
    const transform = composePlacementTransforms(
      context.transform,
      placement.value,
    );
    const path = [...context.path, occurrence.id];
    if (path.length > ASSEMBLY_INSTANCE_DEPTH_LIMIT) {
      return assemblyError(
        ASSEMBLY_ERROR_CODES.depthExceeded,
        `The occurrence path ${path.map((id) => String(id)).join(" > ")} exceeds the depth limit ${ASSEMBLY_INSTANCE_DEPTH_LIMIT}.`,
        path,
      );
    }
    const bomFlags = [...context.bomFlags, occurrence.bomFlag];
    const source = occurrence.source;
    if (source.kind === "body") {
      emitInstance(context, path, source.bodyId, transform, bomFlags);
      continue;
    }
    if (source.kind === "component") {
      const resolve = context.seams.component;
      const bodyIds = resolve?.(source.componentId);
      if (bodyIds === undefined) {
        return assemblyError(
          ASSEMBLY_ERROR_CODES.sourceUnresolved,
          `The component source "${source.componentId}" could not be resolved: no component seam supplied it.`,
          source,
        );
      }
      for (const bodyId of bodyIds) {
        emitInstance(context, path, bodyId, transform, bomFlags);
      }
      continue;
    }
    // Document source: resolve through the host seam, guard cycles on both
    // the cad-core id and the opaque persistence id, then recurse.
    const resolve = context.seams.document;
    const sub = resolve?.(source.documentId);
    if (sub === undefined) {
      return assemblyError(
        ASSEMBLY_ERROR_CODES.sourceUnresolved,
        `The document source "${source.documentId}" could not be resolved: no document seam supplied it.`,
        source,
      );
    }
    if (
      context.ancestors.has(sub.id) ||
      context.opaqueAncestors.has(source.documentId)
    ) {
      return assemblyError(
        ASSEMBLY_ERROR_CODES.cycleDetected,
        `The document source "${source.documentId}" is already on the active occurrence chain — assemblies may not contain themselves.`,
        source,
      );
    }
    context.ancestors.add(sub.id);
    context.opaqueAncestors.add(source.documentId);
    const refusal = walkDocument(sub, {
      ...context,
      isRoot: false,
      path,
      transform,
      bomFlags,
    });
    context.ancestors.delete(sub.id);
    context.opaqueAncestors.delete(source.documentId);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Placement resolution (occurrence placement -> transform)
// ---------------------------------------------------------------------------

/**
 * Resolves one occurrence placement against its document's datums.
 * `identity` and `offset` are pure arithmetic; a `datum` anchor resolves
 * the datum's payload here — topology-dependent datum definitions need the
 * executor's topology seam, so this entry point is for topology-free
 * documents and the tests; the executor-boundary variant below accepts
 * pre-resolved frames.
 */
export function resolveOccurrencePlacement(
  placement: DocumentOccurrence["placement"],
  datums: readonly DocumentDatum[],
): ParseResult<PlacementTransform, AssemblyError> {
  if (placement.kind === "identity") return ok(IDENTITY_PLACEMENT_TRANSFORM);
  if (placement.kind === "offset") {
    return ok({
      rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
      translation: [...placement.translation],
    });
  }
  const datum = datums.find((candidate) => candidate.id === placement.datumId);
  if (datum === undefined) {
    return fail(
      assemblyError(
        ASSEMBLY_ERROR_CODES.datumUnresolved,
        `The placement's datum anchor ${String(placement.datumId)} does not exist in this document.`,
        placement,
      ),
    );
  }
  const parsedInput = parseDatumPayload(datum.datum);
  if (!parsedInput.ok) {
    return fail(
      assemblyError(
        ASSEMBLY_ERROR_CODES.placementUnresolvable,
        `The placement's datum anchor payload is malformed: ${parsedInput.error.message}`,
        placement,
      ),
    );
  }
  const parsedPayload = resolveDatumPayload(parsedInput.value, {
    facePlane: () =>
      fail(
        assemblyError(
          ASSEMBLY_ERROR_CODES.placementUnresolvable,
          "The placement's datum anchor is defined from a face; resolve it through the executor's topology seam.",
          placement,
        ),
      ),
    faceCylinderAxis: () =>
      fail(
        assemblyError(
          ASSEMBLY_ERROR_CODES.placementUnresolvable,
          "The placement's datum anchor is defined from a cylindrical face; resolve it through the executor's topology seam.",
          placement,
        ),
      ),
    edgeLine: () =>
      fail(
        assemblyError(
          ASSEMBLY_ERROR_CODES.placementUnresolvable,
          "The placement's datum anchor is defined from an edge; resolve it through the executor's topology seam.",
          placement,
        ),
      ),
  });
  if (!parsedPayload.ok) {
    return fail(
      assemblyError(
        ASSEMBLY_ERROR_CODES.placementUnresolvable,
        `The placement's datum anchor could not resolve: ${parsedPayload.error.message}`,
        placement,
      ),
    );
  }
  const anchor = placementTransformFromResolvedDatum(parsedPayload.value);
  if (!anchor.ok) return anchor;
  if (placement.translation === undefined) return ok(anchor.value);
  // The optional translation applies IN the anchor's frame: anchor ∘ offset.
  return ok(
    composePlacementTransforms(anchor.value, {
      rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
      translation: [...placement.translation],
    }),
  );
}

/** A resolved datum frame as the placement algebra consumes it. */
function placementTransformFromResolvedDatum(
  resolved: ResolvedDatum,
): ParseResult<PlacementTransform, AssemblyError> {
  if (resolved.datumType === "cSys") {
    const { origin, xAxis, yAxis, zAxis } = resolved.cSys;
    return ok(placementTransformFromFrame({ origin, xAxis, yAxis, zAxis }));
  }
  if (resolved.datumType === "plane") {
    const { origin, normal, xAxis } = resolved.plane;
    // The plane frame's handed axes: z is the normal, y completes x×y=z
    // (both unit, orthogonal by the resolver's construction, so y is unit).
    const zAxis = normal;
    const yAxis = datumCross(zAxis, xAxis);
    return ok(
      placementTransformFromFrame({
        origin,
        xAxis,
        yAxis,
        zAxis,
      }),
    );
  }
  if (resolved.datumType === "axis") {
    const { origin, direction } = resolved.axis;
    // An axis anchors position and ONE direction; the roll about it is a
    // documented free choice — the frame's x takes the direction, with the
    // up-hint dodged when the direction is itself vertical.
    const upHint: DatumVec3 =
      Math.abs(direction[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const frame = orthonormalDatumFrame(origin, direction, upHint);
    if (!frame.ok) {
      return fail(
        assemblyError(
          ASSEMBLY_ERROR_CODES.placementUnresolvable,
          `The placement's axis anchor has a degenerate direction: ${frame.error.message}`,
          direction,
        ),
      );
    }
    const yAxis = datumCross(frame.value.normal, frame.value.xAxis);
    return ok(
      placementTransformFromFrame({
        origin: frame.value.origin,
        xAxis: frame.value.xAxis,
        yAxis,
        zAxis: frame.value.normal,
      }),
    );
  }
  // A point anchors position only: identity rotation at the point.
  return ok({
    rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
    translation: [...resolved.point.position],
  });
}

/**
 * Resolves a placement against a map of PRE-RESOLVED datum frames — the
 * executor-boundary entry point: the executor resolves datum payloads
 * through its topology seam once, then every occurrence anchored to them
 * resolves here, deterministically.
 */
export function resolveOccurrencePlacementFromFrames(
  placement: DocumentOccurrence["placement"],
  frames: ReadonlyMap<DatumId, PlacementTransform>,
): ParseResult<PlacementTransform, AssemblyError> {
  if (placement.kind === "identity") return ok(IDENTITY_PLACEMENT_TRANSFORM);
  if (placement.kind === "offset") {
    return ok({
      rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
      translation: [...placement.translation],
    });
  }
  const anchor = frames.get(placement.datumId);
  if (anchor === undefined) {
    return fail(
      assemblyError(
        ASSEMBLY_ERROR_CODES.datumUnresolved,
        `The placement's datum anchor ${String(placement.datumId)} has no resolved frame.`,
        placement,
      ),
    );
  }
  const validated = parsePlacementTransform(anchor);
  if (!validated.ok) {
    return fail(
      assemblyError(
        ASSEMBLY_ERROR_CODES.placementUnresolvable,
        `The placement's datum anchor frame is not a valid placement transform: ${validated.error.message}`,
        placement,
      ),
    );
  }
  if (placement.translation === undefined) return ok(validated.value);
  return ok(
    composePlacementTransforms(validated.value, {
      rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
      translation: [...placement.translation],
    }),
  );
}

// ---------------------------------------------------------------------------
// Cross-document staleness (project-local first)
// ---------------------------------------------------------------------------

/** One document's revision data as the staleness rule consumes it. */
export interface AssemblyDocumentRevision {
  /** The persistence layer's document id (opaque to cad-core). */
  readonly documentId: string;
  /** The document's own revision — monotonic (the save ordinal). */
  readonly revision: number;
  /** The document's cross-document occurrence sources (occurrence → source). */
  readonly sources: readonly {
    readonly occurrenceId: OccurrenceId;
    readonly sourceDocumentId: string;
  }[];
}

/** One transitive source that is newer than the assembly it feeds. */
export interface AssemblyStaleSource {
  /** The assembly (or intermediate document) the source feeds. */
  readonly documentId: string;
  readonly sourceDocumentId: string;
  readonly occurrenceId: OccurrenceId;
  /** The source's revision, strictly newer than the consumer's. */
  readonly sourceRevision: number;
  /** The consumer's own revision. */
  readonly consumerRevision: number;
}

/** The staleness report for one assembly. */
export interface AssemblyStaleness {
  /** True iff at least one transitive source is newer than its consumer. */
  readonly stale: boolean;
  /** The newest-per-link stale edges, ordered by discovery (deterministic). */
  readonly staleSources: readonly AssemblyStaleSource[];
}

/**
 * Computes an assembly's staleness over host-supplied revisions. The rule:
 * `effective(document) = max(document.revision, max over sources of
 * effective(source))`, and the assembly is stale iff
 * `effective(assembly) > assembly.revision`. Cycles are visited once and
 * never loop; documents the graph mentions but the host did not supply
 * contribute nothing (an unresolvable source cannot be newer than
 * anything — the resolution walk is what refuses it, this function only
 * ranks what exists).
 */
export function computeAssemblyStaleness(
  documents: readonly AssemblyDocumentRevision[],
  assemblyDocumentId: string,
): AssemblyStaleness {
  const byId = new Map(documents.map((entry) => [entry.documentId, entry]));
  const staleSources: AssemblyStaleSource[] = [];
  const visited = new Set<string>();

  const effective = (documentId: string): number => {
    if (visited.has(documentId)) return Number.NEGATIVE_INFINITY;
    visited.add(documentId);
    const entry = byId.get(documentId);
    if (entry === undefined) return Number.NEGATIVE_INFINITY;
    let newest = entry.revision;
    for (const source of entry.sources) {
      const sourceEffective = effective(source.sourceDocumentId);
      const sourceEntry = byId.get(source.sourceDocumentId);
      if (sourceEntry !== undefined && sourceEffective > entry.revision) {
        staleSources.push({
          documentId,
          sourceDocumentId: source.sourceDocumentId,
          occurrenceId: source.occurrenceId,
          sourceRevision: sourceEffective,
          consumerRevision: entry.revision,
        });
      }
      newest = Math.max(newest, sourceEffective);
    }
    return newest;
  };

  const root = byId.get(assemblyDocumentId);
  if (root === undefined) {
    return { stale: false, staleSources: [] };
  }
  visited.add(assemblyDocumentId);
  let newest = root.revision;
  for (const source of root.sources) {
    const sourceEffective = effective(source.sourceDocumentId);
    const sourceEntry = byId.get(source.sourceDocumentId);
    if (sourceEntry !== undefined && sourceEffective > root.revision) {
      staleSources.push({
        documentId: assemblyDocumentId,
        sourceDocumentId: source.sourceDocumentId,
        occurrenceId: source.occurrenceId,
        sourceRevision: sourceEffective,
        consumerRevision: root.revision,
      });
    }
    newest = Math.max(newest, sourceEffective);
  }
  return { stale: newest > root.revision, staleSources };
}
