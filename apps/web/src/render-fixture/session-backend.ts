/**
 * The geometry backend the render/workbench fixture sessions boot: the
 * real Manifold kernel inside a module worker (see
 * `../worker-fixture/manifold-worker-entry`). The worker protocol carries
 * operations, not capability declarations, so the host pins the booted
 * entry's DECLARED capabilities here — the adapter's own capability
 * constant is the single source of truth, and a session that boots a
 * different worker entry must re-pin this fact from that backend's
 * declaration.
 *
 * The bounds inspection (Phase 27.1) displays the tightness fact: bounds
 * of boolean results are the tight axis-aligned boxes only where the
 * kernel declares `tightBooleanBounds`; a kernel without the declaration
 * may report conservative containers, and the readout must say so.
 */

import {
  MANIFOLD_BACKEND_ID,
  MANIFOLD_KERNEL_CAPABILITIES,
} from "@slopcad/cad-kernel-manifold";
import {
  OCCT_BACKEND_ID,
  OCCT_KERNEL_CAPABILITIES,
} from "@slopcad/cad-kernel-occt";

/** The declared capabilities of the backend the fixture sessions boot. */
export const WORKBENCH_SESSION_BACKEND = {
  /** The backend id the booted worker entry hosts. */
  id: MANIFOLD_BACKEND_ID,
  /** Whether boolean-result bounds are declared tight. */
  tightBooleanBounds: MANIFOLD_KERNEL_CAPABILITIES.tightBooleanBounds,
} as const;

/**
 * The OpenCascade backend's declaration, pinned from its own capability
 * constant — the declaration the sweep-capable complete-workbench route
 * (Phase 38) reports, whose booted worker entry hosts the OCCT kernel.
 */
export const OCCT_SESSION_BACKEND = {
  id: OCCT_BACKEND_ID,
  tightBooleanBounds: OCCT_KERNEL_CAPABILITIES.tightBooleanBounds,
} as const;

/** The worker backends a fixture session can boot. */
export type FixtureSessionBackendId = "manifold" | "occt";

/** The backend declaration for the booted backend id. */
export function sessionBackendOf(
  backend: FixtureSessionBackendId = "manifold",
): typeof WORKBENCH_SESSION_BACKEND | typeof OCCT_SESSION_BACKEND {
  return backend === "occt" ? OCCT_SESSION_BACKEND : WORKBENCH_SESSION_BACKEND;
}
