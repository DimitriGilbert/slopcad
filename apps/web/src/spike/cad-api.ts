/**
 * Phase 1.6 architecture spike — NON-PRODUCTION reference code.
 * Draft authoring API: `cad({ parameters, features, output })` + `feature()`.
 * Expected to be redesigned in the core phases; kept strictly typed and
 * dependency-free (the kernel handle is injected at evaluation time, so this
 * module never imports manifold-3d at runtime).
 * See docs/architecture/spike-findings.md.
 */

import type { Manifold, ManifoldToplevel } from "manifold-3d";

export interface NumberParamSpec {
  readonly kind: "number";
  readonly unit: "mm";
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export type ParamSpec = NumberParamSpec;

export type ParamSpecRecord = Readonly<Record<string, ParamSpec>>;

/** Resolved parameter values, keyed by the document's parameter names. */
export type ParamValues<T extends ParamSpecRecord> = Readonly<
  Record<keyof T & string, number>
>;

export function numberParam(spec: {
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}): NumberParamSpec {
  return { kind: "number", unit: "mm", ...spec };
}

/**
 * What a feature may read: resolved parameter values, the kernel handle, and
 * the (lazily evaluated, memoized) output of any upstream feature.
 */
export interface FeatureContext<T extends ParamSpecRecord = ParamSpecRecord> {
  readonly kernel: ManifoldToplevel;
  readonly parameters: ParamValues<T>;
  /** Resolve an upstream feature by name (memoized within one evaluation). */
  readonly get: (name: string) => Manifold;
}

/** A named node in the feature graph producing one solid. */
export interface Feature<T extends ParamSpecRecord = ParamSpecRecord> {
  readonly name: string;
  build(ctx: FeatureContext<T>): Manifold;
}

export function feature<T extends ParamSpecRecord = ParamSpecRecord>(
  name: string,
  build: (ctx: FeatureContext<T>) => Manifold,
): Feature<T> {
  return { name, build };
}

export interface CadConfig<T extends ParamSpecRecord> {
  /** Parameter declarations — the document's public inputs. */
  readonly parameters: T;
  /** The feature graph. Order is irrelevant; dependencies are by name. */
  readonly features: readonly Feature<T>[];
  /** Name of the terminal feature whose solid is the document's output. */
  readonly output: string;
}

export interface CadDocument<T extends ParamSpecRecord = ParamSpecRecord> {
  readonly parameters: T;
  readonly defaultValues: ParamValues<T>;
  /**
   * Evaluate the graph against a kernel. The caller owns the returned solids
   * and must `delete()` them (WASM memory is not garbage collected).
   */
  evaluate(
    kernel: ManifoldToplevel,
    values: Partial<ParamValues<T>>,
  ): { readonly solid: Manifold; readonly dispose: () => void };
}

export function cad<T extends ParamSpecRecord>(
  config: CadConfig<T>,
): CadDocument<T> {
  const features = new Map(config.features.map((f) => [f.name, f] as const));
  const terminal = features.get(config.output);
  if (!terminal) {
    throw new Error(`cad(): output feature "${config.output}" is not defined`);
  }
  const defaultValues = Object.fromEntries(
    Object.entries(config.parameters).map(([name, spec]) => [
      name,
      spec.default,
    ]),
  ) as Record<keyof T & string, number>;
  return {
    parameters: config.parameters,
    defaultValues,
    evaluate(kernel: ManifoldToplevel, values: Partial<ParamValues<T>>) {
      const resolved: Record<keyof T & string, number> = {
        ...defaultValues,
        ...values,
      };
      const memo = new Map<string, Manifold>();
      const ctx: FeatureContext<T> = {
        kernel,
        parameters: resolved,
        get(name: string): Manifold {
          const cached = memo.get(name);
          if (cached) {
            return cached;
          }
          const node = features.get(name);
          if (!node) {
            throw new Error(`Unknown feature "${name}"`);
          }
          const solid = node.build(ctx);
          memo.set(name, solid);
          return solid;
        },
      };
      const solid = ctx.get(config.output);
      return {
        solid,
        dispose: () => {
          for (const constructed of memo.values()) {
            constructed.delete();
          }
          memo.clear();
        },
      };
    },
  };
}
