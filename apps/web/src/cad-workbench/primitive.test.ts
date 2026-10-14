/**
 * The primitive verbs' authoring seam: the plan's pre-commit refusals (the
 * reader's own domain, so a committed primitive always renders), the ONE
 * transaction `primitiveCreateCommands` plans (dimension parameters, body,
 * feature in the bridge layout, the optional move-layout placement), and
 * the round trip through the document scene — each verb authors a feature
 * that renders, a placed primitive renders as its moved body, and repeated
 * verbs mint collision-free ids.
 */

import { describe, expect, it } from "vitest";
import {
  applyTransaction,
  createDocument,
  createDocumentId,
} from "@slopcad/cad-core";
import type { CadDocument } from "@slopcad/cad-core";

import { documentSceneBodies } from "./document-scene";
import {
  isPrimitiveKind,
  PRIMITIVE_DEFAULTS,
  PRIMITIVE_KINDS,
  primitiveCreateCommands,
  type PrimitiveSubmission,
} from "./primitive";
import { highestResolvableScene, honestSceneFallback } from "./scene-fallback";

const DOC = createDocumentId("doc_primitive_verbs");

/** Plans and commits one primitive submission, failing loudly on refusal. */
function commit(
  document: CadDocument,
  submission: PrimitiveSubmission,
): CadDocument {
  const plan = primitiveCreateCommands(document, submission);
  if (!plan.ok) throw new Error(plan.message);
  const applied = applyTransaction(document, { commands: plan.commands });
  if (!applied.ok) throw new Error(applied.error.message);
  return applied.value;
}

/** The scene's rendered bodies as `{ bodyId, kind }` pairs. */
function sceneBodiesOf(
  document: CadDocument,
): readonly { readonly bodyId: string; readonly kind: string }[] {
  return documentSceneBodies(document, new Set(), null)
    .filter((entry) => entry.consumedOnly !== true)
    .map((entry) => ({ bodyId: entry.bodyId, kind: entry.scene.kind }));
}

describe("primitiveCreateCommands: the reader's domain, before any commit", () => {
  it("accepts every kind's defaults and a sharp cone", () => {
    for (const kind of PRIMITIVE_KINDS) {
      expect(
        primitiveCreateCommands(createDocument(DOC), {
          shape: PRIMITIVE_DEFAULTS[kind],
          offsetMm: [0, 0, 0],
        }).ok,
      ).toBe(true);
    }
  });

  it("refuses non-positive extents, a negative cone top, and non-finite offsets", () => {
    const refusals: readonly PrimitiveSubmission[] = [
      {
        shape: { kind: "box", widthMm: 0, depthMm: 1, heightMm: 1 },
        offsetMm: [0, 0, 0],
      },
      { shape: { kind: "sphere", radiusMm: -1 }, offsetMm: [0, 0, 0] },
      {
        shape: { kind: "cylinder", radiusMm: 1, heightMm: Number.NaN },
        offsetMm: [0, 0, 0],
      },
      {
        shape: {
          kind: "cone",
          bottomRadiusMm: 2,
          topRadiusMm: -1,
          heightMm: 1,
        },
        offsetMm: [0, 0, 0],
      },
      {
        shape: { kind: "sphere", radiusMm: 1 },
        offsetMm: [Number.POSITIVE_INFINITY, 0, 0],
      },
    ];
    for (const submission of refusals) {
      const outcome = primitiveCreateCommands(createDocument(DOC), submission);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("kernel/parameter-invalid");
    }
  });
});

describe("primitiveCreateCommands: one atomic transaction per verb", () => {
  it("each kind authors its feature in the bridge layout and renders as a primitive", () => {
    for (const kind of PRIMITIVE_KINDS) {
      const document = commit(createDocument(DOC), {
        shape: PRIMITIVE_DEFAULTS[kind],
        offsetMm: [0, 0, 0],
      });
      const feature = document.features.find((entry) => entry.kind === kind);
      expect(feature?.outputs).toEqual([`body_${kind}`]);
      expect(feature?.inputs.every((ref) => ref.kind === "parameter")).toBe(
        true,
      );
      expect(sceneBodiesOf(document)).toEqual([
        { bodyId: `body_${kind}`, kind: "primitive" },
      ]);
    }
  });

  it("names the dimension parameters after the kind's roles", () => {
    const document = commit(createDocument(DOC), {
      shape: { kind: "cone", bottomRadiusMm: 8, topRadiusMm: 2, heightMm: 12 },
      offsetMm: [0, 0, 0],
    });
    expect(document.parameters.parameters.map((entry) => entry.name)).toEqual([
      "coneBottomRadius",
      "coneTopRadius",
      "coneHeight",
    ]);
  });

  it("a placed primitive renders as its moved body, the primitive absorbed beneath it", () => {
    const document = commit(createDocument(DOC), {
      shape: PRIMITIVE_DEFAULTS.box,
      offsetMm: [30, 0, 5],
    });
    const scene = documentSceneBodies(document, new Set(), null);
    expect(sceneBodiesOf(document)).toEqual([
      { bodyId: "body_box_placed", kind: "moveBody" },
    ]);
    const moved = scene.find((entry) => entry.bodyId === "body_box_placed");
    expect(
      moved?.scene.kind === "moveBody" ? moved.scene.request.offsetMm : null,
    ).toEqual([30, 0, 5]);
  });

  it("a placed primitive on a blank bench keeps the moveBody scene", () => {
    const plan = primitiveCreateCommands(createDocument(DOC), {
      shape: PRIMITIVE_DEFAULTS.box,
      offsetMm: [30, 0, 5],
    });
    expect(plan.ok && plan.placed).toBe(true);
    const document = commit(createDocument(DOC), {
      shape: PRIMITIVE_DEFAULTS.box,
      offsetMm: [30, 0, 5],
    });
    expect(honestSceneFallback(document, "moveBody")).toBeNull();
    expect(highestResolvableScene(document)).toBe("moveBody");
  });

  it("an unplaced primitive on a blank bench keeps the primitive scene", () => {
    const document = commit(createDocument(DOC), {
      shape: PRIMITIVE_DEFAULTS.box,
      offsetMm: [0, 0, 0],
    });
    expect(honestSceneFallback(document, "primitive")).toBeNull();
    expect(honestSceneFallback(document, "moveBody")).toBe("primitive");
  });

  it("repeated verbs mint fresh ids, and EVERY placed primitive renders", () => {
    let document = createDocument(DOC);
    document = commit(document, {
      shape: PRIMITIVE_DEFAULTS.sphere,
      offsetMm: [0, 0, 0],
    });
    document = commit(document, {
      shape: PRIMITIVE_DEFAULTS.sphere,
      offsetMm: [25, 0, 0],
    });
    document = commit(document, {
      shape: PRIMITIVE_DEFAULTS.cylinder,
      offsetMm: [0, 25, 0],
    });
    expect(sceneBodiesOf(document)).toEqual([
      { bodyId: "body_sphere", kind: "primitive" },
      { bodyId: "body_sphere_placed2", kind: "moveBody" },
      { bodyId: "body_cylinder_placed", kind: "moveBody" },
    ]);
  });
});

describe("isPrimitiveKind", () => {
  it("names exactly the four primitive kinds", () => {
    expect(PRIMITIVE_KINDS.filter(isPrimitiveKind)).toEqual(PRIMITIVE_KINDS);
    expect(isPrimitiveKind("extrude")).toBe(false);
  });
});
