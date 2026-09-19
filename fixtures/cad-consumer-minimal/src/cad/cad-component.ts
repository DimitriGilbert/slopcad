import type { ParseFailure, ParseResult } from "@slopcad/cad-core";
import type { KernelSolid } from "@slopcad/cad-kernel";
import type { ComponentKernel } from "./component-kernel";
import type {
  CadComponentDefinition,
  ComponentParameterValues,
  ComponentPortInstance,
  ResolvedComponentParameters,
} from "./component-contract";

import {
  parseComponentDefinition,
  resolveComponentParameters,
  serializeComponentDefinition,
} from "./component-contract";

/** Stable component-level build failure codes (kernel codes pass through). */
export const COMPONENT_BUILD_ERROR_CODES = {
  /**
   * The parameters satisfy their descriptor bounds but violate a
   * component-specific geometric constraint (e.g. a boss diameter that
   * would swallow a screw hole). The message says which constraint.
   */
  parameterConflict: "component/parameter-conflict",
} as const;

export type ComponentBuildErrorCode =
  (typeof COMPONENT_BUILD_ERROR_CODES)[keyof typeof COMPONENT_BUILD_ERROR_CODES];

/** Structured failure of one component build. */
export interface ComponentBuildError extends ParseFailure {
  /** A `component/*` code, or the underlying `kernel/*`/`worker/*` code. */
  readonly code: string;
}

/** One named solid of a build, under the body id its preview declares. */
export interface ComponentBuildBody {
  /** The body's name within the component (e.g. `"shell"`, `"lid"`). */
  readonly name: string;
  /**
   * The stable body id the body projects under — the preview metadata's
   * `bodyIds` entry this body was declared with.
   */
  readonly bodyId: string;
  readonly solid: KernelSolid;
}

/** The successful result of one component build. */
export interface ComponentBuild {
  /** The built bodies, in the preview metadata's declared order. */
  readonly bodies: readonly ComponentBuildBody[];
}

/** The result shape of one component build. */
export type ComponentBuildResult = ParseResult<
  ComponentBuild,
  ComponentBuildError
>;

function buildError(
  code: string,
  message: string,
  input?: unknown,
): ComponentBuildError {
  return { code, input, message };
}

/** A `component/parameter-conflict` failure (bounds-expressible code path). */
export function parameterConflict(
  message: string,
  input?: unknown,
): ComponentBuildError {
  return buildError(
    COMPONENT_BUILD_ERROR_CODES.parameterConflict,
    message,
    input,
  );
}

/** Adapts a contract-resolution failure into a build failure, verbatim. */
export function contractFailureAsBuildError(
  error: ParseFailure,
): ComponentBuildError {
  return buildError(error.code, error.message, error.input);
}

/**
 * Validates `values` against `definition`'s descriptors — the mandatory
 * FIRST step of every component build (callers that skipped it fail here,
 * with the contract's own codes, before any kernel work).
 */
export function resolveBuildParameters(
  definition: CadComponentDefinition,
  values: ComponentParameterValues,
): ParseResult<ResolvedComponentParameters, ComponentBuildError> {
  const resolved = resolveComponentParameters(definition, values);
  return resolved.ok
    ? resolved
    : { ok: false, error: contractFailureAsBuildError(resolved.error) };
}

/**
 * Validates a component's own definition through the public contract and
 * returns the normalized (frozen, canonical key order) form. A component
 * shipping an invalid definition is a programming error, so this fails
 * loudly at construction instead of letting a broken definition reach a
 * registry.
 */
export function defineComponent(
  definition: CadComponentDefinition,
): CadComponentDefinition {
  const parsed = parseComponentDefinition(
    serializeComponentDefinition(definition),
  );
  if (!parsed.ok) {
    throw new Error(
      `Invalid component definition "${definition.id}": ${parsed.error.message}`,
    );
  }
  return parsed.value;
}

/**
 * A reusable parametric CAD component: its self-describing
 * {@link CadComponentDefinition} plus the two operations a consumer needs
 * — the kernel-neutral `build` and the kernel-free `ports`.
 */
export interface CadComponent {
  /** The component's serialized metadata (name, parameters, ports, version, preview). */
  readonly definition: CadComponentDefinition;
  /**
   * Builds the component through `kernel` alone. Implementations validate
   * the values against the definition first and never throw: every failure
   * — contract, component-semantic, or kernel — is the structured result's
   * error. Deterministic: the same kernel and values build the same solids.
   */
  build(
    kernel: ComponentKernel,
    values: ComponentParameterValues,
  ): Promise<ComponentBuildResult>;
  /**
   * Resolves the definition's declared ports for `values` — positions in
   * component-local canonical millimetres, in the definition's port order.
   * Pure arithmetic on the parameters; no kernel involvement.
   */
  ports(values: ComponentParameterValues): readonly ComponentPortInstance[];
}

export { buildError };
