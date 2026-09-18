/**
 * Unit tests for the Phase 12 domain selection model: operation semantics
 * (single replace, multi toggle, hover separation, clear), the transience
 * rule (stale synthetic references rejected at every boundary, stripped on
 * regeneration), and serialization round-trips.
 */

import { describe, expect, it } from "vitest";
import type { FaceSelectionReference, SelectionReference } from "./selection";

import { createBodyId, createFeatureId } from "./ids";
import {
  beginRegeneration,
  clearSelection,
  createSelectionState,
  hoverSelection,
  isSyntheticSelectionReference,
  parseSelectionReference,
  parseSelectionState,
  pickSelection,
  SELECTION_CATEGORIES,
  SELECTION_ERROR_CODES,
  selectionReferenceBodyId,
  selectionReferenceKey,
  serializeSelectionReference,
  serializeSelectionState,
  STABLE_SELECTION_KINDS,
  SYNTHETIC_SELECTION_KINDS,
} from "./selection";

const BODY = createBodyId("body_plate");
const FEATURE = createFeatureId("feat_pad");

const BODY_REF: SelectionReference = { kind: "body", bodyId: BODY };
const SOLID_REF: SelectionReference = { kind: "solid", bodyId: BODY };
const FEATURE_REF: SelectionReference = { kind: "feature", featureId: FEATURE };

function faceRef(
  regeneration: number,
  faceIndex: number,
): FaceSelectionReference {
  return { kind: "face", bodyId: BODY, regeneration, faceIndex };
}

function unwrap<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { message: string } },
): T {
  if (!result.ok)
    throw new Error(`Expected ok, received: ${result.error.message}`);
  return result.value;
}

function expectError<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { code: string; message: string } },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a failure.");
  expect(result.error.code).toBe(code);
}

describe("selection state construction", () => {
  it("creates an empty state standing at the given regeneration", () => {
    const state = createSelectionState(7);
    expect(state.regeneration).toBe(7);
    expect(state.selected).toEqual([]);
    expect(state.hover).toBeNull();
  });

  it("defaults to regeneration 0 and freezes the state", () => {
    const state = createSelectionState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(state.regeneration).toBe(0);
  });

  it("rejects invented regeneration tags", () => {
    expect(() => createSelectionState(-1)).toThrow(RangeError);
    expect(() => createSelectionState(1.5)).toThrow(RangeError);
    expect(() => createSelectionState(Number.NaN)).toThrow(RangeError);
  });

  it("splits the plan's categories into stable and synthetic kinds", () => {
    expect(SELECTION_CATEGORIES).toEqual([
      ...STABLE_SELECTION_KINDS,
      ...SYNTHETIC_SELECTION_KINDS,
    ]);
    expect(isSyntheticSelectionReference(BODY_REF)).toBe(false);
    expect(isSyntheticSelectionReference(SOLID_REF)).toBe(false);
    expect(isSyntheticSelectionReference(FEATURE_REF)).toBe(false);
    expect(isSyntheticSelectionReference(faceRef(1, 0))).toBe(true);
  });

  it("exposes the body id a reference addresses", () => {
    expect(selectionReferenceBodyId(BODY_REF)).toBe(BODY);
    expect(selectionReferenceBodyId(SOLID_REF)).toBe(BODY);
    expect(selectionReferenceBodyId(faceRef(1, 0))).toBe(BODY);
    expect(selectionReferenceBodyId(FEATURE_REF)).toBeUndefined();
  });
});

