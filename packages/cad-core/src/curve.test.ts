import { describe, expect, it } from "vitest";

import { angle, length } from "./dimensional";
import {
  type SerializedCurve,
  curveRecordProblems,
  helixCurvePayload,
  parseSerializedCurve,
} from "./curve";
import { createCurveId, createDocumentId } from "./ids";
import {
  addDocumentCurve,
  addFeature,
  createDocument,
  getDocumentCurve,
  removeDocumentCurve,
  serializeCadDocument,
} from "./document";
import { parseCadDocument } from "./document";
import { applyCommand, parseCommand, serializeCommand } from "./command";
import { CAD_DOCUMENT_FORMAT_VERSION } from "./version";

const spline: SerializedCurve = {
  kind: "interpolated-spline",
  points: [
    [0, 0, 0],
    [10, 0, 10],
    [20, 5, 20],
  ],
};

const helix = helixCurvePayload({
  radius: length(6, "mm"),
  pitch: length(4, "mm"),
  turns: 2.5,
  handedness: 1,
  startAngle: angle(0, "deg"),
});

const equation: SerializedCurve = {
  kind: "equation",
  tMin: 0,
  tMax: 1,
  x: "10mm * t",
  y: "0mm",
  z: "10mm * (1 - t)",
};

describe("parseSerializedCurve", () => {
  it("parses each kind and rejects unknown kinds", () => {
    expect(parseSerializedCurve(spline).ok).toBe(true);
    expect(parseSerializedCurve(helix).ok).toBe(true);
    expect(parseSerializedCurve(equation).ok).toBe(true);
    const unknown = parseSerializedCurve({ kind: "nurb" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("curve/unknown-kind");
  });

  it("rejects splines with too few points", () => {
    const outcome = parseSerializedCurve({
      kind: "control-spline",
      points: [[1, 2, 3]],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("curve/invalid-points");
  });

  it("rejects an empty parameter range and unparseable expressions", () => {
    const emptyRange = parseSerializedCurve({
      kind: "equation",
      tMin: 1,
      tMax: 1,
      x: "1mm",
      y: "1mm",
      z: "1mm",
    });
    expect(emptyRange.ok).toBe(false);
    if (!emptyRange.ok) {
      expect(emptyRange.error.code).toBe("curve/invalid-parameter-range");
    }
    const unparseable = parseSerializedCurve({
      kind: "equation",
      tMin: 0,
      tMax: 1,
      x: "10mm *? t",
      y: "0mm",
      z: "0mm",
    });
    expect(unparseable.ok).toBe(false);
    if (!unparseable.ok) {
      expect(unparseable.error.code).toBe("curve/invalid-expression-source");
    }
  });

  it("rejects a dimensionless coordinate expression at the battery", () => {
    const parsed = parseSerializedCurve({
      kind: "equation",
      tMin: 0,
      tMax: 1,
      x: "2 + 2",
      y: "0mm",
      z: "0mm",
    });
    if (!parsed.ok) {
      throw new Error("the battery witness must parse");
    }
    expect(
      curveRecordProblems(parsed.value).map((problem) => problem.code),
    ).toContain("curve/expression-not-length");
  });

  it("rejects the degenerate helices the Phase 40 battery owns", () => {
    const circle = helixCurvePayload({
      radius: length(5, "mm"),
      pitch: length(0, "mm"),
      turns: 1,
      handedness: 1,
      startAngle: angle(0, "deg"),
    });
    expect(curveRecordProblems(circle).length).toBeGreaterThan(0);
    const coneTip = helixCurvePayload({
      radius: length(2, "mm"),
      pitch: length(3, "mm"),
      turns: 1,
      handedness: -1,
      startAngle: angle(0, "deg"),
      taper: length(-3, "mm"),
    });
    expect(curveRecordProblems(coneTip).length).toBeGreaterThan(0);
  });

  it("accepts the flat spiral (zero pitch, non-zero taper)", () => {
    const spiral = helixCurvePayload({
      radius: length(5, "mm"),
      pitch: length(0, "mm"),
      turns: 2,
      handedness: 1,
      startAngle: angle(0, "deg"),
      taper: length(-3, "mm"),
    });
    expect(curveRecordProblems(spiral)).toEqual([]);
  });

  it("rejects coincident spline points at the battery", () => {
    const parsed = parseSerializedCurve({
      kind: "interpolated-spline",
      points: [
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    if (!parsed.ok) {
      throw new Error("the battery witness must parse");
    }
    expect(curveRecordProblems(parsed.value).length).toBeGreaterThan(0);
  });
});

describe("document curve records", () => {
  it("adds, gets, and removes a curve with a generated id", () => {
    const document = createDocument(createDocumentId("doc_root"));
    const added = addDocumentCurve(document, { name: "guide", curve: spline });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const withCurve = added.value.document;
    expect(getDocumentCurve(withCurve, added.value.curve.id)?.name).toBe(
      "guide",
    );
    const removed = removeDocumentCurve(withCurve, added.value.curve.id);
    expect(removed.ok).toBe(true);
  });

  it("refuses removal while a feature references the curve", () => {
    const document = createDocument(createDocumentId("doc_root"));
    const added = addDocumentCurve(document, { name: "spine", curve: helix });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const withFeature = addFeature(added.value.document, {
      kind: "sweep-wire",
      inputs: [{ kind: "curve", id: added.value.curve.id }],
      outputs: [],
    });
    expect(withFeature.ok).toBe(true);
    if (!withFeature.ok) return;
    const blocked = removeDocumentCurve(
      withFeature.value.document,
      added.value.curve.id,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("document/in-use");
  });

  it("round-trips curves through serialization byte-identically", () => {
    const document = createDocument(createDocumentId("doc_root"));
    const withSpline = addDocumentCurve(document, { name: "a", curve: spline });
    expect(withSpline.ok).toBe(true);
    if (!withSpline.ok) return;
    const withEquation = addDocumentCurve(withSpline.value.document, {
      name: "b",
      curve: equation,
    });
    expect(withEquation.ok).toBe(true);
    if (!withEquation.ok) return;
    const serialized = serializeCadDocument(withEquation.value.document);
    expect(serialized.curves?.length).toBe(2);
    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serialized)) as Parameters<
        typeof parseCadDocument
      >[0],
    );
    expect(revived.ok).toBe(true);
    if (revived.ok) {
      expect(serializeCadDocument(revived.value)).toEqual(serialized);
    }
  });

  it("serializes curve-free documents without a curves key (additive)", () => {
    const document = createDocument(createDocumentId("doc_root"));
    expect("curves" in serializeCadDocument(document)).toBe(false);
  });

  it("rejects a curve record whose payload fails the battery", () => {
    const document = createDocument(createDocumentId("doc_root"));
    const added = addDocumentCurve(document, {
      name: "bad",
      curve: {
        kind: "helix",
        radius: { dimension: "length", unit: "mm", value: -1 },
        pitch: { dimension: "length", unit: "mm", value: 0 },
        turns: 1,
        handedness: 1,
        startAngle: { dimension: "angle", unit: "rad", value: 0 },
      },
    });
    expect(added.ok).toBe(false);
    if (!added.ok) {
      expect(added.error.code).toBe("document/curve-payload-invalid");
    }
  });
});

describe("the curve.create command", () => {
  it("applies, serializes, and parses like every command (the datum.create seam)", () => {
    const command = {
      type: "curve.create",
      id: createCurveId("crv_spine-guide"),
      name: "spine guide",
      curve: spline,
    } as const;
    const applied = applyCommand(
      createDocument(createDocumentId("doc_cmd")),
      command,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.curves).toHaveLength(1);
    expect(applied.value.curves[0]?.name).toBe("spine guide");

    const serialized = serializeCommand(command);
    expect(serialized.type).toBe("curve.create");
    const parsed = parseCommand(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(command);
  });

  it("rejects an unparsable curve payload at the parse boundary", () => {
    const parsed = parseCommand({
      formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
      type: "curve.create",
      name: "bad",
      curve: { kind: "helix" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("command/malformed");
    }
  });
});
