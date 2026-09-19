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
