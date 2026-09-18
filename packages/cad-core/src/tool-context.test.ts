/**
 * Unit tests for the Phase 13 tool context and its reference headless
 * runtime: atomic command issuance with the transaction log hook, selection
 * operations applied through the pure Phase 12 model, projection access,
 * and the regeneration advance. No DOM, no renderer — the runtime IS the
 * host.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  createDocument,
  type CadDocument,
} from "./document";
import { length, valueIn } from "./dimensional";
import {
  type BodyId,
  createBodyId,
  createDocumentId,
  createParameterId,
  type ParameterId,
} from "./ids";
import { createSelectionState } from "./selection";
import { createSession } from "./session";
import { serializeTransaction } from "./transaction";
import { CAD_DOCUMENT_FORMAT_VERSION } from "./version";
import { createToolRuntime } from "./tool-context";

const BODY: BodyId = createBodyId("body_test");
const PARAMETER: ParameterId = createParameterId("param_length");

function buildSession() {
  let document: CadDocument = createDocument(
    createDocumentId("doc_tool_context_test"),
  );
  const body = addBody(document, { id: BODY, name: "test" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const parameter = addDocumentParameter(document, {
    id: PARAMETER,
    name: "length",
    value: length(1),
  });
  if (!parameter.ok) throw new Error(parameter.error.message);
  document = parameter.value.document;
  return createSession(document);
}

describe("tool context runtime", () => {
  it("issues transactions atomically and logs their canonical serializations", () => {
    const issued: string[] = [];
    const runtime = createToolRuntime({
      session: buildSession(),
      selection: createSelectionState(0),
      onTransaction: (transaction) => {
        issued.push(JSON.stringify(transaction));
      },
    });
    const applied = runtime.issue({
      commands: [
        { type: "parameter.set", id: PARAMETER, value: length(4, "cm") },
      ],
    });
    expect(applied.ok).toBe(true);
    const stored = runtime.session.document.parameters.parameters.find(
      (parameter) => parameter.id === PARAMETER,
    );
    // The command stores the value it carries (unit preserved); the stored
    // quantity equals 40 canonical mm.
    expect(stored?.value).toEqual(length(4, "cm"));
    expect(valueIn(stored?.value ?? length(0), "mm")).toBe(40);
    expect(issued).toEqual([
      JSON.stringify(
        serializeTransaction({
          commands: [
            { type: "parameter.set", id: PARAMETER, value: length(4, "cm") },
          ],
        }),
      ),
    ]);
    const logged: unknown = JSON.parse(issued[0] ?? "null");
    expect(logged).toEqual({
      formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
      commands: [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          type: "parameter.set",
          id: "param_length",
          value: { dimension: "length", unit: "mm", value: 40 },
        },
      ],
    });
  });

  it("leaves the session untouched and logs nothing when a command fails", () => {
    const issued: string[] = [];
    const runtime = createToolRuntime({
      session: buildSession(),
      selection: createSelectionState(0),
      onTransaction: (transaction) => {
        issued.push(JSON.stringify(transaction));
      },
    });
    const before = runtime.session;
    const applied = runtime.issue({
      commands: [
        {
          type: "parameter.set",
          id: createParameterId("param_missing"),
          value: length(1),
        },
      ],
    });
    expect(applied.ok).toBe(false);
    expect(runtime.session).toBe(before);
    expect(issued).toEqual([]);
  });

  it("applies pick, hover, and clear operations through the pure selection model", () => {
    const runtime = createToolRuntime({
      session: buildSession(),
      selection: createSelectionState(2),
    });
    const bodyRef = { kind: "body" as const, bodyId: BODY };
    const picked = runtime.applySelection({
      type: "pick",
      reference: bodyRef,
      additive: false,
    });
    expect(picked.ok).toBe(true);
    expect(runtime.selection.selected).toEqual([bodyRef]);
    const otherRef = { kind: "solid" as const, bodyId: BODY };
    const toggled = runtime.applySelection({
      type: "pick",
      reference: otherRef,
      additive: true,
    });
    expect(toggled.ok).toBe(true);
    expect(runtime.selection.selected).toEqual([bodyRef, otherRef]);
    const hovered = runtime.applySelection({
      type: "hover",
      reference: otherRef,
    });
    expect(hovered.ok).toBe(true);
    expect(runtime.selection.hover).toEqual(otherRef);
    const cleared = runtime.applySelection({ type: "clear" });
    expect(cleared.ok).toBe(true);
    expect(runtime.selection.selected).toEqual([]);
    expect(runtime.selection.hover).toEqual(otherRef);
  });

  it("rejects stale synthetic references without touching the state", () => {
    const runtime = createToolRuntime({
      session: buildSession(),
      selection: createSelectionState(5),
    });
    const before = runtime.selection;
    const stale = runtime.applySelection({
      type: "pick",
      reference: {
        kind: "face",
        bodyId: BODY,
        regeneration: 4,
        faceIndex: 0,
      },
      additive: false,
    });
    expect(stale.ok).toBe(false);
    expect(runtime.selection).toBe(before);
  });

  it("advances the selection regeneration and drops synthetic references", () => {
    const runtime = createToolRuntime({
      session: buildSession(),
      selection: createSelectionState(1),
    });
    const faceRef = {
      kind: "face" as const,
      bodyId: BODY,
      regeneration: 1,
      faceIndex: 7,
    };
    const picked = runtime.applySelection({
      type: "pick",
      reference: faceRef,
      additive: false,
    });
    expect(picked.ok).toBe(true);
    expect(runtime.selection.selected).toEqual([faceRef]);
    const advanced = runtime.beginSelectionRegeneration(2);
    expect(advanced.ok).toBe(true);
    expect(runtime.selection.regeneration).toBe(2);
    expect(runtime.selection.selected).toEqual([]);
  });

  it("exposes and replaces the projection and session", () => {
    const runtime = createToolRuntime({
      session: buildSession(),
      selection: createSelectionState(0),
    });
    expect(runtime.projection).toBeNull();
    runtime.setProjection(null);
    expect(runtime.projection).toBeNull();
    const nextSession = buildSession();
    runtime.setSession(nextSession);
    expect(runtime.session).toBe(nextSession);
  });
});
