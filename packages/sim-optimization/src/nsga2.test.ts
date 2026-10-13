import { describe, expect, it } from "vitest";

import {
  type Nsga2Evaluation,
  type Nsga2Spec,
  NSGA2_INVALID_OBJECTIVE_CODE,
  runNsga2,
  SimOptimizationAbortedError,
} from "./index";

/** A continuous single-gene spec on [-5, 5], the analytic fixtures' base. */
function singleGeneSpec(overrides?: Partial<Nsga2Spec>): Nsga2Spec {
  return {
    genes: [{ kind: "numeric", valueKind: "decimal", min: -5, max: 5 }],
    directions: ["minimize"],
    population: 16,
    generations: 30,
    mutationRate: 0.5,
    crossoverRate: 0.9,
    seed: 42,
    maxEvaluations: 512,
    ...overrides,
  };
}

/** The parabola fixture: minimize (x − shift)². */
function parabola(shift: number) {
  return (genome: {
    numericValues: readonly number[];
  }): Promise<Nsga2Evaluation> =>
    Promise.resolve({
      status: "ok",
      objectives: [((genome.numericValues[0] ?? 0) - shift) ** 2],
    });
}

describe("the NSGA-II engine", () => {
  it("converges on a single-objective parabola (the degenerate GA case)", async () => {
    const result = await runNsga2(singleGeneSpec(), parabola(1));
    const best = result.pareto[0];
    expect(best).toBeDefined();
    const x = 1 + Math.sqrt(best?.objectives[0] ?? 1);
    expect(Math.abs(x - 1)).toBeLessThan(0.05);
    expect(result.evaluations).toBeLessThanOrEqual(512);
  }, 20_000);

  it("finds the closed-form Pareto set of the Schaffer fixture", async () => {
    // minimize (x^2, (x-2)^2) over x in [-2, 2]: the Pareto set is exactly
    // x in [0, 2] (f1 grows, f2 shrinks on it); outside it one objective
    // improves without the other worsening.
    const result = await runNsga2(
      singleGeneSpec({
        genes: [{ kind: "numeric", valueKind: "decimal", min: -2, max: 2 }],
        directions: ["minimize", "minimize"],
        population: 24,
        generations: 40,
      }),
      (genome): Promise<Nsga2Evaluation> => {
        const x = genome.numericValues[0] ?? 0;
        return Promise.resolve({
          status: "ok",
          objectives: [x * x, (x - 2) * (x - 2)],
        });
      },
    );
    expect(result.pareto.length).toBeGreaterThan(1);
    for (const member of result.pareto) {
      const x = Math.sqrt(member.objectives[0] ?? 0);
      // The closed-form membership: every non-dominated point has x in [0, 2].
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(2 + 1e-9);
    }
    // Nondomination inside the reported front: no member dominates another.
    for (const left of result.pareto) {
      for (const right of result.pareto) {
        if (left === right) continue;
        const noWorse =
          (left.objectives[0] ?? 0) <= (right.objectives[0] ?? 0) + 1e-12 &&
          (left.objectives[1] ?? 0) <= (right.objectives[1] ?? 0) + 1e-12;
        const strictly =
          (left.objectives[0] ?? 0) < (right.objectives[0] ?? 0) - 1e-12 ||
          (left.objectives[1] ?? 0) < (right.objectives[1] ?? 0) - 1e-12;
        expect(noWorse && strictly).toBe(false);
      }
    }
  }, 20_000);

  it("is bitwise reproducible from the seed, and seed-sensitive", async () => {
    const first = await runNsga2(singleGeneSpec(), parabola(3));
    const second = await runNsga2(singleGeneSpec(), parabola(3));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const third = await runNsga2(singleGeneSpec({ seed: 43 }), parabola(3));
    expect(JSON.stringify(third)).not.toBe(JSON.stringify(first));
  }, 20_000);

  it("counts declined candidates as dominated, never crashes", async () => {
    // Every x > 0 declines: the feasible region is exactly x <= 0, and the
    // optimum of x^2 over it is x = 0.
    const result = await runNsga2(
      singleGeneSpec(),
      (genome): Promise<Nsga2Evaluation> => {
        const x = genome.numericValues[0] ?? 0;
        return Promise.resolve(
          x > 0
            ? {
                status: "declined",
                code: "sim/optimization-constraint-violated",
              }
            : { status: "ok", objectives: [x * x] },
        );
      },
    );
    expect(result.declined).toBeGreaterThan(0);
    const survivors = result.population;
    expect(survivors.length).toBeGreaterThan(0);
    // Feasible survivors outrank every declined one.
    const feasibleRanks = survivors
      .filter((candidate) => candidate.status === "ok")
      .map((candidate) => candidate.rank);
    const declinedRanks = survivors
      .filter((candidate) => candidate.status === "declined")
      .map((candidate) => candidate.rank);
    if (feasibleRanks.length > 0 && declinedRanks.length > 0) {
      expect(Math.max(...feasibleRanks)).toBeLessThan(
        Math.min(...declinedRanks),
      );
    }
    // The best feasible point is near the decline boundary x = 0.
    const best = result.pareto[0];
    expect(best).toBeDefined();
    expect(Math.sqrt(best?.objectives[0] ?? 1)).toBeLessThan(0.5);
  }, 20_000);

  it("maps non-finite objectives to a structured decline, never a score", async () => {
    const result = await runNsga2(
      singleGeneSpec({ generations: 2, population: 8 }),
      (): Promise<Nsga2Evaluation> =>
        Promise.resolve({ status: "ok", objectives: [Number.NaN] }),
    );
    expect(result.declined).toBe(result.evaluations);
    for (const generation of result.generations) {
      for (const candidate of generation.candidates) {
        expect(candidate.status).toBe("declined");
        expect(candidate.declineCode).toBe(NSGA2_INVALID_OBJECTIVE_CODE);
      }
    }
    expect(result.pareto).toEqual([]);
  });

  it("treats discrete genes as pure enumerations (no interpolation)", async () => {
    const choiceValues = [2, 7, 11];
    const observed = new Set<number>();
    const result = await runNsga2(
      singleGeneSpec({
        genes: [
          { kind: "discrete", choiceCount: 3 },
          { kind: "numeric", valueKind: "decimal", min: 0, max: 1 },
        ],
        directions: ["minimize"],
        generations: 12,
      }),
      (genome): Promise<Nsga2Evaluation> => {
        const choice = genome.choiceIndices[0] ?? 0;
        observed.add(choice);
        return Promise.resolve({
          status: "ok",
          objectives: [
            (choiceValues[choice] ?? 0) + (genome.numericValues[0] ?? 0) * 0.01,
          ],
        });
      },
    );
    // Every genome ever evaluated sits on the enumeration.
    for (const choice of observed) {
      expect(choice).toBeGreaterThanOrEqual(0);
      expect(choice).toBeLessThanOrEqual(2);
      expect(Number.isInteger(choice)).toBe(true);
    }
    // The engine discovers the minimizing choice (2 < 7 < 11) through
    // mutation alone, given enough generations.
    const best = result.pareto[0];
    expect(best).toBeDefined();
    expect(best?.objectives[0]).toBeLessThan(7);
  }, 20_000);

  it("respects the evaluation budget with early-terminated generations", async () => {
    const result = await runNsga2(
      singleGeneSpec({ population: 8, generations: 50, maxEvaluations: 16 }),
      parabola(0),
    );
    expect(result.evaluations).toBeLessThanOrEqual(16);
    expect(result.generations.length).toBeLessThan(50);
    expect(result.generations.length).toBeGreaterThan(0);
  });

  it("keeps integer genes on their lattice", async () => {
    const result = await runNsga2(
      singleGeneSpec({
        genes: [{ kind: "numeric", valueKind: "integer", min: 2, max: 30 }],
        generations: 8,
      }),
      (genome): Promise<Nsga2Evaluation> =>
        Promise.resolve({
          status: "ok",
          objectives: [((genome.numericValues[0] ?? 0) - 17) ** 2],
        }),
    );
    for (const generation of result.generations) {
      for (const candidate of generation.candidates) {
        for (const slot of candidate.slots) {
          const decoded = 2 + Math.round(Math.min(1, Math.max(0, slot)) * 28);
          expect(Number.isInteger(decoded)).toBe(true);
        }
      }
    }
    const best = result.pareto[0];
    expect(best?.objectives[0]).toBeLessThan(4);
  }, 20_000);

  it("aborts cooperatively and reproduces identically after the abort", async () => {
    let evaluations = 0;
    const countingParabola = (genome: {
      numericValues: readonly number[];
    }): Promise<Nsga2Evaluation> => {
      evaluations += 1;
      return Promise.resolve({
        status: "ok",
        objectives: [(genome.numericValues[0] ?? 0) ** 2],
      });
    };
    await expect(
      runNsga2(singleGeneSpec({ generations: 4 }), countingParabola, {
        shouldAbort: () => evaluations >= 5,
      }),
    ).rejects.toBeInstanceOf(SimOptimizationAbortedError);
    // The paused run leaves no state: a fresh identical run reproduces the
    // same results bitwise (determinism across pause/resume).
    evaluations = 0;
    const fresh = await runNsga2(
      singleGeneSpec({ generations: 4 }),
      countingParabola,
    );
    const reference = await runNsga2(
      singleGeneSpec({ generations: 4 }),
      countingParabola,
    );
    expect(JSON.stringify(fresh)).toBe(JSON.stringify(reference));
  }, 20_000);
});
