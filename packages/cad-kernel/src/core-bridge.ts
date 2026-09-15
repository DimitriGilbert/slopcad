/**
 * The core-executes-against-kernel bridge (Phase 8): a cad-core
 * {@link FeatureExecutor} backed by a kernel contract instance. This is the
 * seam that proves "core can execute against a kernel": cad-core's
 * regeneration orchestration stays kernel-neutral (the executor is
 * caller-supplied by design), and this module — living in cad-kernel, which
 * depends on cad-core and never the other way around — interprets a small,
 * documented set of feature kinds as kernel operations.
 *
 * Direction of dependency: kernel types flow into nothing. cad-core never
 * imports kernel types; the bridge imports cad-core (document records,
 * parameters, diagnostics, the regeneration executor signature) and the
 * kernel contract.
 *
 * ## Interpreted feature kinds and input layouts
 *
 * Every feature must declare exactly one output body. Inputs are positional
 * and typed by kind:
 *
 * - `box` — three parameter inputs: width, depth, height.
 * - `sphere` — one parameter input: radius.
 * - `cylinder` — two parameter inputs: radius, height.
 * - `cone` — three parameter inputs: bottomRadius, topRadius, height.
 * - `union` / `intersect` — two or more feature/body inputs.
 * - `subtract` — two or more feature/body inputs: first the target, then
 *   the tools.
 * - `translate` — one feature/body input followed by three parameter
 *   inputs: x, y, z.
 *
 * Feature inputs resolve to the referenced feature's (single) output body.
 * Body inputs resolve through the caller-supplied prior bodies map (solids
 * from earlier runs or imported geometry). Parameters resolve through the
 * document's parameter collection and must be lengths; any length unit
 * converts to canonical mm, so a `2 cm` width and a `20 mm` width drive
 * identical geometry (single units source of truth).
 *
 * Failures are reported as structured cad-core diagnostics (severity
 * `error`, located at the feature, offending input ids attached as related)
 * with the `kernel/*` diagnostic codes, so regeneration marks the feature
 * failed and gates its dependents stale exactly like any other executor
 * failure. Use one bridge per regeneration run: outputs accumulate on the
 * bridge as the executor is called in evaluation order.
 */

import {
  type AnyDimensionalValue,
  type BodyId,
  type CadDocument,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type FeatureExecutionOutcome,
  type FeatureExecutor,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  length as lengthValue,
  valueIn,
} from "@slopcad/cad-core";

import { type GeometryKernel, type KernelSolid } from "./contract";

/** The feature kinds the bridge interprets as kernel operations. */
export const BRIDGE_FEATURE_KINDS = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "union",
  "subtract",
  "intersect",
  "translate",
] as const;

/** A feature kind the bridge knows how to execute. */
export type BridgeFeatureKind = (typeof BRIDGE_FEATURE_KINDS)[number];

/** Context the bridge executes against. */
export interface KernelExecutorContext {
  /** The document whose features and parameters are being regenerated. */
  readonly document: CadDocument;
  /**
   * Solids already associated with the document's bodies (from a prior run
   * or imported geometry), keyed by body id; freshly executed features'
   * outputs layer on top.
   */
  readonly bodies: ReadonlyMap<BodyId, KernelSolid>;
}

/** A bridge created for one regeneration run. */
export interface KernelExecutionBridge {
  /** The cad-core executor to pass to `regenerate`. */
  readonly executor: FeatureExecutor;
  /**
   * The solid a feature produced for the given output body this run, or the
   * prior solid for bodies not rebuilt — the seam consumers use to make
   * semantic assertions about executed geometry.
   */
  solidOf(bodyId: BodyId): KernelSolid | undefined;
}

const BRIDGE_KIND_SET: ReadonlySet<string> = new Set(BRIDGE_FEATURE_KINDS);

function isBridgeFeatureKind(kind: string): kind is BridgeFeatureKind {
  return BRIDGE_KIND_SET.has(kind);
}

type BridgeDiagnosticCode = Extract<
  DiagnosticCode,
  | "kernel/unknown-feature-kind"
  | "kernel/feature-input-invalid"
  | "kernel/parameter-invalid"
  | "kernel/operation-failed"
>;

function diagnostic(
  feature: FeatureRecord,
  code: BridgeDiagnosticCode,
  message: string,
  related: readonly FeatureInputRef[] = [],
): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    location: { primary: feature.id, related: related.map((ref) => ref.id) },
  };
}

type LengthOutcome =
  | { readonly ok: true; readonly mm: number }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

type SolidOutcome =
  | { readonly ok: true; readonly solid: KernelSolid }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

type OperationOutcome = SolidOutcome;

/**
 * Creates a feature executor that interprets the bridge's feature kinds as
 * kernel operations through the given kernel instance. The kernel instance
 * owns every handle it mints, so use one kernel per bridge (and per run).
 */
