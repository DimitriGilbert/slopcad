/**
 * The Pareto view's tests (Phase 70b): the pure projections — the
 * scatter (front vs dominated, the single-objective degradation to a
 * candidate-index x axis), the best-of-generation progression (minimize
 * and maximize both), and the campaign family rows over the store's
 * grouped runs (the `./fan-chart` pure-data test precedent).
 */

import { describe, expect, it } from "vitest";
import { buildSimStudyBody, createStudyId } from "@slopcad/cad-core";
import type {
  SimResult,
  SimResultRunRecord,
  WorkerSimOptimizeGeneration,
  WorkerSimOptimizeResult,
} from "@slopcad/sim-core";

import { campaignFamilyRows, paretoViewOf } from "./study-pareto";

/** Builds a two-objective study record through the module boundary. */
function twoObjectiveStudy() {
  const built = buildSimStudyBody(
    "two objectives",
    "sim_any",
    [
      {
        kind: "parameter",
        parameterId: "param_a",
        valueKind: "integer",
        min: 0,
        max: 9,
      },
    ],
    [
      { quantity: "mass", direction: "minimize" },
      { quantity: "factor-of-safety", direction: "maximize" },
    ],
    [],
    4,
    2,
    undefined,
    undefined,
    3,
    8,
  );
  if (!built.ok) throw new Error(built.error.message);
  return { ...built.value, id: createStudyId("study_pareto") };
}

/** A scored candidate wire record. */
function candidate(
  index: number,
  objectives: readonly number[],
  rank = 0,
): {
  readonly index: number;
  readonly genomeParameters: readonly {
    readonly parameterId: string;
    readonly value: number;
  }[];
  readonly genomeRecords: readonly {
    readonly recordKind: string;
    readonly recordId: string;
  }[];
  readonly status: "ok";
  readonly objectives: readonly number[];
  readonly rank: number;
} {
  return {
    index,
    genomeParameters: [{ parameterId: "param_a", value: index }],
    genomeRecords: [],
    status: "ok",
    objectives,
    rank,
  };
}

function campaignResult(
  generations: readonly WorkerSimOptimizeGeneration[],
  pareto: readonly ReturnType<typeof candidate>[],
): WorkerSimOptimizeResult {
  return {
    campaign: "abcd1234",
    generations,
    evaluations: generations.reduce(
      (sum, generation) => sum + generation.candidates.length,
      0,
    ),
    declined: 0,
    pareto,
  };
}

describe("the Pareto scatter projection", () => {
  it("carries every scored candidate with the front flag and the objective-pair window", () => {
    const study = twoObjectiveStudy();
    const result = campaignResult(
      [
        {
          generation: 1,
          evaluations: 4,
          candidates: [
            candidate(0, [1, 9]),
            candidate(1, [2, 8], 1),
            candidate(2, [3, 6]),
            candidate(3, [4, 5], 2),
          ],
        },
      ],
      [candidate(0, [1, 9]), candidate(2, [3, 6])],
    );
    const view = paretoViewOf(study, result);
    expect(view.scatter.xLabel).toBe("min mass");
    expect(view.scatter.yLabel).toBe("max factor-of-safety");
    expect(view.scatter.xIsCandidateIndex).toBe(false);
    expect(view.scatter.points.map((point) => point.onFront)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(view.front.map((entry) => entry.index)).toEqual([0, 2]);
  });

  it("degrades honestly to a candidate-index x axis on a single-objective study", () => {
    const built = buildSimStudyBody(
      "one objective",
      "sim_any",
      [
        {
          kind: "parameter",
          parameterId: "param_a",
          valueKind: "integer",
          min: 0,
          max: 9,
        },
      ],
      [{ quantity: "airflow-per-electrical-watt", direction: "maximize" }],
      [],
      4,
      2,
      undefined,
      undefined,
      3,
      8,
    );
    if (!built.ok) throw new Error(built.error.message);
    const study = { ...built.value, id: createStudyId("study_single") };
    const result = campaignResult(
      [
        {
          generation: 1,
          evaluations: 3,
          candidates: [
            candidate(0, [1.5]),
            candidate(1, [2.5]),
            candidate(2, [0.5]),
          ],
        },
      ],
      [candidate(1, [2.5])],
    );
    const view = paretoViewOf(study, result);
    expect(view.scatter.xIsCandidateIndex).toBe(true);
    expect(view.scatter.xLabel).toBe("candidate");
    expect(view.scatter.points.map((point) => point.x)).toEqual([0, 1, 2]);
  });
});

describe("the best-of-generation progression", () => {
  it("tracks the per-generation best of the first objective in the study's direction", () => {
    const study = twoObjectiveStudy();
    const result = campaignResult(
      [
        {
          generation: 0,
          evaluations: 2,
          candidates: [candidate(0, [5, 1]), candidate(1, [3, 2])],
        },
        {
          generation: 1,
          evaluations: 4,
          candidates: [candidate(2, [4, 1]), candidate(3, [2, 3])],
        },
      ],
      [candidate(3, [2, 3])],
    );
    const view = paretoViewOf(study, result);
    expect(view.progression).toEqual([
      { generation: 0, value: 3 },
      { generation: 1, value: 2 },
    ]);
  });
});

describe("the campaign family rows", () => {
  it("groups the store's campaign-tagged runs and ignores ordinary runs", () => {
    const base: SimResult = {
      summary: {
        schemaVersion: 1,
        scenarioSnapshotHash: "hash",
        status: "completed",
        regime: { qualitative: [] },
        quantities: [],
      },
      fields: [],
      histories: [],
    };
    const run = (
      id: string,
      tag?: {
        readonly family: string;
        readonly studyId: string;
        readonly seed: number;
        readonly generation: number;
      },
    ): SimResultRunRecord => ({
      id,
      documentVersionId: "doc",
      scenarioSnapshotHash: "hash",
      status: "completed",
      createdAt: "",
      updatedAt: "",
      summary: {
        ...base.summary,
        ...(tag
          ? {
              campaign: {
                ...tag,
                candidate: 0,
                genome: { parameters: [], records: [] },
              },
            }
          : {}),
      },
    });
    const rows = campaignFamilyRows([
      run("run_plain"),
      run("run_a1", {
        family: "fam_a",
        studyId: "study_1",
        seed: 7,
        generation: 0,
      }),
      run("run_a2", {
        family: "fam_a",
        studyId: "study_1",
        seed: 7,
        generation: 1,
      }),
      run("run_b1", {
        family: "fam_b",
        studyId: "study_1",
        seed: 9,
        generation: 0,
      }),
    ]);
    expect(rows).toHaveLength(2);
    const famA = rows.find((row) => row.family === "fam_a");
    expect(famA?.studyId).toBe("study_1");
    expect(famA?.seed).toBe(7);
    expect(famA?.generations).toEqual([0, 1]);
    expect(famA?.runs).toBe(2);
  });
});
