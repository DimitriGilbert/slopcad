/**
 * The project surface's shared limits (Phase 31): the single source the
 * routers validate against and the client forms render — a dependency-free
 * module so browser code can import it without dragging the server stack
 * (drizzle, the db singleton) into the bundle.
 */

/** The longest acceptable project name. */
export const PROJECT_NAME_MAX_LENGTH = 120;

/** The longest acceptable project description. */
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;

/** The longest acceptable document name. */
export const DOCUMENT_NAME_MAX_LENGTH = 120;

/**
 * The longest acceptable serialized native document (`documents.save`'s
 * `nativeContent`), in characters. The largest committed golden fixture
 * (`workbench-extrude.native.json`) is ~8.5 KB and realistic parametric
 * documents are kilobytes, so 10 MiB is roughly three orders of magnitude
 * of headroom — while capping what an unbounded payload could force the
 * server to spend on the format's full parse-and-replay validation and on
 * the verbatim `document_version` row it stores.
 */
export const NATIVE_CONTENT_MAX_LENGTH = 10 * 1024 * 1024;
