/**
 * The compact, model-oriented document outline shared by the workbench and
 * assembly WebMCP tools (PLAN-AGENT-CHAT Phase 2.2, D11): outline SHAPES for
 * an LLM context budget — ids, kinds, names, values in canonical units —
 * never full geometry or record dumps. Pure cad-core reads only; no DOM, no
 * engine, so node-env unit tests drive it over real documents.
 *
 * Also owns the ASSEMBLY diagnostics section the `cad_get_diagnostics`
 * variants share: the mate-solve read over the document's mate/joint records
 * (`assembly/mate-*` codes, the joints' DOF accounting). The solver's anchor
 * table is executor-boundary state no page carries yet, so a document with
 * mates reports the solver's own honest `assembly/mate-unresolved`
 * diagnostics — the same answer the executor seam would gate on — and an
 * anchor-less document with no mates solves trivially.
 */

import {
  jointDofSummary,
  printExpression,
  resolveOccurrencePlacement,
  serializeDimensionalValue,
  solveAssemblyMates,
  type CadDocument,
  type DocumentMate,
  type DocumentOccurrence,
  type DocumentJoint,
  type FeatureRecord,
  type OccurrenceId,
  type PlacementTransform,
  type SerializedDimensionalValue,
} from "@slopcad/cad-core";

/**
 * A refusal-shaped read failure the tool modules map into their structured
 * refusal results (the same `{ ok: false, code, message }` convention every
 * tool already returns).
 */
export interface OutlineReadFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/** The compact outline of one document body. */
export interface BodyOutlineEntry {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly visible: boolean;
}

/** The compact outline of one timeline feature (statuses joined by callers). */
export interface FeatureOutlineEntry {
  readonly id: string;
  readonly kind: string;
  /** The joined timeline status, or `null` before the first regeneration run. */
  readonly status: string | null;
}

/** The compact outline of one `$`-variable (parameter). */
export interface ParameterOutlineEntry {
  readonly id: string;
  readonly name: string;
  /** The stored value in canonical units (the summary tool's own form). */
  readonly value: SerializedDimensionalValue;
  /** The defining expression printed as source, or `null` for a literal. */
  readonly expression: string | null;
}

/** The compact outline of one assembly occurrence. */
export interface OccurrenceOutlineEntry {
  readonly id: string;
  readonly name: string;
  readonly sourceKind: string;
  /** The host-resolved display name of the source (the model tree's rule). */
  readonly sourceName: string;
  readonly bomFlag: string;
  /** `null` for identity; the offset translation otherwise. */
  readonly translation: readonly [number, number, number] | null;
  /** The datum anchor's id, when the placement is datum-driven. */
  readonly datumId: string | null;
}

/** The compact outline of one assembly mate record. */
export interface MateOutlineEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly first: {
    readonly occurrenceId: string;
    readonly referenceId: string;
  };
  readonly second: {
    readonly occurrenceId: string;
    readonly referenceId: string;
  };
  /** The kind's parameter (mm for distance, deg for angle), when present. */
  readonly value: number | null;
}

/** The compact outline of one assembly joint record. */
export interface JointOutlineEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly baseOccurrenceId: string;
  readonly occurrenceId: string;
  /** The joint frame's origin, when the record carries one. */
  readonly frameOrigin: readonly [number, number, number] | null;
  /** The joint frame's axis, when the kind carries one. */
  readonly frameAxis: readonly [number, number, number] | null;
}

/**
 * The model-oriented document outline: everything an agent needs to reason
 * about WHAT the document is, at a fraction of the record dump's size.
 */
export interface DocumentOutline {
  readonly documentId: string;
  readonly bodies: readonly BodyOutlineEntry[];
  readonly features: readonly FeatureOutlineEntry[];
  readonly parameters: readonly ParameterOutlineEntry[];
  readonly occurrences: readonly OccurrenceOutlineEntry[];
  readonly mates: readonly MateOutlineEntry[];
  readonly joints: readonly JointOutlineEntry[];
}

/** The display name of an occurrence's source, host-resolved for bodies. */
function sourceNameOf(
  document: CadDocument,
  occurrence: DocumentOccurrence,
): string {
  const source = occurrence.source;
  if (source.kind === "body") {
    return (
      document.bodies.find((body) => body.id === source.bodyId)?.name ??
      source.bodyId
    );
  }
  return source.kind === "document" ? source.documentId : source.componentId;
}

/** One occurrence's placement, flattened to the outline's compact form. */
function occurrencePlacement(occurrence: DocumentOccurrence): {
  readonly translation: readonly [number, number, number] | null;
  readonly datumId: string | null;
} {
  const placement = occurrence.placement;
  if (placement.kind === "offset") {
    return { datumId: null, translation: [...placement.translation] };
  }
  if (placement.kind === "datum") {
    return {
      datumId: placement.datumId,
      translation:
        placement.translation === undefined ? null : [...placement.translation],
    };
  }
  return { datumId: null, translation: null };
}

