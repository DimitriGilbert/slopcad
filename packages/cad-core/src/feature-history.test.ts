import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  documentChangeInvalidations,
  DOCUMENT_ERROR_CODES,
  FEATURE_HISTORY_ERROR_CODES,
  FEATURE_REGENERATION_STATES,
  FEATURE_TIMELINE_STATUSES,
  featureTimeline,
  initialRegenerationStates,
  type CadDocument,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  type FeatureRollbackPoint,
  parseFeatureRollbackShape,
  regenerate,
  reorderFeatureRecords,
  rollbackZoneBoundary,
  serializeRegenerationStates,
  updateFeature,
  updateParameterValue,
} from "./index";

const pWidth = createParameterId("param_width");
const bBase = createBodyId("body_base");

const fFirst = createFeatureId("feat_first");
const fSecond = createFeatureId("feat_second");
const fThird = createFeatureId("feat_third");
const fFree = createFeatureId("feat_free");

function feature(
  id: FeatureId,
  inputs: readonly FeatureInputRef[] = [],
): FeatureRecord {
  return { id, kind: "solid", inputs, outputs: [] };
}

/** The chain fixture: width → first → second → third (backward references). */
const chain: readonly FeatureRecord[] = [
  feature(fFirst, [{ kind: "parameter", id: pWidth }]),
  feature(fSecond, [{ kind: "feature", id: fFirst }]),
  feature(fThird, [{ kind: "feature", id: fSecond }]),
];

/**
 * The chain plus one independent (input-less) feature: a pure linear chain
 * admits no legal non-identity reorder (every member is another member's
 * input, directly or transitively), so legal-move tests need a feature that
 * can move freely.
 */
const chainWithFree: readonly FeatureRecord[] = [...chain, feature(fFree)];

