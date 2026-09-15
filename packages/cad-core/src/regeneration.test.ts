import { describe, expect, it } from "vitest";

import {
  affectedFeatures,
  CAD_DOCUMENT_FORMAT_VERSION,
  createBodyId,
  createFeatureId,
  createParameterId,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type FeatureExecutionOutcome,
  type FeatureExecutor,
  featureEvaluationOrder,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  initialRegenerationStates,
  markStale,
  parseRegenerationStates,
  REGENERATION_ERROR_CODES,
  type RegenerationStateMap,
  regenerate,
  serializeRegenerationStates,
} from "./index";

const pWidth = createParameterId("param_width");
const bBase = createBodyId("body_base");

const fSketch = createFeatureId("feat_sketch");
const fPad = createFeatureId("feat_pad");
const fBore = createFeatureId("feat_bore");
const fShell = createFeatureId("feat_shell");

function feature(
  id: FeatureId,
  inputs: readonly FeatureInputRef[] = [],
): FeatureRecord {
  return { id, kind: "solid", inputs, outputs: [] };
}

/**
 * The branched fixture: width → sketch → pad → bore is the worked branch,
 * shell (on the base body) is the untouched sibling branch.
 */
const branched: readonly FeatureRecord[] = [
  feature(fSketch, [{ kind: "parameter", id: pWidth }]),
  feature(fPad, [{ kind: "feature", id: fSketch }]),
  feature(fBore, [{ kind: "feature", id: fPad }]),
  feature(fShell, [{ kind: "body", id: bBase }]),
];

const VALID = { state: "valid", diagnostics: [] } as const;
const STALE = { state: "stale", diagnostics: [] } as const;

function allValid(features: readonly FeatureRecord[]): RegenerationStateMap {
  return new Map<FeatureId, { state: "valid"; diagnostics: readonly [] }>(
    features.map((entry) => [entry.id, VALID]),
  );
}

function diagnosticOn(
  id: FeatureId,
  message = "rebuild failed",
): Diagnostic {
  return {
    severity: "error",
    code: DIAGNOSTIC_CODES.arithmeticDivisionByZero,
    message,
    location: { primary: id },
  };
}

const succeed: FeatureExecutor = () => ({ ok: true });

function recorder(
  decide: (id: FeatureId) => FeatureExecutionOutcome,
): { readonly calls: readonly FeatureId[]; readonly executor: FeatureExecutor } {
  const calls: FeatureId[] = [];
  return {
    calls,
    executor: (candidate) => {
      calls.push(candidate.id);
      return decide(candidate.id);
    },
  };
}

