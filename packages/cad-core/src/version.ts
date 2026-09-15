/**
 * Version of the kernel-neutral CAD document format implemented by
 * `@slopcad/cad-core`.
 *
 * Serializable domain objects (documents, parameters, features, bodies,
 * references) stamp persisted data with this version so future format
 * migrations always have a base to migrate from. It must remain a positive
 * integer and only ever move forward.
 */
export const CAD_DOCUMENT_FORMAT_VERSION = 1;
