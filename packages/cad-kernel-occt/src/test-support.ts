/**
 * Shared test support for the OCCT suites. Test-only — never imported by
 * production modules.
 */

import type { KernelSolid } from "@slopcad/cad-kernel";
import type { OcctKernel } from "./occt-kernel";

/**
 * `solid` through a BREP round trip: the same geometry with no history,
 * so no construction names — the legacy hash-identity regime (an untracked
 * producer is what still yields hashes since Phase N2).
 */
export function untracked(kernel: OcctKernel, solid: KernelSolid): KernelSolid {
  const exported = kernel.exportBrep([solid]);
  if (!exported.ok) throw new Error(exported.error.message);
  const imported = kernel.importBrep(exported.value);
  if (!imported.ok) throw new Error(imported.error.message);
  const first = imported.value.solids[0]?.solid;
  if (first === undefined) throw new Error("the import carries no solid");
  return first;
}