export function createKernelFeatureExecutor(
  kernel: GeometryKernel,
  context: KernelExecutorContext,
): KernelExecutionBridge {
  const parameters = new Map<string, AnyDimensionalValue>(
    context.document.parameters.parameters.map((parameter) => [
      parameter.id,
      parameter.value,
    ]),
  );
  const featureOutputs = new Map<FeatureId, BodyId>(
    context.document.features.flatMap((feature) => {
      const output = feature.outputs[0];
      return output === undefined ? [] : [[feature.id, output] as const];
    }),
  );
  const solids = new Map<BodyId, KernelSolid>(context.bodies);

  const lengthParameter = (
    feature: FeatureRecord,
    ref: FeatureInputRef,
    name: string,
  ): LengthOutcome => {
    const value = parameters.get(ref.id);
    if (value === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" references parameter "${ref.id}" (${name}), which the document does not define.`,
          [ref],
        ),
      };
    }
    if (value.dimension !== "length") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelParameterInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs parameter "${ref.id}" (${name}) to be a length; it is a ${value.dimension}.`,
          [ref],
        ),
      };
    }
    return { ok: true, mm: valueIn(value, "mm") };
  };

  const solidInput = (
    feature: FeatureRecord,
    ref: FeatureInputRef,
  ): SolidOutcome => {
    if (ref.kind === "parameter") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs a feature or body input where parameter "${ref.id}" was declared.`,
          [ref],
        ),
      };
    }
    if (ref.kind === "body") {
      const solid = solids.get(ref.id);
      if (solid === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" references body "${ref.id}", which has no solid (none was produced this run and none was supplied).`,
            [ref],
          ),
        };
      }
      return { ok: true, solid };
    }
    const outputBody = featureOutputs.get(ref.id);
    if (outputBody === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" references feature "${ref.id}", which declares no output body.`,
          [ref],
        ),
      };
    }
    const solid = solids.get(outputBody);
    if (solid === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" references feature "${ref.id}", whose output body "${outputBody}" has no solid yet (it did not execute before this feature).`,
          [ref],
        ),
      };
    }
    return { ok: true, solid };
  };

  const execute = (feature: FeatureRecord): FeatureExecutionOutcome => {
    const output = feature.outputs[0];
    if (feature.outputs.length !== 1 || output === undefined) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "${feature.kind}" must declare exactly one output body; it declares ${feature.outputs.length}.`,
          ),
        ],
      };
    }
    const kind = feature.kind;
    if (!isBridgeFeatureKind(kind)) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelUnknownFeatureKind,
            `Feature "${feature.id}" has kind "${kind}", which the kernel executor bridge does not interpret; known kinds: ${BRIDGE_FEATURE_KINDS.join(", ")}.`,
          ),
        ],
      };
    }

    const result = runKernelOperation(kernel, feature, kind, {
      lengthParameter: (ref, name) => lengthParameter(feature, ref, name),
      solidInput: (ref) => solidInput(feature, ref),
    });
    if (!result.ok) return { ok: false, diagnostics: [result.diagnostic] };
    solids.set(output, result.solid);
    return { ok: true };
  };

  return {
    executor: execute,
    solidOf: (bodyId: BodyId): KernelSolid | undefined => solids.get(bodyId),
  };
}

/** How the per-kind interpreter reads inputs. */
interface InputReaders {
  readonly lengthParameter: (
    ref: FeatureInputRef,
    name: string,
  ) => LengthOutcome;
  readonly solidInput: (ref: FeatureInputRef) => SolidOutcome;
}

/** Reads exactly `count` length parameters named by `names`. */
function readLengths(
  feature: FeatureRecord,
  readers: InputReaders,
  refs: readonly FeatureInputRef[],
  names: readonly string[],
):
  | { readonly ok: true; readonly mm: readonly number[] }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (refs.length !== names.length) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs exactly ${names.length} parameter inputs (${names.join(", ")}); it declares ${refs.length}.`,
      ),
    };
  }
  const values: number[] = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const name = names[i];
    if (ref === undefined || name === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" has a malformed input list.`,
        ),
      };
    }
    if (ref.kind !== "parameter") {
      return {
        ok: false,
        diagnostic: diagnostic(
          feature,
          DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
          `Feature "${feature.id}" of kind "${feature.kind}" needs a parameter input for ${name}; a ${ref.kind} input was declared.`,
          [ref],
        ),
      };
    }
    const value = readers.lengthParameter(ref, name);
    if (!value.ok) return value;
    values.push(value.mm);
  }
  return { ok: true, mm: values };
}

