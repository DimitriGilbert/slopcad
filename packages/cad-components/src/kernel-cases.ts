/**
 * Test support (Phase 32): the kernel backend case list the component
 * suites run their semantic-geometry fixtures against — the two shipped
 * kernel backends that are devDependencies of this package (the Manifold
 * WASM engine and the JSCAD engine), each through the public
 * `GeometryKernel` contract. A component built through
 * `directComponentKernel` behaves identically against any conforming
 * kernel; these two are the shipped proof.
 *
 * Not exported from the package index: this module exists for the
 * colocated suites (the `src` test files) and imports devDependencies.
 */

import { createJscadKernel } from "@slopcad/cad-jscad";
import { createManifoldKernel } from "@slopcad/cad-kernel-manifold";
import type { GeometryKernel, KernelSolid } from "@slopcad/cad-kernel";
import type {
  ComponentKernel,
  ComponentKernelResult,
} from "./component-kernel";

/** One kernel backend a component suite runs its fixtures against. */
export interface ComponentKernelCase {
  readonly name: string;
  readonly create: () => Promise<GeometryKernel>;
}

/**
 * Unwraps a component-kernel result, throwing the structured failure
 * verbatim — the component twin of cad-kernel's public `unwrapKernelResult`
 * (whose error type is the narrower `KernelError`).
 */
export function unwrapComponentResult<T>(
  result: ComponentKernelResult<T>,
  label = "component-kernel operation",
): T {
  if (result.ok) return result.value;
  throw new Error(
    `${label} failed with ${result.error.code}: ${result.error.message}`,
  );
}

/** The kernel case list: every shipped backend the components run on. */
export const COMPONENT_KERNEL_CASES: readonly ComponentKernelCase[] = [
  {
    name: "manifold",
    create: () => createManifoldKernel(),
  },
  {
    name: "jscad",
    create: () => Promise.resolve(createJscadKernel()),
  },
];

/** What the counting wrapper exposes to a test's assertions. */
export interface CountingComponentKernel {
  readonly kernel: ComponentKernel;
  /** Every solid the wrapped kernel minted, in mint order. */
  readonly minted: readonly KernelSolid[];
  /** Every solid the wrapped kernel disposed, in dispose order. */
  readonly disposed: readonly KernelSolid[];
}

/** Options of {@link countKernelSolids}. */
export interface CountingComponentKernelOptions {
  /**
   * Makes the Nth minting call (1-based) refuse structurally BEFORE the
   * wrapped kernel is touched, so no phantom solid is minted — the
   * refusal exercises consumers' early-return disposal paths.
   */
  readonly failNthMint?: number;
}

/**
 * Wraps a component kernel with mint/dispose accounting (review Phase 9.C):
 * every solid-minting operation is recorded, every `dispose` is recorded,
 * and an optional injected refusal proves the caller releases what it
 * minted so far when the kernel says no mid-build.
 */
export function countKernelSolids(
  kernel: ComponentKernel,
  options: CountingComponentKernelOptions = {},
): CountingComponentKernel {
  const minted: KernelSolid[] = [];
  const disposed: KernelSolid[] = [];
  const mint = (
    result: ComponentKernelResult<KernelSolid>,
  ): ComponentKernelResult<KernelSolid> => {
    if (result.ok) {
      minted.push(result.value);
    }
    return result;
  };
  const refuseNth = (): ComponentKernelResult<KernelSolid> | undefined =>
    options.failNthMint === minted.length + 1
      ? {
          ok: false,
          error: {
            code: "test/injected-mint-refusal",
            message: "the counting wrapper refuses this mint by request",
            input: options.failNthMint,
          },
        }
      : undefined;
  return {
    kernel: {
      ...kernel,
      createBox: async (input) =>
        refuseNth() ?? mint(await kernel.createBox(input)),
      createSphere: async (input) =>
        refuseNth() ?? mint(await kernel.createSphere(input)),
      createCylinder: async (input) =>
        refuseNth() ?? mint(await kernel.createCylinder(input)),
      createCone: async (input) =>
        refuseNth() ?? mint(await kernel.createCone(input)),
      extrude: async (input) =>
        refuseNth() ?? mint(await kernel.extrude(input)),
      revolve: async (input) =>
        refuseNth() ?? mint(await kernel.revolve(input)),
      sweep: async (input) => refuseNth() ?? mint(await kernel.sweep(input)),
      loft: async (input) => refuseNth() ?? mint(await kernel.loft(input)),
      fillet: async (input) => refuseNth() ?? mint(await kernel.fillet(input)),
      chamfer: async (input) =>
        refuseNth() ?? mint(await kernel.chamfer(input)),
      shell: async (input) => refuseNth() ?? mint(await kernel.shell(input)),
      mirror: async (solid, input) =>
        refuseNth() ?? mint(await kernel.mirror(solid, input)),
      union: async (operands) =>
        refuseNth() ?? mint(await kernel.union(operands)),
      subtract: async (target, tools) =>
        refuseNth() ?? mint(await kernel.subtract(target, tools)),
      intersect: async (operands) =>
        refuseNth() ?? mint(await kernel.intersect(operands)),
      transform: async (solid, input) =>
        refuseNth() ?? mint(await kernel.transform(solid, input)),
      dispose: async (solid) => {
        disposed.push(solid);
        await kernel.dispose(solid);
      },
    },
    minted,
    disposed,
  };
}