describe("pick semantics", () => {
  it("single mode replaces the selection", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, faceRef(3, 1), { additive: false }));
    expect(state.selected).toEqual([faceRef(3, 1)]);
    state = unwrap(pickSelection(state, BODY_REF, { additive: false }));
    expect(state.selected).toEqual([BODY_REF]);
  });

  it("single mode is idempotent on the already-exclusive reference", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, BODY_REF, { additive: false }));
    state = unwrap(pickSelection(state, BODY_REF, { additive: false }));
    expect(state.selected).toEqual([BODY_REF]);
  });

  it("multi mode toggles: appends absent references in insertion order", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, BODY_REF, { additive: false }));
    state = unwrap(pickSelection(state, faceRef(3, 2), { additive: true }));
    state = unwrap(pickSelection(state, SOLID_REF, { additive: true }));
    expect(state.selected).toEqual([BODY_REF, faceRef(3, 2), SOLID_REF]);
  });

  it("multi mode toggles: removes present references, preserving the rest's order", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, BODY_REF, { additive: true }));
    state = unwrap(pickSelection(state, faceRef(3, 2), { additive: true }));
    state = unwrap(pickSelection(state, SOLID_REF, { additive: true }));
    state = unwrap(pickSelection(state, faceRef(3, 2), { additive: true }));
    expect(state.selected).toEqual([BODY_REF, SOLID_REF]);
    state = unwrap(pickSelection(state, SOLID_REF, { additive: true }));
    expect(state.selected).toEqual([BODY_REF]);
  });

  it("never duplicates a reference, whatever path it arrives by", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, BODY_REF, { additive: true }));
    state = unwrap(pickSelection(state, BODY_REF, { additive: true }));
    state = unwrap(
      pickSelection(
        state,
        { kind: "body", bodyId: createBodyId("body_plate") },
        { additive: true },
      ),
    );
    expect(state.selected).toEqual([BODY_REF]);
  });

  it("rejects synthetic references tagged for another regeneration", () => {
    const state = createSelectionState(3);
    expectError(
      pickSelection(state, faceRef(2, 0), { additive: false }),
      SELECTION_ERROR_CODES.staleReference,
    );
    expectError(
      pickSelection(state, faceRef(4, 0), { additive: true }),
      SELECTION_ERROR_CODES.staleReference,
    );
  });

  it("treats equal-content references as the same identity across instances", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, faceRef(3, 2), { additive: true }));
    const revived = unwrap(
      parseSelectionReference(serializeSelectionReference(faceRef(3, 2))),
    );
    // Toggling the revived copy REMOVES the original entry: the canonical
    // key, not object identity, decides membership.
    state = unwrap(pickSelection(state, revived, { additive: true }));
    expect(state.selected).toEqual([]);
    state = unwrap(pickSelection(state, revived, { additive: true }));
    expect(state.selected).toEqual([faceRef(3, 2)]);
  });
});

describe("hover semantics", () => {
  it("keeps hover separate from the selection and accepts duplicates of it", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, BODY_REF, { additive: false }));
    state = unwrap(hoverSelection(state, BODY_REF));
    expect(state.hover).toBe(BODY_REF);
    expect(state.selected).toEqual([BODY_REF]);
  });

  it("clears the hover with null without touching the selection", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, BODY_REF, { additive: false }));
    state = unwrap(hoverSelection(state, faceRef(3, 0)));
    state = unwrap(hoverSelection(state, null));
    expect(state.hover).toBeNull();
    expect(state.selected).toEqual([BODY_REF]);
  });

  it("rejects a stale synthetic hover reference", () => {
    const state = createSelectionState(3);
    expectError(
      hoverSelection(state, faceRef(2, 0)),
      SELECTION_ERROR_CODES.staleReference,
    );
  });
});

