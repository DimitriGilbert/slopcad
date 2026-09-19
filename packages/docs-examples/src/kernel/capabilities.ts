/**
 * The `kernels` guide's capability matrix data source
 * (docs/guides/kernels.md): reads the four kernels' declared capability
 * flags from their public constants and pairs them with one probed
 * behavior — Manifold's `sweep` decline — so the table the guide prints
 * is generated from the same constants the kernels report at runtime.
 */

import type { KernelCapabilities } from "@slopcad/cad-kernel";
import { FAKE_KERNEL_CAPABILITIES } from "@slopcad/cad-kernel";
import { JSCAD_KERNEL_CAPABILITIES } from "@slopcad/cad-jscad";
import { MANIFOLD_KERNEL_CAPABILITIES } from "@slopcad/cad-kernel-manifold";
import { OCCT_KERNEL_CAPABILITIES } from "@slopcad/cad-kernel-occt";

/** One row of the kernel capability matrix. */
export interface KernelCapabilityRow {
  readonly backendId: string;
  readonly capabilities: KernelCapabilities;
}

/**
 * The four kernels' declared capabilities, in `KERNEL_BACKEND_IDS` order
 * (`manifold`, `opencascade`, `jscad`, `fake`).
 */
export const KERNEL_CAPABILITY_ROWS: readonly KernelCapabilityRow[] = [
  { backendId: "manifold", capabilities: MANIFOLD_KERNEL_CAPABILITIES },
  { backendId: "opencascade", capabilities: OCCT_KERNEL_CAPABILITIES },
  { backendId: "jscad", capabilities: JSCAD_KERNEL_CAPABILITIES },
  { backendId: "fake", capabilities: FAKE_KERNEL_CAPABILITIES },
] as const;

/** The capability flag names, in declaration order. */
export const CAPABILITY_FLAG_NAMES: readonly (keyof KernelCapabilities)[] = [
  "booleans",
  "transformTranslation",
  "transformRotation",
  "transformScale",
  "exactPrimitiveVolumes",
  "exactBooleanVolumes",
  "tightBooleanBounds",
  "persistentTopology",
  "sweep",
  "loft",
  "fillet",
  "chamfer",
  "shell",
  "mirror",
  "surfaceArea",
] as const;