function unwrap<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what} rejected: ${result.error.message}`);
  return result.value;
}

function boundaryOf(
  features: readonly FeatureRecord[],
  rollback: FeatureRollbackPoint | null,
): number {
  const boundary = rollbackZoneBoundary(features, rollback);
  if (!boundary.ok) throw new Error(boundary.error.message);
  return boundary.value;
}

describe("FEATURE_TIMELINE_STATUSES derivation", () => {
  it("extends the Phase 6.3 states with exactly the parking status", () => {
    expect(
      FEATURE_TIMELINE_STATUSES.slice(0, FEATURE_REGENERATION_STATES.length),
    ).toEqual(FEATURE_REGENERATION_STATES);
    expect(FEATURE_TIMELINE_STATUSES).toHaveLength(
      FEATURE_REGENERATION_STATES.length + 1,
    );
    expect(FEATURE_TIMELINE_STATUSES[FEATURE_TIMELINE_STATUSES.length - 1]).toBe(
      "beyond-rollback",
    );
  });
});

describe("rollbackZoneBoundary", () => {
  it("counts the whole list without a marker", () => {
    expect(boundaryOf(chain, null)).toBe(3);
  });

  it("places a start marker before the first feature", () => {
    expect(boundaryOf(chain, { afterFeatureId: null })).toBe(0);
  });

  it("places the marker immediately after its anchor", () => {
    expect(boundaryOf(chain, { afterFeatureId: fSecond })).toBe(2);
  });

  it("rejects an anchor the list does not have", () => {
    const boundary = rollbackZoneBoundary(chain, {
      afterFeatureId: createFeatureId("feat_ghost"),
    });
    expect(boundary.ok).toBe(false);
    if (boundary.ok) throw new Error("expected a rejection");
    expect(boundary.error.code).toBe(
      FEATURE_HISTORY_ERROR_CODES.rollbackUnknownFeature,
    );
  });
});

describe("reorderFeatureRecords", () => {
  it("moves a feature to immediately after the anchor, preserving other order", () => {
    const moved = reorderFeatureRecords(chainWithFree, fFree, fFirst);
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.value.map((entry) => entry.id)).toEqual([
        fFirst,
        fFree,
        fSecond,
        fThird,
      ]);
    }
  });

  it("moves a feature to the front with a null anchor", () => {
    const moved = reorderFeatureRecords(chainWithFree, fFree, null);
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.value.map((entry) => entry.id)).toEqual([
        fFree,
        fFirst,
        fSecond,
        fThird,
      ]);
    }
  });

  it("keeps record identities, so states keyed by id survive a legal move", () => {
    const moved = reorderFeatureRecords(chainWithFree, fFree, fFirst);
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error("expected a legal move");
    for (const record of moved.value) {
      expect(chainWithFree).toContain(record);
    }
  });

  it("rejects a move before one of the moved feature's own inputs", () => {
    const moved = reorderFeatureRecords(chain, fThird, null);
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("expected an order rejection");
    expect(moved.error.code).toBe(FEATURE_HISTORY_ERROR_CODES.orderInvalid);
    expect(moved.error.message).toContain("feat_third");
  });

  it("rejects a move after a consumer of the moved feature", () => {
    const moved = reorderFeatureRecords(chain, fFirst, fThird);
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("expected an order rejection");
    expect(moved.error.code).toBe(FEATURE_HISTORY_ERROR_CODES.orderInvalid);
    expect(moved.error.message).toContain("feat_second");
  });

  it("rejects unknown features and invalid anchors, structurally", () => {
    const unknown = reorderFeatureRecords(
      chain,
      createFeatureId("feat_ghost"),
      null,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe(
        FEATURE_HISTORY_ERROR_CODES.reorderUnknownFeature,
      );
    }
    const selfAnchor = reorderFeatureRecords(chain, fSecond, fSecond);
    expect(selfAnchor.ok).toBe(false);
    if (!selfAnchor.ok) {
      expect(selfAnchor.error.code).toBe(
        FEATURE_HISTORY_ERROR_CODES.reorderAnchorInvalid,
      );
    }
    const ghostAnchor = reorderFeatureRecords(
      chain,
      fSecond,
      createFeatureId("feat_ghost"),
    );
    expect(ghostAnchor.ok).toBe(false);
    if (!ghostAnchor.ok) {
      expect(ghostAnchor.error.code).toBe(
        FEATURE_HISTORY_ERROR_CODES.reorderAnchorInvalid,
      );
    }
  });

  it("never modifies the input list", () => {
    const snapshot = [...chain];
    reorderFeatureRecords(chain, fSecond, null);
    expect(chain).toEqual(snapshot);
  });
});

describe("featureTimeline", () => {
  it("joins states in document order when no marker and no suppression apply", () => {
    const timeline = featureTimeline({
      features: chain,
      states: initialRegenerationStates(chain),
      rollback: null,
      suppressed: [],
    });
    if (!timeline.ok) throw new Error("expected a timeline");
    expect(timeline.value.map((entry) => entry.id)).toEqual([
      fFirst,
      fSecond,
      fThird,
    ]);
    expect(timeline.value.map((entry) => entry.status)).toEqual([
      "stale",
      "stale",
      "stale",
    ]);
  });

  it("marks features beyond the marker beyond-rollback, whatever their state", () => {
    const run = regenerate({
      features: chain,
      states: initialRegenerationStates(chain),
      suppressed: [],
      execute: () => ({ ok: true }),
      rollbackPoint: { afterFeatureId: fFirst },
    });
    if (!run.ok) throw new Error(run.error.message);
    const timeline = featureTimeline({
      features: chain,
      states: unwrap(run, "the rolled-back run").states,
      rollback: { afterFeatureId: fFirst },
      suppressed: [],
    });
    if (!timeline.ok) throw new Error(timeline.error.message);
    expect(timeline.value.map((entry) => entry.status)).toEqual([
      "valid",
      "beyond-rollback",
      "beyond-rollback",
    ]);
  });

  it("lets suppression win over parking", () => {
    const timeline = featureTimeline({
      features: chain,
      states: initialRegenerationStates(chain),
      rollback: { afterFeatureId: null },
      suppressed: [fSecond],
    });
    if (!timeline.ok) throw new Error(timeline.error.message);
    expect(timeline.value.map((entry) => entry.status)).toEqual([
      "beyond-rollback",
      "suppressed",
      "beyond-rollback",
    ]);
  });

  it("carries the failed state's diagnostics in the joined view", () => {
    const failed = new Map(initialRegenerationStates(chain));
    failed.set(fSecond, {
      state: "failed",
      diagnostics: [
        {
          severity: "error",
          code: "kernel/operation-failed",
          message: "rebuild refused",
          location: { primary: fSecond, related: [bBase] },
        },
      ],
    });
    const timeline = featureTimeline({
      features: chain,
      states: failed,
      rollback: null,
      suppressed: [],
    });
    if (!timeline.ok) throw new Error(timeline.error.message);
    const entry = timeline.value.find((candidate) => candidate.id === fSecond);
    expect(entry?.status).toBe("failed");
    expect(entry?.diagnostics).toEqual([
      {
        severity: "error",
        code: "kernel/operation-failed",
        message: "rebuild refused",
        primary: fSecond,
      },
    ]);
  });

  it("treats missing state entries as stale and rejects an unknown marker anchor", () => {
    const empty = featureTimeline({
      features: chain,
      states: new Map(),
      rollback: null,
      suppressed: [],
    });
    if (!empty.ok) throw new Error(empty.error.message);
    for (const entry of empty.value) {
      expect(entry.status).toBe("stale");
    }
    const ghost = featureTimeline({
      features: chain,
      states: initialRegenerationStates(chain),
      rollback: { afterFeatureId: createFeatureId("feat_ghost") },
      suppressed: [],
    });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) {
      expect(ghost.error.code).toBe(
        FEATURE_HISTORY_ERROR_CODES.rollbackUnknownFeature,
      );
    }
  });
});

function buildDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_history"));
  const withBody = addBody(document, { id: bBase, name: "base" });
  if (!withBody.ok) throw new Error(withBody.error.message);
  document = withBody.value.document;
  const withParameter = addDocumentParameter(document, {
    id: pWidth,
    name: "width",
    value: { dimension: "length", unit: "mm", value: 10 },
  });
  if (!withParameter.ok) throw new Error(withParameter.error.message);
  document = withParameter.value.document;
  for (const record of chain) {
    const added = addFeature(document, record);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

describe("documentChangeInvalidations", () => {
  it("returns the changed parameter node when a value is set", () => {
    const before = buildDocument();
    const updated = updateParameterValue(before.parameters, pWidth, {
      dimension: "length",
      unit: "mm",
      value: 12,
    });
    if (!updated.ok) throw new Error(updated.error.message);
    expect(
      documentChangeInvalidations(before, { ...before, parameters: updated.value }),
    ).toEqual([pWidth]);
  });

  it("returns the changed feature node when a record is replaced", () => {
    const before = buildDocument();
    const updated = updateFeature(before, fSecond, {
      kind: "solid",
      inputs: [{ kind: "feature", id: fFirst }, { kind: "body", id: bBase }],
      outputs: [],
    });
    if (!updated.ok) throw new Error(updated.error.message);
    expect(documentChangeInvalidations(before, updated.value.document)).toEqual([
      fSecond,
    ]);
  });

  it("returns no nodes for a pure reorder", () => {
    const before = buildDocument();
    const withFree = addFeature(before, feature(fFree));
    if (!withFree.ok) throw new Error(withFree.error.message);
    const moved = reorderFeatureRecords(
      withFree.value.document.features,
      fFree,
      null,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error("expected a legal move");
    expect(
      documentChangeInvalidations(withFree.value.document, {
        ...withFree.value.document,
        features: moved.value,
      }),
    ).toEqual([]);
  });

  it("reports added and removed feature ids", () => {
    const before = buildDocument();
    const withExtra = addFeature(before, feature(createFeatureId("feat_extra")));
    if (!withExtra.ok) throw new Error(withExtra.error.message);
    expect(documentChangeInvalidations(before, withExtra.value.document)).toEqual([
      createFeatureId("feat_extra"),
    ]);
    const trimmed = {
      ...before,
      features: before.features.filter((entry) => entry.id !== fThird),
    };
    expect(documentChangeInvalidations(before, trimmed)).toEqual([fThird]);
  });

  it("returns an empty list for identical documents", () => {
    const before = buildDocument();
    expect(documentChangeInvalidations(before, before)).toEqual([]);
  });
});

describe("parseFeatureRollbackShape", () => {
  it("accepts a null anchor and a valid feature id", () => {
    expect(parseFeatureRollbackShape({ afterFeatureId: null })).toEqual({
      ok: true,
      value: { afterFeatureId: null },
    });
    expect(parseFeatureRollbackShape({ afterFeatureId: fFirst })).toEqual({
      ok: true,
      value: { afterFeatureId: fFirst },
    });
  });

  it("rejects non-objects and invalid anchors, structurally", () => {
    for (const input of [null, "rollback", 7, {}, { afterFeatureId: 3 }]) {
      const parsed = parseFeatureRollbackShape(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(
          FEATURE_HISTORY_ERROR_CODES.rollbackInvalid,
        );
      }
    }
  });
});

describe("document error-code stability for reorder", () => {
  it("keeps the reorder codes in the stable tables", () => {
    expect(DOCUMENT_ERROR_CODES.reorderInvalid).toBe("document/reorder-invalid");
    expect(FEATURE_HISTORY_ERROR_CODES.orderInvalid).toBe(
      "feature-history/order-invalid",
    );
  });
});

describe("rolled-back state maps serialize in the Phase 6.3 vocabulary", () => {
  it("emits only the four regeneration states even when a marker was active", () => {
    const run = regenerate({
      features: chain,
      states: initialRegenerationStates(chain),
      suppressed: [],
      execute: () => ({ ok: true }),
      rollbackPoint: { afterFeatureId: fFirst } satisfies FeatureRollbackPoint,
    });
    if (!run.ok) throw new Error(run.error.message);
    for (const entry of serializeRegenerationStates(unwrap(run, "the run").states).features) {
      expect(FEATURE_REGENERATION_STATES).toContain(entry.state);
    }
  });
});
