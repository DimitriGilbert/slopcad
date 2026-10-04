/**
 * The workbench's boolean wiring (Phase 44): the document readers and
 * validation seams for the USER-LEVEL booleans — union, subtract, and
 * intersect over BODY MULTI-SELECTION with a keep-tool toggle — through
 * the EXISTING bridge kinds (`union`/`subtract`/`intersect` have been
 * engine-level vocabulary since Phase 8; this module is the surface that
 * makes them workbench commands). Both the executor bridge and the
 * worker scene below ride the same `solid.union`/`solid.subtract`/
 * `solid.intersect` operations every kernel carries, so the boolean
 * surface adds NO kernel-level dependency (the roadmap's own ruling).
 *
 * ## Keep-tool semantics (the display-flag lever)
 *
 * The operands are never DELETED — a history-based document keeps every
 * feature and its output body. "Keep tool bodies" therefore rides the
 * Phase 44 body VISIBILITY flags: ON (the default) leaves every operand
 * rendering, exactly the pre-existing behavior; OFF consumes the TOOLS —
 * each tool body's `body.update visible:false` lands in the SAME atomic
 * transaction as the boolean itself, so undo restores the display state
 * with the feature. The target body stays visible either way: the label
 * governs the tools, verbatim (the Fusion affordance's scope).
 */

import type { BodyId, FeatureRecord } from "@slopcad/cad-core";
import type { documentExtrudeRequest } from "./extrude";

import { sceneOperandOfBody, type SceneOperand } from "./extrude";

/** The three boolean operations the command surface carries. */
export const BOOLEAN_OPERATIONS = ["union", "subtract", "intersect"] as const;

/** One boolean operation the workbench commands address. */
export type BooleanOperation = (typeof BOOLEAN_OPERATIONS)[number];

/** The boolean command's authoring input (the dialog's values). */
export interface BooleanInput {
  /** The operation — one of the three bridge kinds. */
  readonly operation: BooleanOperation;
  /** The target body (subtract's minuend; first operand otherwise). */
  readonly targetBodyId: string;
  /** The tool bodies (subtract's subtrahends; the other operands). */
  readonly toolBodyIds: readonly string[];
  /** `true` keeps the tool bodies visible (the default); `false` consumes them. */
  readonly keepToolBodies: boolean;
}

/** The form's defaults: a subtract that keeps its tools. */
export const BOOLEAN_DEFAULTS: BooleanInput = {
  operation: "subtract",
  targetBodyId: "",
  toolBodyIds: [],
  keepToolBodies: true,
};

/** The outcome of one validation attempt (the structured refusal). */
export type BooleanValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Refuses the impossible boolean submissions BEFORE any commit: an
 * unknown operation, a missing target, an empty or overlapping tool
 * list, or duplicated tools. The kernel's own operand rules (disjoint
 * intersections build empty solids — legal input, the honest answer)
 * stay the engine's business; this seam refuses only what no kernel can
 * make sense of.
 */
export function validateBooleanSubmission(
  input: BooleanInput,
): BooleanValidation {
  if (!BOOLEAN_OPERATIONS.includes(input.operation)) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message: `The boolean operation must be one of: ${BOOLEAN_OPERATIONS.join(", ")}.`,
    };
  }
  if (input.targetBodyId.length === 0) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message: "A boolean needs a target body — pick the operand to modify.",
    };
  }
  if (input.toolBodyIds.length === 0) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message:
        "A boolean needs at least one tool body — pick the operand(s) to combine with the target.",
    };
  }
  if (input.toolBodyIds.includes(input.targetBodyId)) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message:
        "A boolean's tool bodies must differ from its target — the operand that combines with itself is the target already.",
    };
  }
  const seen = new Set<string>();
  for (const tool of input.toolBodyIds) {
    if (seen.has(tool)) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A boolean's tool bodies must be distinct — pick each body once.",
      };
    }
    seen.add(tool);
  }
  return { ok: true };
}

