import type { KernelBackendId } from "@slopcad/cad-kernel";

/**
 * Backend identifier of the JSCAD kernel adapter. Typed as a
 * {@link KernelBackendId} so the compiler guarantees this adapter stays
 * registered in the kernel abstraction's backend list.
 */
export const JSCAD_BACKEND_ID: KernelBackendId = "jscad";
