/**
 * Shared test support for the cad-react suites: a small deterministic
 * session (one body, one length parameter) and a store factory over it.
 * Test-only — never imported by production modules.
 */

import {
  addBody,
  addDocumentParameter,
  createBodyId,
  createDocument,
  createDocumentId,
  createParameterId,
  createSession,
  length,
  measureTool,
  registerTool,
  selectTool,
  type BodyId,
  type CadDocument,
  type CadSession,
  type ParameterId,
} from "@slopcad/cad-core";

import { createCadStore, type CadStore, type CadStoreOptions } from "./store";

/** The test document's body id. */
export const TEST_BODY_ID: BodyId = createBodyId("body_plate");

/** The test document's width parameter id. */
export const TEST_WIDTH_PARAMETER: ParameterId = createParameterId(
  "param_width",
);

interface DocumentResult {
  readonly ok: boolean;
  readonly value?: { readonly document: CadDocument };
  readonly error?: { readonly message: string };
}

function requireDocumentOk(result: DocumentResult, what: string): CadDocument {
  if (!result.ok || result.value === undefined) {
    throw new Error(
      `Test document rejected ${what}: ${String(result.error?.message)}`,
    );
  }
  return result.value.document;
}

/**
 * Builds the test session: body `body_plate` and parameter `width = 10mm`,
 * no features. Deterministic (explicit ids).
 */
export function createTestSession(): CadSession {
  let document = createDocument(createDocumentId("doc_test"));
  document = requireDocumentOk(
    addBody(document, { id: TEST_BODY_ID, name: "plate" }),
    "the body",
  );
  document = requireDocumentOk(
    addDocumentParameter(document, {
      id: TEST_WIDTH_PARAMETER,
      name: "width",
      value: length(10),
    }),
    "the width parameter",
  );
  return createSession(document);
}

/** Creates a store over a fresh test session with select + measure armed in the registry. */
export function createTestStore(
  overrides: Partial<CadStoreOptions> = {},
): CadStore {
  return createCadStore({
    session: overrides.session ?? createTestSession(),
    tools: overrides.tools ?? [
      registerTool(selectTool),
      registerTool(measureTool),
    ],
    ...(overrides.projection !== undefined ? { projection: overrides.projection } : {}),
    ...(overrides.onTransaction !== undefined
      ? { onTransaction: overrides.onTransaction }
      : {}),
  });
}
