/**
 * A hand-rolled STEP Part 21 reader for the test suite (Phase 21.4). Its
 * independence is the point: it shares no code with any exporter or importer
 * (it does not import `@slopcad/cad-kernel-occt`, call it, or invert it) —
 * it parses raw bytes straight from the published ISO-10303-21 text grammar
 * and throws on any structural violation. Semantic assertions built on it
 * are therefore evidence about the format output, not about an exporter's
 * internal bookkeeping.
 *
 * What it reads (and nothing more — the full Part 21 grammar is out of
 * scope for a test reader):
 *
 * - the header section between `HEADER;` and the first `ENDSEC;`: the
 *   FILE_DESCRIPTION description, the FILE_NAME triple of interest (model
 *   name, time stamp, preprocessor/version), and the FILE_SCHEMA token;
 * - the entity graph's shape: every `#<id> = ` assignment's id (unique,
 *   counted, with the maximum exposed) and per-type occurrence counts for
 *   the entity type names the caller asks about (e.g.
 *   `MANIFOLD_SOLID_BREP`, `ADVANCED_BREP_SHAPE_REPRESENTATION`,
 *   `CLOSED_SHELL`, `ADVANCED_FACE`);
 * - the `END-ISO-10303-21;` terminator.
 *
 * Test-only module: imported exclusively by this package's `*.test.ts`
 * files, never exported from the package index.
 */

/** The parsed header of one STEP Part 21 document. */
export interface StepHeader {
  /** FILE_DESCRIPTION's first description string. */
  readonly description: string;
  /** FILE_NAME's first string: the model name. */
  readonly modelName: string;
  /** FILE_NAME's second string: the ISO-8601 local time stamp. */
  readonly timeStamp: string;
  /** FILE_NAME's fifth/sixth strings: processor and originator versions. */
  readonly processor: string;
  readonly originator: string;
  /** FILE_SCHEMA's token (e.g. `AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }`). */
  readonly schema: string;
}

/** One parsed STEP Part 21 document's structural facts. */
export interface StepDocument {
  readonly header: StepHeader;
  /** The number of `#<id> = ` entity assignments in the data section. */
  readonly entityCount: number;
  /** The largest entity id seen (ids are unique but not asserted dense). */
  readonly maxEntityId: number;
  /** Occurrence counts per requested entity type name. */
  readonly typeCounts: Readonly<Record<string, number>>;
}

function require(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Malformed STEP Part 21: ${message}`);
  }
}

/**
 * Throws the reader's structural-violation error; declared as a
 * `never`-returning function so call sites narrow like `throw`.
 */
function malformed(detail: string): never {
  throw new Error(`Malformed STEP Part 21: ${detail}`);
}

/**
 * Counts occurrences of the entity type `type` in `text`: the type name at
 * a word boundary followed by an opening parenthesis — the shape every
 * entity reference and instantiation in the grammar shares.
 */
export function countStepEntitiesOfType(text: string, type: string): number {
  const pattern = new RegExp(`\\b${type}\\s*\\(`, "g");
  return (text.match(pattern) ?? []).length;
}

/**
 * Parses `bytes` as a STEP Part 21 document, throwing on structural
 * violations: a missing ISO keyword or terminator, an unreadable header,
 * or duplicate entity ids. `countTypes` names the entity types whose
 * occurrence counts the document carries (structure only — what the counts
 * should be is the assertion's business).
 */
export function readStepPart21(
  bytes: Uint8Array,
  countTypes: readonly string[] = [],
): StepDocument {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  require(/^ISO-10303-21\s*;/.test(
    text,
  ), "the file must open with the ISO-10303-21 keyword.");
  require(text
    .trimEnd()
    .endsWith(
      "END-ISO-10303-21;",
    ), "the file must end with the END-ISO-10303-21 terminator.");
  const headerStart = text.indexOf("HEADER;");
  const headerEnd = text.indexOf("ENDSEC;");
  require(headerStart >= 0 && headerEnd > headerStart, "no header section.");
  const header = text.slice(headerStart, headerEnd);

  const description = header.match(/FILE_DESCRIPTION\(\('([^']*)'/)?.[1];
  if (description === undefined) malformed("no FILE_DESCRIPTION string.");
  const modelName = header.match(/FILE_NAME\('([^']*)'/)?.[1];
  if (modelName === undefined) malformed("no FILE_NAME model name.");
  const timeStamp = header.match(/FILE_NAME\('[^']*','([^']*)'/)?.[1];
  if (timeStamp === undefined) malformed("no FILE_NAME time stamp.");
  // The statement's fifth and sixth strings name the processor and the
  // originator; the trailing triple of quoted strings ends the statement
  // right before FILE_SCHEMA (whitespace-tolerant across OCCT's wrapping).
  const processorAndOriginator = header.match(
    /'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\);\s*FILE_SCHEMA/,
  );
  if (processorAndOriginator === null) {
    malformed("no FILE_NAME processor/originator/version triple.");
  }
  const schema = header.match(/FILE_SCHEMA\(\(\s*'([^']*)'/)?.[1];
  if (schema === undefined) malformed("no FILE_SCHEMA token.");

  // Entity assignments live in the data section; ids must be unique.
  const dataSection = text.slice(headerEnd);
  const seenIds = new Set<string>();
  let maxEntityId = 0;
  for (const match of dataSection.matchAll(/#(\d+)\s*=/g)) {
    const id = match[1];
    if (id === undefined) continue;
    require(!seenIds.has(id), `duplicate entity id #${id}.`);
    seenIds.add(id);
    const numeric = Number(id);
    if (numeric > maxEntityId) maxEntityId = numeric;
  }
  require(seenIds.size > 0, "no entity assignments in the data section.");

  const typeCounts: Record<string, number> = {};
  for (const type of countTypes) {
    typeCounts[type] = countStepEntitiesOfType(text, type);
  }
  return {
    header: {
      description,
      modelName,
      timeStamp,
      processor: processorAndOriginator[1] ?? "",
      originator: processorAndOriginator[2] ?? "",
      schema,
    },
    entityCount: seenIds.size,
    maxEntityId,
    typeCounts,
  };
}
