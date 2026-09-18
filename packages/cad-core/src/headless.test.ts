/**
 * The Phase 14 domain-independence proof: the CAD core runs headless.
 *
 * Two independent pins, both in the domain's own suite so the guarantee
 * travels with it:
 *
 * 1. **The grep-level guarantee** — no cad-core source file imports React,
 *    any React renderer, Three.js, or any other host/renderer module. The
 *    domain's dependency graph contains nothing a browser must provide.
 * 2. **The headless usage test** — the full Phase 7/12/13 surface (session
 *    commits, history moves, the tool runtime and manager, a tool issuing
 *    its completion from plain event data) executes to completion in a
 *    plain Node test process with no React mounted anywhere.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  applySessionTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createParameterId,
  createSelectionState,
  createSession,
  createToolManager,
  createToolRuntime,
  length,
  measureTool,
  redoSession,
  registerTool,
  undoSession,
  type CadDocument,
  type CadSession,
} from "./index";

// ---------------------------------------------------------------------------
// 1. The grep-level guarantee
// ---------------------------------------------------------------------------

/** Module specifiers that would make the domain host- or renderer-bound. */
const FORBIDDEN_SPECIFIER =
  /from\s+["'](react|react-dom|react-native|three|@react-three\/[^"']+)["']/;

const THIS_DIR = new URL("./", import.meta.url);

describe("cad-core is free of host and renderer imports", () => {
  it("no source file imports React, a React renderer, or Three.js", async () => {
    const entries = await readdir(THIS_DIR);
    const sources = entries.filter(
      (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of sources) {
      const content = await readFile(new URL(file, THIS_DIR), "utf8");
      if (FORBIDDEN_SPECIFIER.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The headless usage test
// ---------------------------------------------------------------------------

const BODY = createBodyId("body_headless");
const WIDTH = createParameterId("param_width");

/** The base document the headless session starts from (substrate-built fixture). */
function headlessBaseDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_headless"));
  const body = addBody(document, { id: BODY, name: "part" });
  if (!body.ok) {
    throw new Error(
      `Headless fixture rejected the body: ${body.error.message}`,
    );
  }
  document = body.value.document;
  const parameter = addDocumentParameter(document, {
    id: WIDTH,
    name: "width",
    value: length(10),
  });
  if (!parameter.ok) {
    throw new Error(
      `Headless fixture rejected the width parameter: ${parameter.error.message}`,
    );
  }
  return parameter.value.document;
}

function requireValue<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `Headless fixture rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

function setWidth(session: CadSession, mm: number): CadSession {
  return requireValue(
    applySessionTransaction(session, {
      commands: [{ type: "parameter.set", id: WIDTH, value: length(mm) }],
    }),
    `the width = ${String(mm)}mm commit`,
  );
}

function widthOf(session: CadSession): number {
  const parameter = session.document.parameters.parameters.find(
    (entry) => entry.id === WIDTH,
  );
  if (parameter === undefined) {
    throw new Error("Headless fixture lost the width parameter.");
  }
  return parameter.value.value;
}

describe("cad-core runs headless end to end", () => {
  it("commits, undoes, and redoes documents with no React mounted", () => {
    let session = createSession(headlessBaseDocument());
    expect(widthOf(session)).toBe(10);

    session = setWidth(session, 12);
    session = setWidth(session, 16);
    expect(widthOf(session)).toBe(16);
    expect(session.history.entries).toHaveLength(2);

    session = requireValue(undoSession(session), "the undo");
    expect(widthOf(session)).toBe(12);

    session = requireValue(redoSession(session), "the redo");
    expect(widthOf(session)).toBe(16);
  });

  it("drives the tool runtime and manager with plain event data", () => {
    const session = setWidth(createSession(headlessBaseDocument()), 12);
    const issued: number[] = [];
    const runtime = createToolRuntime({
      session,
      selection: createSelectionState(0),
      onTransaction: (transaction) => {
        for (const command of transaction.commands) {
          if (command.type === "parameter.set") {
            issued.push(command.value.value);
          }
        }
      },
    });
    const manager = createToolManager({
      tools: [registerTool(measureTool)],
      context: runtime,
    });

    manager.activate("measure");
    const pick = (point: readonly [number, number, number]) => {
      manager.dispatch({
        type: "pointer-up",
        point: [...point],
        pick: {
          reference: { kind: "body", bodyId: BODY },
          renderObjectId: "rend_headless",
        },
        modifiers: { shift: false, alt: false, ctrl: false, meta: false },
      });
    };
    pick([0, 0, 0]);
    pick([3, 4, 0]);

    expect(manager.phase).toBe("completed");
    expect(manager.completion?.detail.kind).toBe("measurement");
    if (manager.completion?.detail.kind === "measurement") {
      expect(manager.completion.detail.distance.unit).toBe("mm");
      expect(manager.completion.detail.distance.value).toBe(5);
    }
    // No transaction was issued: measure is a pure pick-pair computation.
    expect(issued).toEqual([]);
    // The runtime still exposes the session the React mirror would read.
    expect(runtime.session.document.parameters.parameters[0]?.value.value).toBe(
      12,
    );
  });
});