/** Reads at least `minimum` feature/body inputs as solids. */
function readSolids(
  feature: FeatureRecord,
  readers: InputReaders,
  refs: readonly FeatureInputRef[],
  minimum: number,
):
  | { readonly ok: true; readonly solids: readonly KernelSolid[] }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (refs.length < minimum) {
    return {
      ok: false,
      diagnostic: diagnostic(
        feature,
        DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        `Feature "${feature.id}" of kind "${feature.kind}" needs at least ${minimum} feature/body inputs; it declares ${refs.length}.`,
      ),
    };
  }
  const resolved: KernelSolid[] = [];
  for (const ref of refs) {
    const value = readers.solidInput(ref);
    if (!value.ok) return value;
    resolved.push(value.solid);
  }
  return { ok: true, solids: resolved };
}

function operationFailure(
  feature: FeatureRecord,
  code: string,
  message: string,
): { readonly ok: false; readonly diagnostic: Diagnostic } {
  return {
    ok: false,
    diagnostic: {
      severity: "error",
      code: DIAGNOSTIC_CODES.kernelOperationFailed,
      message: `Feature "${feature.id}" of kind "${feature.kind}" failed its kernel operation (${code}): ${message}`,
      location: { primary: feature.id },
      data: { kernelErrorCode: code },
    },
  };
}

function runKernelOperation(
  kernel: GeometryKernel,
  feature: FeatureRecord,
  kind: BridgeFeatureKind,
  readers: InputReaders,
): OperationOutcome {
  const inputs = feature.inputs;
  switch (kind) {
    case "box": {
      const lengths = readLengths(feature, readers, inputs, [
        "width",
        "depth",
        "height",
      ]);
      if (!lengths.ok) return lengths;
      const [width, depth, height] = lengths.mm;
      if (width === undefined || depth === undefined || height === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "box" needs exactly three parameter inputs.`,
          ),
        };
      }
      const result = kernel.createBox({
        width: lengthValue(width),
        depth: lengthValue(depth),
        height: lengthValue(height),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "sphere": {
      const lengths = readLengths(feature, readers, inputs, ["radius"]);
      if (!lengths.ok) return lengths;
      const radius = lengths.mm[0];
      if (radius === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "sphere" needs exactly one parameter input.`,
          ),
        };
      }
      const result = kernel.createSphere({ radius: lengthValue(radius) });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "cylinder": {
      const lengths = readLengths(feature, readers, inputs, [
        "radius",
        "height",
      ]);
      if (!lengths.ok) return lengths;
      const [radius, height] = lengths.mm;
      if (radius === undefined || height === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "cylinder" needs exactly two parameter inputs.`,
          ),
        };
      }
      const result = kernel.createCylinder({
        radius: lengthValue(radius),
        height: lengthValue(height),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "cone": {
      const lengths = readLengths(feature, readers, inputs, [
        "bottomRadius",
        "topRadius",
        "height",
      ]);
      if (!lengths.ok) return lengths;
      const [bottomRadius, topRadius, height] = lengths.mm;
      if (
        bottomRadius === undefined ||
        topRadius === undefined ||
        height === undefined
      ) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "cone" needs exactly three parameter inputs.`,
          ),
        };
      }
      const result = kernel.createCone({
        bottomRadius: lengthValue(bottomRadius),
        topRadius: lengthValue(topRadius),
        height: lengthValue(height),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "union": {
      const resolved = readSolids(feature, readers, inputs, 2);
      if (!resolved.ok) return resolved;
      const result = kernel.union(resolved.solids);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "subtract": {
      const resolved = readSolids(feature, readers, inputs, 2);
      if (!resolved.ok) return resolved;
      const [target, ...tools] = resolved.solids;
      if (target === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "subtract" needs a target input.`,
          ),
        };
      }
      const result = kernel.subtract(target, tools);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "intersect": {
      const resolved = readSolids(feature, readers, inputs, 2);
      if (!resolved.ok) return resolved;
      const result = kernel.intersect(resolved.solids);
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
    case "translate": {
      const solidRef = inputs[0];
      if (solidRef === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "translate" needs one feature/body input followed by three parameter inputs.`,
          ),
        };
      }
      const solid = readers.solidInput(solidRef);
      if (!solid.ok) return solid;
      const lengths = readLengths(feature, readers, inputs.slice(1), [
        "x",
        "y",
        "z",
      ]);
      if (!lengths.ok) return lengths;
      const [x, y, z] = lengths.mm;
      if (x === undefined || y === undefined || z === undefined) {
        return {
          ok: false,
          diagnostic: diagnostic(
            feature,
            DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
            `Feature "${feature.id}" of kind "translate" needs exactly three translation parameter inputs.`,
          ),
        };
      }
      const result = kernel.transform(solid.solid, {
        x: lengthValue(x),
        y: lengthValue(y),
        z: lengthValue(z),
      });
      return result.ok
        ? { ok: true, solid: result.value }
        : operationFailure(feature, result.error.code, result.error.message);
    }
  }
}