function runRegeneration(input: {
  readonly features: readonly FeatureRecord[];
  readonly states: RegenerationStateMap;
  readonly suppressed?: readonly FeatureId[];
  readonly execute: FeatureExecutor;
}) {
  const result = regenerate({
    features: input.features,
    states: input.states,
    suppressed: input.suppressed ?? [],
    execute: input.execute,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("initialRegenerationStates", () => {
  it("marks every feature stale with no diagnostics, keyed in document order", () => {
    const initial = initialRegenerationStates(branched);
    expect(Array.from(initial.keys())).toEqual([fSketch, fPad, fBore, fShell]);
    for (const status of initial.values()) {
      expect(status.state).toBe("stale");
      expect(status.diagnostics).toEqual([]);
    }
  });

  it("returns an empty map for no features", () => {
    expect(initialRegenerationStates([]).size).toBe(0);
  });
});

describe("markStale", () => {
  it("reaches exactly the affected set from a changed parameter", () => {
    const marked = markStale(branched, allValid(branched), [pWidth]);
    expect(marked.get(fSketch)?.state).toBe("stale");
    expect(marked.get(fPad)?.state).toBe("stale");
    expect(marked.get(fBore)?.state).toBe("stale");
    expect(marked.get(fShell)?.state).toBe("valid");
  });

  it("reaches exactly the affected set from a changed body", () => {
    const marked = markStale(branched, allValid(branched), [bBase]);
    expect(marked.get(fShell)?.state).toBe("stale");
    expect(marked.get(fSketch)?.state).toBe("valid");
    expect(marked.get(fPad)?.state).toBe("valid");
    expect(marked.get(fBore)?.state).toBe("valid");
  });

  it("marks a changed feature itself plus its downstream, never siblings", () => {
    const marked = markStale(branched, allValid(branched), [fPad]);
    expect(marked.get(fPad)?.state).toBe("stale");
    expect(marked.get(fBore)?.state).toBe("stale");
    expect(marked.get(fSketch)?.state).toBe("valid");
    expect(marked.get(fShell)?.state).toBe("valid");
  });

  it("matches affectedFeatures for downstream reach", () => {
    const marked = markStale(branched, allValid(branched), [fSketch]);
    const affected = new Set(affectedFeatures(branched, fSketch));
    for (const entry of branched) {
      const expected = affected.has(entry.id) || entry.id === fSketch;
      expect(marked.get(entry.id)?.state).toBe(expected ? "stale" : "valid");
    }
  });

  it("keeps suppressed features suppressed even when invalidated", () => {
    const prior = new Map(allValid(branched));
    prior.set(fPad, { state: "suppressed", diagnostics: [] });
    const marked = markStale(branched, prior, [pWidth]);
    expect(marked.get(fPad)).toEqual({ state: "suppressed", diagnostics: [] });
  });

  it("clears diagnostics when a failed feature is invalidated back to stale", () => {
    const prior = new Map(allValid(branched));
    prior.set(fBore, { state: "failed", diagnostics: [diagnosticOn(fBore)] });
    const marked = markStale(branched, prior, [fPad]);
    expect(marked.get(fBore)).toEqual({ state: "stale", diagnostics: [] });
  });

  it("defaults missing prior entries to stale and drops removed features", () => {
    const trimmed = branched.slice(0, 3);
    const marked = markStale(trimmed, allValid(branched), [fSketch]);
    expect(Array.from(marked.keys())).toEqual([fSketch, fPad, fBore]);
    expect(marked.get(fSketch)?.state).toBe("stale");
    expect(marked.get(fPad)?.state).toBe("stale");
    expect(marked.get(fBore)?.state).toBe("stale");

    const fresh = markStale(branched, new Map(), []);
    for (const status of fresh.values()) {
      expect(status.state).toBe("stale");
    }
  });

  it("is independent of the order of the changed nodes", () => {
    const first = markStale(branched, allValid(branched), [pWidth, bBase]);
    const second = markStale(branched, allValid(branched), [bBase, pWidth]);
    expect(first).toEqual(second);
  });
});

describe("regenerate: valid graph", () => {
  it("executes every feature exactly once, in evaluation order, all valid", () => {
    const { calls, executor } = recorder(() => ({ ok: true }));
    const run = runRegeneration({
      features: branched,
      states: initialRegenerationStates(branched),
      execute: executor,
    });
    const order = featureEvaluationOrder(branched);
    if (!order.ok) throw new Error(order.error.message);
    expect(calls).toEqual(order.value);
    expect(run.executed).toEqual(order.value);
    for (const status of run.states.values()) {
      expect(status).toEqual(VALID);
    }
  });

  it("treats missing prior entries as stale and executes everything", () => {
    const { calls, executor } = recorder(() => ({ ok: true }));
    const run = runRegeneration({
      features: branched,
      states: new Map(),
      execute: executor,
    });
    expect(calls).toEqual([fSketch, fPad, fBore, fShell]);
    expect(run.states.get(fShell)).toEqual(VALID);
  });

  it("skips re-execution of valid features whose upstream did not change", () => {
    const { calls, executor } = recorder(() => ({ ok: true }));
    const run = runRegeneration({
      features: branched,
      states: allValid(branched),
      execute: executor,
    });
    expect(calls).toEqual([]);
    expect(run.executed).toEqual([]);
    expect(run.states).toEqual(allValid(branched));
  });
});

describe("regenerate: failure isolation", () => {
  it("fails only the failing feature; downstream is stale, never failed", () => {
    const prior = markStale(branched, allValid(branched), [pWidth]);
    const { calls, executor } = recorder((id) =>
      id === fPad
        ? { ok: false, diagnostics: [diagnosticOn(fPad, "pad exploded")] }
        : { ok: true },
    );
    const run = runRegeneration({
      features: branched,
      states: prior,
      execute: executor,
    });

    expect(run.states.get(fSketch)).toEqual(VALID);
    expect(run.states.get(fPad)).toEqual({
      state: "failed",
      diagnostics: [diagnosticOn(fPad, "pad exploded")],
    });
    expect(run.states.get(fBore)).toEqual(STALE);
    expect(run.states.get(fShell)).toEqual(VALID);
    expect(calls).toEqual([fSketch, fPad]);
    expect(run.executed).toEqual([fSketch, fPad]);
  });

  it("preserves unrelated upstream and sibling-branch state untouched", () => {
    const prior = markStale(branched, allValid(branched), [pWidth]);
    const run = runRegeneration({
      features: branched,
      states: prior,
      execute: (candidate) =>
        candidate.id === fSketch
          ? { ok: false, diagnostics: [diagnosticOn(fSketch)] }
          : { ok: true },
    });

    expect(run.states.get(fSketch)?.state).toBe("failed");
    expect(run.states.get(fPad)).toEqual(STALE);
    expect(run.states.get(fBore)).toEqual(STALE);
    expect(run.states.get(fShell)).toEqual(VALID);
  });

  it("attaches the executor's diagnostics with their stable codes", () => {
    const diagnostics: readonly Diagnostic[] = [
      diagnosticOn(fBore, "first"),
      {
        severity: "fatal",
        code: DIAGNOSTIC_CODES.arithmeticNonFiniteResult,
        message: "second",
        location: { primary: fBore, related: [fPad] },
      },
    ];
    const run = runRegeneration({
      features: [feature(fBore, [{ kind: "feature", id: fPad }]), feature(fPad)],
      states: new Map(),
      execute: (candidate) =>
        candidate.id === fBore ? { ok: false, diagnostics } : { ok: true },
    });
    const failed = run.states.get(fBore);
    if (failed === undefined) {
      throw new Error("expected a failed status for the bore");
    }
    expect(failed.state).toBe("failed");
    expect(failed.diagnostics).toEqual(diagnostics);
    expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DIAGNOSTIC_CODES.arithmeticDivisionByZero,
      DIAGNOSTIC_CODES.arithmeticNonFiniteResult,
    ]);
  });

  it("rejects a failing outcome without diagnostics as executor-malformed", () => {
    const result = regenerate({
      features: branched,
      states: initialRegenerationStates(branched),
      suppressed: [],
      execute: () => ({ ok: false, diagnostics: [] }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an executor failure");
    expect(result.error.code).toBe(REGENERATION_ERROR_CODES.executorMalformed);
    expect(result.error.message).toContain(fSketch);
  });

  it("rejects a failing outcome carrying an invalid diagnostic", () => {
    const result = regenerate({
      features: [feature(fSketch)],
      states: new Map(),
      suppressed: [],
      execute: () => ({
        ok: false,
        diagnostics: [{ ...diagnosticOn(fSketch), message: "" }],
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an executor failure");
    expect(result.error.code).toBe(REGENERATION_ERROR_CODES.executorMalformed);
  });

  it("propagates a graph cycle failure unchanged", () => {
    const cyclic: readonly FeatureRecord[] = [
      feature(fPad, [{ kind: "feature", id: fSketch }]),
      feature(fSketch, [{ kind: "feature", id: fPad }]),
    ];
    const result = regenerate({
      features: cyclic,
      states: new Map(),
      suppressed: [],
      execute: succeed,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a cycle failure");
    expect(result.error.code).toBe("graph/cycle");
    if (!("cycle" in result.error)) {
      throw new Error("expected a graph cycle failure");
    }
    expect(result.error.cycle).toEqual([fPad, fSketch, fPad]);
  });
});

describe("regenerate: recovery", () => {
  it("returns a repaired feature to valid and re-evaluates downstream", () => {
    const failing = runRegeneration({
      features: branched,
      states: markStale(branched, allValid(branched), [pWidth]),
      execute: (candidate) =>
        candidate.id === fPad
          ? { ok: false, diagnostics: [diagnosticOn(fPad)] }
          : { ok: true },
    });
    expect(failing.states.get(fPad)?.state).toBe("failed");
    expect(failing.states.get(fBore)?.state).toBe("stale");

    const { calls, executor } = recorder(() => ({ ok: true }));
    const recovered = runRegeneration({
      features: branched,
      states: failing.states,
      execute: executor,
    });

    expect(recovered.states.get(fSketch)).toEqual(VALID);
    expect(recovered.states.get(fPad)).toEqual(VALID);
    expect(recovered.states.get(fBore)).toEqual(VALID);
    expect(recovered.states.get(fShell)).toEqual(VALID);
    expect(calls).toEqual([fPad, fBore]);
    expect(recovered.executed).toEqual([fPad, fBore]);
  });

  it("replaces old failure diagnostics when a feature fails again differently", () => {
    const first = runRegeneration({
      features: branched,
      states: new Map(),
      execute: (candidate) =>
        candidate.id === fPad
          ? { ok: false, diagnostics: [diagnosticOn(fPad, "first")] }
          : { ok: true },
    });
    const second = runRegeneration({
      features: branched,
      states: first.states,
      execute: (candidate) =>
        candidate.id === fPad
          ? { ok: false, diagnostics: [diagnosticOn(fPad, "second")] }
          : { ok: true },
    });
    expect(second.states.get(fPad)).toEqual({
      state: "failed",
      diagnostics: [diagnosticOn(fPad, "second")],
    });
    expect(second.states.get(fBore)).toEqual(STALE);
  });
});

describe("regenerate: suppression", () => {
  it("skips a newly suppressed feature and lets dependents run without it", () => {
    const { calls, executor } = recorder(() => ({ ok: true }));
    const run = runRegeneration({
      features: branched,
      states: allValid(branched),
      suppressed: [fPad],
      execute: executor,
    });

    expect(run.states.get(fPad)).toEqual({
      state: "suppressed",
      diagnostics: [],
    });
    expect(run.states.get(fBore)).toEqual(VALID);
    expect(run.states.get(fSketch)).toEqual(VALID);
    expect(calls).toEqual([fBore]);
    expect(run.executed).toEqual([fBore]);
  });

  it("clears diagnostics of a failed feature that becomes suppressed", () => {
    const failedPrior = new Map(allValid(branched));
    failedPrior.set(fPad, { state: "failed", diagnostics: [diagnosticOn(fPad)] });
    const run = runRegeneration({
      features: branched,
      states: failedPrior,
      suppressed: [fPad],
      execute: succeed,
    });
    expect(run.states.get(fPad)).toEqual({
      state: "suppressed",
      diagnostics: [],
    });
  });

  it("does not rebuild dependents again while suppression persists unchanged", () => {
    const suppressedPrior = new Map(allValid(branched));
    suppressedPrior.set(fPad, { state: "suppressed", diagnostics: [] });
    const { calls, executor } = recorder(() => ({ ok: true }));
    const run = runRegeneration({
      features: branched,
      states: suppressedPrior,
      suppressed: [fPad],
      execute: executor,
    });
    expect(calls).toEqual([]);
    expect(run.states.get(fBore)).toEqual(VALID);
    expect(run.states.get(fPad)).toEqual({
      state: "suppressed",
      diagnostics: [],
    });
  });

  it("rebuilds a feature immediately after unsuppression", () => {
    const suppressedPrior = new Map(allValid(branched));
    suppressedPrior.set(fPad, { state: "suppressed", diagnostics: [] });
    const { calls, executor } = recorder(() => ({ ok: true }));
    const run = runRegeneration({
      features: branched,
      states: suppressedPrior,
      execute: executor,
    });
    expect(run.states.get(fPad)).toEqual(VALID);
    expect(calls).toEqual([fPad, fBore]);
  });

  it("never gates dependents: they fail on their own merits, not as stale", () => {
    const run = runRegeneration({
      features: branched,
      states: markStale(branched, allValid(branched), [pWidth]),
      suppressed: [fPad],
      execute: (candidate) =>
        candidate.id === fBore
          ? { ok: false, diagnostics: [diagnosticOn(fBore, "no edge left")] }
          : { ok: true },
    });
    expect(run.states.get(fPad)?.state).toBe("suppressed");
    expect(run.states.get(fBore)).toEqual({
      state: "failed",
      diagnostics: [diagnosticOn(fBore, "no edge left")],
    });
  });

  it("ignores suppressed ids that are not features of the list", () => {
    const run = runRegeneration({
      features: branched,
      states: allValid(branched),
      suppressed: [createFeatureId("feat_ghost")],
      execute: succeed,
    });
    expect(run.states.size).toBe(4);
    expect(run.executed).toEqual([]);
  });
});

describe("regenerate: determinism", () => {
  it("produces the identical state map and execution list for identical inputs", () => {
    const prior = markStale(branched, allValid(branched), [pWidth]);
    const decide = (id: FeatureId): FeatureExecutionOutcome =>
      id === fPad
        ? { ok: false, diagnostics: [diagnosticOn(fPad)] }
        : { ok: true };
    const first = runRegeneration({
      features: branched,
      states: prior,
      execute: (candidate) => decide(candidate.id),
    });
    const second = runRegeneration({
      features: branched,
      states: prior,
      execute: (candidate) => decide(candidate.id),
    });
    expect(second.states).toEqual(first.states);
    expect(second.executed).toEqual(first.executed);
    expect(Array.from(second.states.keys())).toEqual([
      fSketch,
      fPad,
      fBore,
      fShell,
    ]);
  });
});

describe("regeneration serialization", () => {
  it("serializes to a fixed shape in map order and round-trips exactly", () => {
    const run = runRegeneration({
      features: branched,
      states: markStale(branched, allValid(branched), [pWidth]),
      execute: (candidate) =>
        candidate.id === fPad
          ? { ok: false, diagnostics: [diagnosticOn(fPad)] }
          : { ok: true },
    });
    const serialized = serializeRegenerationStates(run.states);
    expect(serialized.formatVersion).toBe(CAD_DOCUMENT_FORMAT_VERSION);
    expect(serialized.features.map((entry) => entry.id)).toEqual([
      fSketch,
      fPad,
      fBore,
      fShell,
    ]);
    expect(serialized.features[1]).toEqual({
      id: fPad,
      state: "failed",
      diagnostics: [diagnosticOn(fPad)],
    });

    const parsed = parseRegenerationStates(
      JSON.parse(JSON.stringify(serialized)),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value).toEqual(run.states);
    expect(Array.from(parsed.value.keys())).toEqual(
      Array.from(run.states.keys()),
    );
  });

  it("parses a valid state with an omitted diagnostics field", () => {
    const parsed = parseRegenerationStates({
      formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
      features: [{ id: fSketch, state: "valid" }],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.get(fSketch)).toEqual(VALID);
  });

  it("ignores unknown fields for forward compatibility", () => {
    const parsed = parseRegenerationStates({
      formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
      features: [{ id: fSketch, state: "stale", futureField: true }],
      extra: 1,
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects malformed input with structured failures", () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [null, REGENERATION_ERROR_CODES.malformed],
      [
        { formatVersion: 2, features: [] },
        REGENERATION_ERROR_CODES.versionUnsupported,
      ],
      [{ formatVersion: CAD_DOCUMENT_FORMAT_VERSION }, REGENERATION_ERROR_CODES.malformed],
      [
        { formatVersion: CAD_DOCUMENT_FORMAT_VERSION, features: {} },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        { formatVersion: CAD_DOCUMENT_FORMAT_VERSION, features: [null] },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          features: [{ id: "nope", state: "valid" }],
        },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          features: [{ id: fSketch, state: "hungry" }],
        },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          features: [{ id: fSketch, state: "valid", diagnostics: 3 }],
        },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          features: [{ id: fSketch, state: "failed", diagnostics: [] }],
        },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          features: [
            {
              id: fSketch,
              state: "valid",
              diagnostics: [diagnosticOn(fSketch)],
            },
          ],
        },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          features: [
            { id: fSketch, state: "valid" },
            { id: fSketch, state: "stale" },
          ],
        },
        REGENERATION_ERROR_CODES.malformed,
      ],
      [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          features: [
            {
              id: fSketch,
              state: "failed",
              diagnostics: [{ ...diagnosticOn(fSketch), message: "" }],
            },
          ],
        },
        REGENERATION_ERROR_CODES.malformed,
      ],
    ];
    for (const [input, expectedCode] of cases) {
      const parsed = parseRegenerationStates(input);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("expected a parse failure");
      expect(parsed.error.code).toBe(expectedCode);
      expect(parsed.error.message.length).toBeGreaterThan(0);
    }
  });
});