describe("clear and regeneration transience", () => {
  it("clear empties the selection and leaves the hover", () => {
    let state = createSelectionState(3);
    state = unwrap(pickSelection(state, BODY_REF, { additive: true }));
    state = unwrap(pickSelection(state, faceRef(3, 0), { additive: true }));
    state = unwrap(hoverSelection(state, faceRef(3, 1)));
    const cleared = clearSelection(state);
    expect(cleared.selected).toEqual([]);
    expect(cleared.hover).toBe(state.hover);
    expect(cleared.regeneration).toBe(3);
  });

  it("beginRegeneration strips synthetic references and keeps stable ones", () => {
    let state = createSelectionState(1);
    state = unwrap(pickSelection(state, BODY_REF, { additive: true }));
    state = unwrap(pickSelection(state, FEATURE_REF, { additive: true }));
    state = unwrap(pickSelection(state, SOLID_REF, { additive: true }));
    state = unwrap(pickSelection(state, faceRef(1, 4), { additive: true }));
    state = unwrap(hoverSelection(state, faceRef(1, 5)));
    const next = unwrap(beginRegeneration(state, 2));
    expect(next.regeneration).toBe(2);
    expect(next.selected).toEqual([BODY_REF, FEATURE_REF, SOLID_REF]);
    expect(next.hover).toBeNull();
    // The old state is untouched: transitions are immutable.
    expect(state.selected).toEqual([
      BODY_REF,
      FEATURE_REF,
      SOLID_REF,
      faceRef(1, 4),
    ]);
    expect(state.hover).toEqual(faceRef(1, 5));
    // The surviving selection continues on the new regeneration.
    const repicked = unwrap(
      pickSelection(next, faceRef(2, 4), { additive: true }),
    );
    expect(repicked.selected).toEqual([
      BODY_REF,
      FEATURE_REF,
      SOLID_REF,
      faceRef(2, 4),
    ]);
  });

  it("beginRegeneration requires a strictly increasing integer tag", () => {
    const state = createSelectionState(5);
    expectError(
      beginRegeneration(state, 5),
      SELECTION_ERROR_CODES.regenerationInvalid,
    );
    expectError(
      beginRegeneration(state, 4),
      SELECTION_ERROR_CODES.regenerationInvalid,
    );
    expectError(
      beginRegeneration(state, 6.5),
      SELECTION_ERROR_CODES.regenerationInvalid,
    );
    expect(unwrap(beginRegeneration(state, 6)).regeneration).toBe(6);
  });
});

describe("reference keys and serialization", () => {
  it("keys are equal exactly when references are equal", () => {
    expect(selectionReferenceKey(BODY_REF)).toBe(
      selectionReferenceKey({ kind: "body", bodyId: BODY }),
    );
    expect(selectionReferenceKey(BODY_REF)).not.toBe(
      selectionReferenceKey(SOLID_REF),
    );
    expect(selectionReferenceKey(faceRef(3, 2))).not.toBe(
      selectionReferenceKey(faceRef(3, 3)),
    );
    expect(selectionReferenceKey(faceRef(3, 2))).not.toBe(
      selectionReferenceKey(faceRef(2, 2)),
    );
    expect(selectionReferenceKey(faceRef(3, 2))).toBe("face|body_plate|3|2");
  });

  it("round-trips every reference kind through serialize/parse", () => {
    const references: readonly SelectionReference[] = [
      BODY_REF,
      SOLID_REF,
      FEATURE_REF,
      faceRef(3, 2),
      { kind: "edge", bodyId: BODY, regeneration: 3, edgeIndex: 1 },
      { kind: "vertex", bodyId: BODY, regeneration: 3, vertexIndex: 7 },
    ];
    for (const reference of references) {
      const parsed = parseSelectionReference(
        serializeSelectionReference(reference),
      );
      expect(unwrap(parsed)).toEqual(reference);
    }
  });

  it("serializes with fixed key order for canonical bytes", () => {
    expect(JSON.stringify(serializeSelectionReference(faceRef(3, 2)))).toBe(
      '{"kind":"face","bodyId":"body_plate","regeneration":3,"faceIndex":2}',
    );
    expect(JSON.stringify(serializeSelectionReference(BODY_REF))).toBe(
      '{"kind":"body","bodyId":"body_plate"}',
    );
  });

  it("rejects malformed references", () => {
    expectError(
      parseSelectionReference(null),
      SELECTION_ERROR_CODES.notAReference,
    );
    expectError(
      parseSelectionReference({ kind: "solid" }),
      SELECTION_ERROR_CODES.idInvalid,
    );
    expectError(
      parseSelectionReference({ kind: "body" }),
      SELECTION_ERROR_CODES.idInvalid,
    );
    expectError(
      parseSelectionReference({ kind: "topology" }),
      SELECTION_ERROR_CODES.notAReference,
    );
    expectError(
      parseSelectionReference({ kind: "body", bodyId: "feat_pad" }),
      SELECTION_ERROR_CODES.idInvalid,
    );
    expectError(
      parseSelectionReference({
        kind: "face",
        bodyId: "feat_pad",
        regeneration: 1,
        faceIndex: 0,
      }),
      SELECTION_ERROR_CODES.idInvalid,
    );
    expectError(
      parseSelectionReference({
        kind: "face",
        bodyId: BODY,
        regeneration: -1,
        faceIndex: 0,
      }),
      SELECTION_ERROR_CODES.fieldInvalid,
    );
    expectError(
      parseSelectionReference({
        kind: "edge",
        bodyId: BODY,
        regeneration: 1,
        edgeIndex: 0.5,
      }),
      SELECTION_ERROR_CODES.fieldInvalid,
    );
    expectError(
      parseSelectionReference({
        kind: "vertex",
        bodyId: BODY,
        regeneration: 1,
      }),
      SELECTION_ERROR_CODES.fieldInvalid,
    );
  });
});

