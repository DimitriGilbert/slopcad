/**
 * Scenario-snapshot hash tests: stability across identical scenarios
 * (including key-order permutations), sensitivity to authored changes,
 * and the structured refusal over non-canonicalizable content.
 */

import { describe, expect, it } from "vitest";

import { SIM_ERROR_CODES } from "./errors";
import { canonicalSimJson, simScenarioSnapshotHash } from "./snapshot";

/** A minimal serialized flow scenario (the document's canonical form). */
function scenario(): Record<string, unknown> {
  return {
    id: "sim_wind-tunnel",
    name: "Wind tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [-500, -250, -250],
      max: [500, 250, 250],
      resolutionMm: 2,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 10,
        direction: [1, 0, 0],
      },
    ],
    fluid: "air",
    materials: [],
    gravityMPerS2: [0, -9.80665, 0],
  };
}

describe("the scenario snapshot hash", () => {
  it("is stable across identical scenarios", () => {
    const first = simScenarioSnapshotHash(scenario());
    const second = simScenarioSnapshotHash(scenario());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toBe(first.value);
    expect(first.value).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable under key-order permutation of the same content", () => {
    const direct = simScenarioSnapshotHash(scenario());
    const permuted: Record<string, unknown> = {
      fluid: "air",
      gravityMPerS2: [0, -9.80665, 0],
      materials: [],
      conditions: scenario().conditions,
      domain: scenario().domain,
      kind: "flow",
      name: "Wind tunnel",
      id: "sim_wind-tunnel",
    };
    const other = simScenarioSnapshotHash(permuted);
    expect(other.ok).toBe(true);
    if (!direct.ok || !other.ok) return;
    expect(other.value).toBe(direct.value);
  });

  it("changes when the authored content changes", () => {
    const base = simScenarioSnapshotHash(scenario());
    const changed = scenario();
    const conditions = changed.conditions as { speedMPerS: number }[];
    conditions[0]!.speedMPerS = 12;
    const other = simScenarioSnapshotHash(changed);
    expect(base.ok).toBe(true);
    expect(other.ok).toBe(true);
    if (!base.ok || !other.ok) return;
    expect(other.value).not.toBe(base.value);
  });

  it("refuses non-finite content structurally", () => {
    const result = simScenarioSnapshotHash({ bad: Number.POSITIVE_INFINITY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SIM_ERROR_CODES.snapshotInvalid);
  });

  it("canonicalizes recursively sorted JSON", () => {
    expect(canonicalSimJson({ b: 1, a: [2, { d: true, c: null }] }).ok).toBe(
      true,
    );
    const canonical = canonicalSimJson({ b: 1, a: 2 });
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value).toBe('{"a":2,"b":1}');
  });
});