/** One mate record's compact outline. */
function mateOutline(mate: DocumentMate): MateOutlineEntry {
  return {
    first: {
      occurrenceId: String(mate.first.occurrenceId),
      referenceId: String(mate.first.referenceId),
    },
    id: String(mate.id),
    kind: mate.kind,
    name: mate.name,
    second: {
      occurrenceId: String(mate.second.occurrenceId),
      referenceId: String(mate.second.referenceId),
    },
    value: mate.value ?? null,
  };
}

/** One joint record's compact outline. */
function jointOutline(joint: DocumentJoint): JointOutlineEntry {
  return {
    baseOccurrenceId: String(joint.baseOccurrenceId),
    frameAxis:
      joint.frame === undefined || joint.frame.axis === undefined
        ? null
        : [...joint.frame.axis],
    frameOrigin: joint.frame === undefined ? null : [...joint.frame.origin],
    id: String(joint.id),
    kind: joint.kind,
    name: joint.name,
    occurrenceId: String(joint.occurrenceId),
  };
}

/**
 * Builds the document outline. `featureStatusOf` joins each feature's
 * timeline status when the caller has one (the engine's joined timeline);
 * absent statuses stay `null` — honest "not yet run", never a guess.
 */
export function documentOutline(
  document: CadDocument,
  featureStatusOf: (feature: FeatureRecord) => string | null = () => null,
): DocumentOutline {
  return {
    bodies: document.bodies.map((body) => ({
      id: String(body.id),
      kind: body.kind ?? "solid",
      name: body.name,
      visible: body.visible ?? true,
    })),
    documentId: String(document.id),
    features: document.features.map((feature) => ({
      id: String(feature.id),
      kind: feature.kind,
      status: featureStatusOf(feature),
    })),
    joints: document.joints.map(jointOutline),
    mates: document.mates.map(mateOutline),
    occurrences: document.occurrences.map((occurrence) => {
      const placement = occurrencePlacement(occurrence);
      return {
        bomFlag: occurrence.bomFlag ?? "default",
        id: String(occurrence.id),
        name: occurrence.name,
        sourceKind: occurrence.source.kind,
        sourceName: sourceNameOf(document, occurrence),
        ...placement,
      };
    }),
    parameters: document.parameters.parameters.map((parameter) => ({
      expression:
        parameter.expression === null
          ? null
          : printExpression(parameter.expression),
      id: String(parameter.id),
      name: parameter.name,
      value: serializeDimensionalValue(parameter.value),
    })),
  };
}

/**
 * The assembly diagnostics section of `cad_get_diagnostics`: the mate-solve
 * read over the document's records — status, `assembly/mate-*` diagnostics,
 * residual/DOF — plus the joints' DOF accounting. Pure and deterministic;
 * placements resolve through the document's own datum system (top-level
 * occurrences; sub-assembly edges are the host's graph, exactly as the
 * assembly module pins).
 */
export interface AssemblyDiagnosticsSection {
  /** The success discriminant (the refusal arm carries `ok: false`). */
  readonly ok: true;
  readonly solveStatus: string;
  readonly solveDiagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly severity: string;
  }[];
  /** The solve's worst-row residual (Infinity while unresolved). */
  readonly solveResidual: number;
  /** The solve's remaining system DOF (NaN while unresolved). */
  readonly solveDof: number;
  readonly jointDof: {
    readonly rotational: number;
    readonly translational: number;
  };
  readonly mateCount: number;
  readonly jointCount: number;
  readonly occurrenceCount: number;
}

/**
 * Computes the assembly diagnostics section. Fails structurally (refusal
 * shape) only when an occurrence's placement cannot resolve against the
 * document's own datums — impossible for a document its own doors built.
 */
export function assemblyDiagnostics(
  document: CadDocument,
): AssemblyDiagnosticsSection | OutlineReadFailure {
  const initial = new Map<OccurrenceId, PlacementTransform>();
  for (const occurrence of document.occurrences) {
    const resolved = resolveOccurrencePlacement(
      occurrence.placement,
      document.datums,
    );
    if (!resolved.ok) {
      return {
        code: resolved.error.code,
        message: `The occurrence ${String(occurrence.id)} cannot be placed: ${resolved.error.message}`,
        ok: false,
      };
    }
    initial.set(occurrence.id, resolved.value);
  }
  const solved = solveAssemblyMates({
    // The anchor table is executor-boundary state (the solver's own module
    // doc): no page resolves mate anchors yet, so the honest read passes an
    // empty table and reports the solver's `assembly/mate-unresolved`
    // diagnostics for any mate a document carries.
    anchors: new Map(),
    grounded: [],
    initial,
    joints: document.joints,
    mates: document.mates,
    occurrences: document.occurrences.map((occurrence) => occurrence.id),
  });
  return {
    jointCount: document.joints.length,
    jointDof: jointDofSummary(document.joints),
    mateCount: document.mates.length,
    occurrenceCount: document.occurrences.length,
    ok: true as const,
    solveDiagnostics: solved.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
    })),
    solveDof: solved.dof,
    solveResidual: solved.residual,
    solveStatus: solved.status,
  };
}
