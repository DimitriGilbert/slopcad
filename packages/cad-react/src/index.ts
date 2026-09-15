/**
 * Public entry of `@slopcad/cad-react`, the React integration layer over
 * the kernel-neutral CAD core. Re-exports the core public API so React
 * consumers depend on this package alone. React is a peer dependency;
 * this layer never touches geometry kernels.
 */
export { CAD_DOCUMENT_FORMAT_VERSION } from "@slopcad/cad-core";