describe("state serialization", () => {
  it("round-trips a populated state", () => {
    let state = createSelectionState(9);
    state = unwrap(pickSelection(state, BODY_REF, { additive: true }));
    state = unwrap(pickSelection(state, faceRef(9, 4), { additive: true }));
    state = unwrap(hoverSelection(state, faceRef(9, 5)));
    const parsed = unwrap(parseSelectionState(serializeSelectionState(state)));
    expect(parsed).toEqual(state);
  });

  it("rejects duplicates and malformed states", () => {
    const state = {
      regeneration: 9,
      selected: [BODY_REF, { kind: "body", bodyId: BODY }],
      hover: null,
    };
    expectError(
      parseSelectionState(state),
      SELECTION_ERROR_CODES.duplicateReference,
    );
    expectError(
      parseSelectionState({ regeneration: -1, selected: [], hover: null }),
      SELECTION_ERROR_CODES.regenerationInvalid,
    );
    expectError(
      parseSelectionState({ regeneration: 9, selected: "all" }),
      SELECTION_ERROR_CODES.notAReference,
    );
  });

  it("enforces the expected regeneration at the revival boundary", () => {
    // A state standing at the wrong regeneration is refused outright.
    const older = serializeSelectionState({
      regeneration: 4,
      selected: [BODY_REF],
      hover: null,
    });
    expectError(
      parseSelectionState(older, { expectedRegeneration: 5 }),
      SELECTION_ERROR_CODES.regenerationInvalid,
    );
    // A state claiming the right regeneration while carrying synthetic
    // references tagged for an older one is refused at the reference level.
    const inconsistent = {
      regeneration: 5,
      selected: [faceRef(4, 2)],
      hover: null,
    };
    expectError(
      parseSelectionState(inconsistent, { expectedRegeneration: 5 }),
      SELECTION_ERROR_CODES.staleReference,
    );
    const inconsistentHover = {
      regeneration: 5,
      selected: [BODY_REF],
      hover: faceRef(4, 3),
    };
    expectError(
      parseSelectionState(inconsistentHover, { expectedRegeneration: 5 }),
      SELECTION_ERROR_CODES.staleReference,
    );
    const current = serializeSelectionState({
      regeneration: 5,
      selected: [faceRef(5, 2), BODY_REF],
      hover: BODY_REF,
    });
    expect(
      unwrap(parseSelectionState(current, { expectedRegeneration: 5 })),
    ).toEqual({
      regeneration: 5,
      selected: [faceRef(5, 2), BODY_REF],
      hover: BODY_REF,
    });
    // Stable references survive a revival when the state stands at the
    // expected regeneration: they carry no tag of their own.
    const stableOnly = serializeSelectionState({
      regeneration: 5,
      selected: [BODY_REF],
      hover: SOLID_REF,
    });
    expect(
      unwrap(parseSelectionState(stableOnly, { expectedRegeneration: 5 })),
    ).toEqual({
      regeneration: 5,
      selected: [BODY_REF],
      hover: SOLID_REF,
    });
  });
});
