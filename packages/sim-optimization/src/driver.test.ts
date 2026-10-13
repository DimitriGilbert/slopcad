import { describe, expect, it } from "vitest";
import {
  serializeDocumentMotor,
  serializeParameterCollection,
  serializeSimStudy,
} from "@slopcad/cad-core";
import {
  createInMemorySimResultStorage,
  createLocalSimResultStore,
  createSimInMemoryTransportPair,
  createSimWorkerClient,
  createSimWorkerServer,
} from "@slopcad/sim-core";

import { groupSimCampaignFamilies, persistSimCampaign } from "./campaign";
import {
  buildSimOptimizationRunContext,
  evaluateAuthoredGenome,
  runSimOptimization,
} from "./evaluate";
import { createSimOptimizationExecutor } from "./executor";
import {
  TOY_DENSITY_G_PER_MM3,
  TOY_PLATE_DEPTH_MM,
  createToyMassEngine,
  toyGeometryProvider,
  toyMotors,
  toyParameterTable,
  toyScenario,
  toyStudy,
} from "./toy-campaign";

function toyContext(study: ReturnType<typeof toyStudy>) {
  const built = buildSimOptimizationRunContext({
    study: serializeSimStudy(study),
    scenario: toyScenario(),
    parameters: serializeParameterCollection(toyParameterTable(10, 10)),
    motors: toyMotors().map((motor) => serializeDocumentMotor(motor)),
  });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

/** A toy run with the multiple-of-7 refusing engine (the decline fixture). */
function runOptimization(study: ReturnType<typeof toyStudy>) {
  return runSimOptimization(toyContext(study), {
    engines: [createToyMassEngine({ refuseWhen: (cells) => cells % 7 === 0 })],
    geometry: toyGeometryProvider(),
  });
}

describe("the evaluation driver on the batch spine", () => {
  it("solves the closed-form optimum on the toy document (integral alignment)", async () => {
    // The voxel grid samples nodes at integral mm positions, so a w × h mm
    // plate occupies (2·⌊w/2⌋+1)·(2·⌊h/2⌋+1) cells — exact for integral
    // plates. min mass s.t. width·height > 99.5 over integer genes is the
    // smallest odd-pair product past the boundary: 105 cells (7 × 15),
    // reached at e.g. width 7 × height 15.
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      constraints: ["width * height - 99.5mm2"],
      population: 16,
      generations: 18,
      seed: 3,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.result === undefined) throw new Error("no result");
    const best = outcome.result.pareto[0];
    expect(best).toBeDefined();
    const bestMass = best?.objectives[0] ?? 0;
    const optimum = 105 * TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3;
    // The staircase is exact for integral plates on the aligned grid: the
    // found optimum equals the closed form exactly.
    expect(bestMass).toBe(optimum);
    // The unconstrained run drives to the bounds floor instead (3 × 3
    // nodes around the smallest 2 × 2 mm plate).
    const unconstrained = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      population: 16,
      generations: 14,
      seed: 3,
    });
    const floor = await runSimOptimization(toyContext(unconstrained), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    const floorMass = floor.result?.pareto[0]?.objectives[0] ?? 0;
    expect(floorMass).toBe(9 * TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3);
  }, 30_000);

  it("enforces constraints as structured declines, never crashes", async () => {
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      constraints: ["width * height - 200mm2"],
      population: 10,
      generations: 6,
      seed: 11,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.result === undefined) throw new Error("no result");
    // Every scored candidate satisfies the constraint: width·height > 200.
    for (const generation of outcome.result.generations) {
      for (const candidate of generation.candidates) {
        if (candidate.status !== "ok") {
          expect(candidate.declineCode).toBe(
            "sim/optimization-constraint-violated",
          );
          continue;
        }
        const width = candidate.genomeParameters[0]?.value ?? 0;
        const height = candidate.genomeParameters[1]?.value ?? 0;
        expect(width * height).toBeGreaterThan(200);
      }
    }
    expect(outcome.result.declined).toBeGreaterThan(0);
    // The constrained optimum's closed form: nodes at integral mm make the
    // cell count (2·⌊w/2⌋+1)·(2·⌊h/2⌋+1), so the smallest product past
    // the boundary is 7 × 29 = 203 cells (width 7 × height 29) — verified
    // directly (the analytic fixture), while the search lands within the
    // quantization band above it.
    const k = TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3;
    const analyticBest = await evaluateAuthoredGenome(
      toyContext(study),
      { engines: [createToyMassEngine({})], geometry: toyGeometryProvider() },
      { numericValues: [7, 29], choiceIndices: [] },
    );
    if (analyticBest.status !== "ok") throw new Error(analyticBest.declineCode);
    expect(analyticBest.objectives[0]).toBe(203 * k);
    const best = outcome.result.pareto[0];
    const bestMass = best?.objectives[0] ?? 0;
    expect(bestMass).toBeGreaterThanOrEqual(203 * k);
    expect(bestMass).toBeLessThanOrEqual(240 * k);
  }, 30_000);

  it("keeps engine refusals penalized and the loop alive", async () => {
    // The toy engine refuses every plate whose CELL count is divisible by
    // 7: those candidates decline (sim/run-diverged), rank last, and the
    // run completes.
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      population: 12,
      generations: 8,
      seed: 5,
    });
    const outcome = await runOptimization(study);
    if (outcome.result === undefined) throw new Error("no result");
    const declined = outcome.result.generations[0]?.candidates.filter(
      (candidate) => candidate.status === "declined",
    );
    expect(declined?.length ?? 0).toBeGreaterThan(0);
    for (const candidate of declined ?? []) {
      expect(candidate.declineCode).toBe("sim/run-diverged");
    }
    // No scored candidate ever carries a multiple-of-7 cell count.
    for (const generation of outcome.result.generations) {
      for (const candidate of generation.candidates) {
        if (candidate.status !== "ok") continue;
        const cells = Math.round(
          (candidate.objectives[0] ?? 0) /
            (TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3),
        );
        expect(cells % 7).not.toBe(0);
      }
    }
  }, 30_000);

  it("is bitwise reproducible at the driver level (study seed → identical campaign)", async () => {
    const study = toyStudy({
      objectives: [
        { quantity: "mass", direction: "minimize" },
        { quantity: "deflection", direction: "minimize" },
      ],
      population: 10,
      generations: 5,
      seed: 9,
    });
    const run = () =>
      runSimOptimization(toyContext(study), {
        engines: [createToyMassEngine({})],
        geometry: toyGeometryProvider(),
      });
    const first = await run();
    const second = await run();
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
    expect(second.campaign).toBe(first.campaign);
    // A different seed is a different campaign family (multi-seed rungs).
    const otherSeed = toyStudy({
      objectives: [
        { quantity: "mass", direction: "minimize" },
        { quantity: "deflection", direction: "minimize" },
      ],
      population: 10,
      generations: 5,
      seed: 10,
    });
    const third = await runSimOptimization(toyContext(otherSeed), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    expect(third.campaign).not.toBe(first.campaign);
  }, 30_000);

  it("rides the Schaffer identity on the two-objective toy front", async () => {
    // mass = k·cells and deflection = 1e6/cells: on the non-dominated set
    // every member is a distinct cell count and mass·deflection = k·1e6.
    const study = toyStudy({
      objectives: [
        { quantity: "mass", direction: "minimize" },
        { quantity: "deflection", direction: "minimize" },
      ],
      population: 20,
      generations: 12,
      seed: 21,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    if (outcome.result === undefined) throw new Error("no result");
    expect(outcome.result.pareto.length).toBeGreaterThan(1);
    const cellCounts = new Set<number>();
    const k = TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3;
    for (const member of outcome.result.pareto) {
      const mass = member.objectives[0] ?? 0;
      const deflection = member.objectives[1] ?? 0;
      const cells = Math.round(mass / k);
      expect(Math.abs(mass / k - cells)).toBeLessThan(1e-9);
      expect(mass * deflection).toBeCloseTo(1e6 * k, 6);
      cellCounts.add(cells);
    }
    expect(cellCounts.size).toBe(outcome.result.pareto.length);
  }, 30_000);

  it("co-optimizes a discrete motor gene beside the geometry", async () => {
    // maximize air-per-watt (= 10 · stall torque): the torquey motor (80
    // mN·m = 0.08 N·m) wins over the speedy one (0.02 N·m) — 0.8 vs 0.2.
    const study = toyStudy({
      objectives: [{ quantity: "air-per-watt", direction: "maximize" }],
      motorGene: true,
      population: 12,
      generations: 6,
      seed: 13,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    if (outcome.result === undefined) throw new Error("no result");
    const best = outcome.result.pareto[0];
    expect(best).toBeDefined();
    expect(best?.objectives[0]).toBe(0.8);
    for (const generation of outcome.result.generations) {
      for (const candidate of generation.candidates) {
        if (candidate.status !== "ok") continue;
        const record = candidate.genomeRecords[0];
        expect(record).toBeDefined();
        expect(["mot_torquey", "mot_speedy"]).toContain(record?.recordId);
      }
    }
  }, 30_000);

  it("stops early when the evaluation budget exhausts", async () => {
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      population: 8,
      generations: 20,
      maxEvaluations: 24,
      seed: 4,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    if (outcome.result === undefined) throw new Error("no result");
    expect(outcome.result.evaluations).toBeLessThanOrEqual(24);
    expect(outcome.result.generations.length).toBeGreaterThan(1);
    expect(outcome.result.generations.length).toBeLessThan(20);
  }, 30_000);

  it("aborts through the host poll and reports the campaign aborted", async () => {
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      population: 8,
      generations: 8,
      seed: 6,
    });
    let evaluations = 0;
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
      shouldAbort: () => evaluations >= 3,
      onEvaluation: (total) => {
        evaluations = total;
      },
    });
    expect(outcome.status).toBe("aborted");
    expect(outcome.result).toBeUndefined();
  }, 30_000);

  it("declines an unknown objective quantity loudly, never scores a guess", async () => {
    const study = toyStudy({
      objectives: [{ quantity: "no-such-quantity", direction: "minimize" }],
      population: 6,
      generations: 2,
      seed: 8,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    if (outcome.result === undefined) throw new Error("no result");
    expect(outcome.result.declined).toBe(outcome.result.evaluations);
    for (const generation of outcome.result.generations) {
      for (const candidate of generation.candidates) {
        expect(candidate.declineCode).toBe(
          "sim/optimization-objective-missing",
        );
      }
    }
    expect(outcome.result.pareto).toEqual([]);
  }, 30_000);

  it("demonstrates the staircase on fractional plates (the caveat, quantized)", async () => {
    // Nodes sit at integral mm positions, so plate edges anywhere in
    // (10, 12) mm occupy the same 11 × 11 = 121 cells — the plateau — and
    // the 12 mm edge steps to 13 × 13 = 169 at once (the jump).
    const engine = createToyMassEngine({});
    const provider = toyGeometryProvider();
    const context = toyContext(
      toyStudy({
        objectives: [{ quantity: "mass", direction: "minimize" }],
        population: 4,
        generations: 1,
      }),
    );
    const evaluateAt = async (width: number, height: number) => {
      const evaluation = await evaluateAuthoredGenome(
        context,
        { engines: [engine], geometry: provider },
        { numericValues: [width, height], choiceIndices: [] },
      );
      if (evaluation.status !== "ok") throw new Error(evaluation.declineCode);
      return evaluation.objectives[0] ?? 0;
    };
    const k = TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3;
    expect(await evaluateAt(10, 10)).toBe(121 * k);
    expect(await evaluateAt(10.4, 10.4)).toBe(121 * k);
    expect(await evaluateAt(11.9, 11.9)).toBe(121 * k);
    expect(await evaluateAt(12, 12)).toBe(169 * k);
  });

  it("declines a malformed study context at the build boundary", () => {
    const built = buildSimOptimizationRunContext({
      study: { not: "a study" },
      scenario: toyScenario(),
      parameters: { parameters: [] },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe("sim/study-invalid");
    // A study whose gene addresses no parameter refuses at the cross-check.
    const badGeneStudy = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
    });
    const missingParameter = buildSimOptimizationRunContext({
      study: serializeSimStudy(badGeneStudy),
      scenario: toyScenario(),
      parameters: { parameters: [] },
    });
    expect(missingParameter.ok).toBe(false);
  });
});

describe("the worker-seam executor over a transport", () => {
  it("serves sim.optimize end to end through the sim worker server", async () => {
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      population: 6,
      generations: 3,
      seed: 2,
    });
    const executor = createSimOptimizationExecutor({
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    const pair = createSimInMemoryTransportPair();
    createSimWorkerServer({
      engine: createToyMassEngine({}),
      transport: pair.server,
      optimizer: executor,
    });
    const client = createSimWorkerClient({ transport: pair.client });
    const notifications: string[] = [];
    client.onNotification((delivery) => {
      if (delivery.notification.kind === "progress") {
        notifications.push(`progress:${String(delivery.notification.step)}`);
      } else if (delivery.notification.kind === "optimization-generation") {
        notifications.push(
          `generation:${String(delivery.notification.generation)}:${String(
            delivery.notification.evaluated,
          )}`,
        );
      }
    });
    const result = await client.request("sim.optimize", {
      study: serializeSimStudy(study),
      scenario: toyScenario(),
      parameters: serializeParameterCollection(toyParameterTable(10, 10)),
      motors: toyMotors().map((motor) => serializeDocumentMotor(motor)),
    });
    expect(result.campaign.length).toBe(8);
    expect(result.evaluations).toBeGreaterThan(0);
    expect(notifications.some((entry) => entry.startsWith("progress:"))).toBe(
      true,
    );
    expect(notifications.some((entry) => entry.startsWith("generation:"))).toBe(
      true,
    );
    client.close();
  }, 30_000);

  it("persists best-per-generation through the store (family + generation keyed)", async () => {
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      population: 8,
      generations: 4,
      seed: 17,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    const store = createLocalSimResultStore({
      storage: createInMemorySimResultStorage(),
    });
    const persisted = await persistSimCampaign(
      store,
      "docver_1",
      study,
      outcome,
      "best-per-generation",
    );
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value.length).toBe(4);
    const listed = await store.list("docver_1");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const families = groupSimCampaignFamilies(listed.value);
    expect(families.size).toBe(1);
    const family = families.get(outcome.campaign);
    expect(family).toBeDefined();
    expect(family?.size).toBe(4);
    for (const [generation, runs] of family ?? []) {
      expect(generation).toBeLessThan(4);
      expect(runs.length).toBe(1);
      const tag = runs[0]?.summary.campaign;
      expect(tag?.studyId).toBe("study_toy");
      expect(tag?.seed).toBe(17);
      expect(tag?.generation).toBe(generation);
    }
  }, 30_000);
});
