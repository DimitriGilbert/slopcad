/**
 * The Phase 44 body-management substrate tests: the display flags on body
 * records (visibility/isolation), the partial `body.update` command, the
 * additive native-format growth (a flagless document reserializes
 * BYTE-IDENTICALLY — the resave law — and a flagged document round-trips
 * through the substrate parse), and the renderer projection filter's
 * keep rule (hidden bodies drop; isolation is the exclusive focus mode;
 * a flagless world changes nothing).
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  applyCommand,
  bodyRendersInProjection,
  createBodyId,
  createDocument,
  createDocumentId,
  createRenderObjectId,
  filterProjectionByBodyDisplay,
  parseCadDocument,
  parseCommand,
  serializeCadDocument,
  serializeCommand,
  type Body,
  type BodyId,
} from "./index";

const bPlate = createBodyId("body_display_plate");
const bBoss = createBodyId("body_display_boss");
const bGhost = createBodyId("body_display_ghost");

/** A fresh document carrying the three fixture bodies. */
function documentWithBodies(): ReturnType<typeof createDocument> {
  let document = createDocument(createDocumentId("doc_body_display"));
  for (const body of [
    { id: bPlate, name: "plate" },
    { id: bBoss, name: "boss" },
    { id: bGhost, name: "ghost" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

describe("body display flags: updateBody and the body.update command", () => {
  it("renames without touching the flags, and toggles flags without touching the name", () => {
    let document = documentWithBodies();
    const hidden = applyCommand(document, {
      type: "body.update",
      id: bGhost,
      visible: false,
    });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;
    document = hidden.value;
    const ghost = document.bodies.find((body) => body.id === bGhost);
    expect(ghost?.name).toBe("ghost");
    expect(ghost?.visible).toBe(false);
    expect(ghost?.isolated).toBeUndefined();
    const renamed = applyCommand(document, {
      type: "body.update",
      id: bGhost,
      name: "spectre",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const after = renamed.value.bodies.find((body) => body.id === bGhost);
    expect(after?.name).toBe("spectre");
    expect(after?.visible).toBe(false);
  });

  it("isolates through the same command and refuses an empty update structured", () => {
    const document = documentWithBodies();
    const isolated = applyCommand(document, {
      type: "body.update",
      id: bBoss,
      isolated: true,
    });
    expect(isolated.ok).toBe(true);
    if (!isolated.ok) return;
    expect(
      isolated.value.bodies.find((body) => body.id === bBoss)?.isolated,
    ).toBe(true);
    const empty = applyCommand(document, {
      type: "body.update",
      id: bBoss,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.message).toContain("at least one");
  });

  it("round-trips the command through its canonical wire form", () => {
    const command = {
      type: "body.update" as const,
      id: bGhost,
      visible: false,
      isolated: true,
    };
    const serialized = serializeCommand(command);
    expect(serialiatedRoundTrip(serialized)).toEqual({
      ok: true,
      value: command,
    });
  });

  it("refuses a smuggled non-boolean flag on the wire", () => {
    expect(
      serialiatedRoundTrip({
        formatVersion: 1,
        type: "body.update",
        id: bGhost,
        visible: "hidden",
      }).ok,
    ).toBe(false);
  });
});

/** Parses a serialized command (test-local naming to keep it terse). */
function serialiatedRoundTrip(input: unknown) {
  return parseCommand(input);
}

describe("body display flags: the additive native growth", () => {
  it("serializes a flagless document byte-identically to the pre-flag form", () => {
    const document = documentWithBodies();
    const serialized = serializeCadDocument(document);
    expect(serialized.bodies.every((body) => body.visible === undefined)).toBe(
      true,
    );
    // The pre-flag shape: id and name only, in that order.
    for (const body of serialized.bodies) {
      expect(Object.keys(body)).toEqual(["id", "name"]);
    }
    const parsedOnce = parseCadDocument(serialized);
    expect(parsedOnce.ok).toBe(true);
    if (!parsedOnce.ok) return;
    const reserialized = serializeCadDocument(parsedOnce.value);
    expect(reserialized).toEqual(serialized);
  });

  it("emits the flags only when non-default and round-trips them", () => {
    let document = documentWithBodies();
    const hidden = applyCommand(document, {
      type: "body.update",
      id: bGhost,
      visible: false,
    });
    if (!hidden.ok) throw new Error(hidden.error.message);
    const isolated = applyCommand(hidden.value, {
      type: "body.update",
      id: bBoss,
      isolated: true,
    });
    if (!isolated.ok) throw new Error(isolated.error.message);
    document = isolated.value;
    const serialized = serializeCadDocument(document);
    expect(serialized.bodies.find((body) => body.id === bGhost)?.visible).toBe(
      false,
    );
    expect(serialized.bodies.find((body) => body.id === bBoss)?.isolated).toBe(
      true,
    );
    expect(
      serialized.bodies.find((body) => body.id === bPlate)?.visible,
    ).toBeUndefined();
    const parsed = parseCadDocument(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const round = serializeCadDocument(parsed.value);
    expect(round).toEqual(serialized);
    const body = (id: BodyId): Body | undefined =>
      parsed.value.bodies.find((candidate) => candidate.id === id);
    expect(body(bGhost)?.visible).toBe(false);
    expect(body(bBoss)?.isolated).toBe(true);
    expect(body(bPlate)?.visible).toBeUndefined();
  });

  it("refuses a non-boolean flag in the substrate parse", () => {
    const document = documentWithBodies();
    const serialized = serializeCadDocument(document);
    const corrupted = {
      ...serialized,
      bodies: serialized.bodies.map((body, index) =>
        index === 0 ? { ...body, visible: 1 } : body,
      ),
    };
    const parsed = parseCadDocument(corrupted);
    expect(parsed.ok).toBe(false);
  });
});

describe("the renderer projection filter's keep rule", () => {
  it("keeps everything when no flag exists (the default changes nothing)", () => {
    const flags = new Map<BodyId, Pick<Body, "visible" | "isolated">>();
    expect(bodyRendersInProjection(flags, bPlate, false)).toBe(true);
    expect(bodyRendersInProjection(undefined, bPlate, false)).toBe(true);
  });

  it("drops hidden bodies and keeps the isolation focus exclusive", () => {
    const flags = new Map<BodyId, Pick<Body, "visible" | "isolated">>([
      [bGhost, { visible: false }],
      [bBoss, { isolated: true }],
    ]);
    expect(bodyRendersInProjection(flags, bGhost, true)).toBe(false);
    expect(bodyRendersInProjection(flags, bBoss, true)).toBe(true);
    // Isolation is exclusive: the visible-not-isolated plate drops while
    // the boss is isolated.
    expect(bodyRendersInProjection(flags, bPlate, true)).toBe(false);
    // Without any isolation, the plate renders and the ghost stays hidden.
    expect(bodyRendersInProjection(flags, bPlate, false)).toBe(true);
    expect(bodyRendersInProjection(flags, bGhost, false)).toBe(false);
  });

  it("filters a projection's objects without touching the camera", () => {
    const camera = {
      kind: "perspective" as const,
      position: [10, 10, 10] as const,
      target: [0, 0, 0] as const,
      up: [0, 0, 1] as const,
      fovDeg: 45,
    };
    const makeObject = (bodyId: BodyId) => ({
      id: createRenderObjectId(bodyId),
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0] as const, max: [1, 1, 0] as const },
      bodyId,
    });
    const projection = {
      objects: [makeObject(bPlate), makeObject(bBoss), makeObject(bGhost)],
      camera,
    };
    const flags = new Map<BodyId, Pick<Body, "visible" | "isolated">>([
      [bGhost, { visible: false }],
      [bBoss, { isolated: true }],
    ]);
    const filtered = filterProjectionByBodyDisplay(projection, flags);
    expect(filtered.objects.map((object) => object.bodyId)).toEqual([bBoss]);
    expect(filtered.camera).toBe(camera);
  });
});
