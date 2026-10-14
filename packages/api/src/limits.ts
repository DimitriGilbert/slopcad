/**
 * The surfaces' shared input limits (project surface, Phase 31; agent chat,
 * Phase 1.4): the single source the routers validate against and the client
 * forms render — a dependency-free module so browser code can import it
 * without dragging the server stack (drizzle, the db singleton) into the
 * bundle.
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

/** The longest acceptable agent conversation title. */
export const AGENT_CONVERSATION_TITLE_MAX_LENGTH = 200;

/**
 * The most message parts one appended agent message may carry. The parts
 * are opaque JSON (their concrete shapes belong to the chat runtime,
 * Phase 3), so the count is the one structural bound the input boundary
 * can enforce cheaply.
 */
export const AGENT_MESSAGE_MAX_PARTS = 256;

/**
 * The longest acceptable serialized form (`JSON.stringify`) of one appended
 * message's `parts` array, in characters — the same rationale as
 * `NATIVE_CONTENT_MAX_LENGTH`: bounding what an unbounded payload could
 * force the server to store verbatim. Image feedback parts are
 * base64-heavy and legitimately megabyte-scale, hence the same order of
 * magnitude as a native document.
 */
export const AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH = 10 * 1024 * 1024;
