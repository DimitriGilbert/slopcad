/**
 * Public entry of `@slopcad/cad-r3f`, the React Three Fiber renderer
 * layer. Re-exports the React integration public API so R3F consumers
 * depend on this package alone. React, Three.js, and R3F are peer
 * dependencies; geometry kernels are never imported here.
 */
export { CAD_DOCUMENT_FORMAT_VERSION } from "@slopcad/cad-react";
