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
import type { GeometryKernel } from "@slopcad/cad-kernel";
import type { ComponentKernelResult } from "./component-kernel";

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