/**
 * The feature that OWNS a body: the first feature (document order) whose
 * outputs include the body — the model tree's own first-producer rule.
 */
export function featureProducingBody(
  document: Parameters<typeof documentExtrudeRequest>[0],
  bodyId: string,
): FeatureRecord | undefined {
  return document.features.find((feature) =>
    feature.outputs.includes(bodyId as BodyId),
  );
}

/** The worker-scene payload one boolean feature executes as. */
export interface BooleanSceneRequest {
  /** The target operand's source (the boolean's first input). */
  readonly target: SceneOperand;
  /** EVERY declared tool's source, in declared order (the commit keeps all). */
  readonly tools: readonly SceneOperand[];
  /** The operation riding the scene. */
  readonly operation: BooleanOperation;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * One boolean feature's operand body id: a feature ref resolves to the
 * feature's first output (the model tree's own rule), a body ref names the
 * body itself. `null` when the reference dangles.
 */
function operandBodyIdOf(
  byId: ReadonlyMap<string, FeatureRecord>,
  ref: { readonly kind: string; readonly id: string },
): string | null {
  if (ref.kind === "body") return ref.id;
  if (ref.kind === "feature") {
    const feature = byId.get(ref.id);
    const output = feature?.outputs[0];
    return output === undefined ? null : output;
  }
  return null;
}

/**
 * Reads EVERY boolean feature (`union`/`subtract`/`intersect`) into its
 * worker-scene request, in document order — ALL of them render, each
 * consuming its target's current solid (the second subtract rides the
 * first's output). The TARGET is the first operand ref and EVERY further
 * operand ref is a TOOL: a multi-tool commit composes all of them in ONE
 * scene (the kernel's boolean operations are n-ary; the commit keeps every
 * declared tool, so dropping any would silently lose material the author
 * picked). Each operand resolves through `sceneOperandOfBody`: a plain
 * extrusion pairs with its own extrusion (the established constraint), a
 * composition's output (pad, hole, boolean, moved body) references the
 * computed solid the document pass hands over. A feature whose output or
 * ANY operand no longer resolves is skipped honestly, whole — the other
 * booleans still render.
 */
export function documentBooleanSceneRequests(
  document: Parameters<typeof documentExtrudeRequest>[0],
): readonly BooleanSceneRequest[] {
  const requests: BooleanSceneRequest[] = [];
  const byId = new Map(document.features.map((entry) => [entry.id, entry]));
  for (const feature of document.features) {
    if (!BOOLEAN_OPERATIONS.includes(feature.kind as BooleanOperation)) {
      continue;
    }
    const bodyId = feature.outputs[0];
    const operandRefs = feature.inputs.filter(
      (ref) => ref.kind === "feature" || ref.kind === "body",
    );
    const targetRef = operandRefs[0];
    const toolRefs = operandRefs.slice(1);
    if (bodyId === undefined || targetRef === undefined) continue;
    if (toolRefs.length === 0) continue;
    const targetBodyId = operandBodyIdOf(byId, targetRef);
    if (targetBodyId === null) continue;
    const target = sceneOperandOfBody(document, targetBodyId);
    if (target === null) continue;
    const tools: SceneOperand[] = [];
    let resolved = true;
    for (const toolRef of toolRefs) {
      const toolBodyId = operandBodyIdOf(byId, toolRef);
      const tool =
        toolBodyId === null ? null : sceneOperandOfBody(document, toolBodyId);
      if (tool === null) {
        resolved = false;
        break;
      }
      tools.push(tool);
    }
    if (!resolved) continue;
    requests.push({
      target,
      tools,
      operation: feature.kind as BooleanOperation,
      bodyId,
    });
  }
  return requests;
}

/**
 * The document's FIRST boolean feature's scene request — the plural
 * reader's head, kept for the callers that reason about the one-boolean
 * document. `null` when the document carries none that resolves.
 */
export function documentBooleanSceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
): BooleanSceneRequest | null {
  return documentBooleanSceneRequests(document)[0] ?? null;
}
