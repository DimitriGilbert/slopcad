import { describe, expect, it } from "vitest";
import {
  serializeDocumentMotor,
  serializeParameterCollection,
  serializeSimStudy,
} from "@slopcad/cad-core";
import {
  createInMemorySimResultStorage,
  createLocalSimResultStore,
  type WorkerSimOptimizeCandidate,
} from "@slopcad/sim-core";

import {
  authoredGenomeFromAssignments,
  exportSimParetoCsv,
  groupSimCampaignFamilies,
  persistSimCampaign,
  replaySimCandidate,
  selectSimCampaignCandidates,
} from "./campaign";
import { buildSimOptimizationRunContext, runSimOptimization } from "./evaluate";
import {
  TOY_PLATE_DEPTH_MM,
  TOY_DENSITY_G_PER_MM3,
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

const frontCandidate = (
  index: number,
  cells: number,
): WorkerSimOptimizeCandidate => ({
  index,
  genomeParameters: [
    { parameterId: "param_width", value: 7 },
    { parameterId: "param_height", value: Math.max(2, cells) },
  ],
  genomeRecords: [],
  status: "ok",
  objectives: [cells * TOY_PLATE_DEPTH_MM * TOY_DENSITY_G_PER_MM3, 1e6 / cells],
  rank: 0,
});

describe("the campaign family (S7 persistence)", () => {
  it("persists the Pareto selection and replays any candidate exactly", async () => {
    const study = toyStudy({
      objectives: [
        { quantity: "mass", direction: "minimize" },
        { quantity: "deflection", direction: "minimize" },
      ],
      population: 12,
      generations: 6,
      seed: 33,
    });
    const context = toyContext(study);
    const outcome = await runSimOptimization(context, {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    if (outcome.result === undefined) throw new Error("no result");
    const store = createLocalSimResultStore({
      storage: createInMemorySimResultStorage(),
    });
    const persisted = await persistSimCampaign(
      store,
      "docver_pareto",
      study,
      outcome,
      "pareto",
    );
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value.length).toBe(outcome.result.pareto.length);
    const listed = await store.list("docver_pareto");
    if (!listed.ok) throw new Error(listed.error.message);
    const families = groupSimCampaignFamilies(listed.value);
    expect(families.size).toBe(1);
    const family = families.get(outcome.campaign);
    expect(family).toBeDefined();
    // The pareto selection carries the FINAL generation tag on every run.
    for (const runs of family?.values() ?? []) {
      for (const run of runs) {
        expect(run.summary.campaign?.generation).toBe(5);
      }
    }
    // Replay: every persisted front candidate reproduces its objective
    // vector exactly from its stored genome (the tag's replay inputs).
    for (const record of listed.value) {
      const tag = record.summary.campaign;
      if (tag === undefined) continue;
      const candidate: WorkerSimOptimizeCandidate = {
        index: tag.candidate,
        genomeParameters: tag.genome.parameters.map((entry) => ({
          parameterId: entry.parameterId,
          value: entry.value,
        })),
        genomeRecords: tag.genome.records.map((entry) => ({
          recordKind: entry.recordKind,
          recordId: entry.recordId,
        })),
        status: "ok",
        objectives: [],
        rank: 0,
      };
      const replayed = await replaySimCandidate(
        context,
        {
          engines: [createToyMassEngine({})],
          geometry: toyGeometryProvider(),
        },
        candidate,
      );
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) return;
      const mass = record.summary.quantities.find((q) => q.name === "mass");
      expect(replayed.value.status).toBe("ok");
      if (replayed.value.status !== "ok") return;
      expect(replayed.value.objectives[0]).toBe(mass?.value);
    }
  }, 30_000);

  it("exports the Pareto front as deterministic CSV bytes", () => {
    const columns = {
      objectives: [
        { name: "mass", unit: "g" },
        { name: "deflection", unit: "mm" },
      ],
      geneParameters: ["param_width", "param_height"],
      geneRecords: [],
    };
    const first = exportSimParetoCsv(
      [frontCandidate(3, 105), frontCandidate(1, 121), frontCandidate(2, 143)],
      columns,
    );
    const again = exportSimParetoCsv(
      [frontCandidate(3, 105), frontCandidate(1, 121), frontCandidate(2, 143)],
      columns,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toBe(first.value);
    // Rows order by evaluation index, numbers by the shared formatter.
    expect(first.value.split("\n")[0]).toBe(
      "candidate,mass (g),deflection (mm),param_width,param_height",
    );
    expect(first.value.split("\n")[1]).toContain("1,");
    expect(first.value.endsWith("\n")).toBe(true);
    // A different front is different bytes.
    const other = exportSimParetoCsv(
      [frontCandidate(3, 105), frontCandidate(1, 121)],
      columns,
    );
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.value).not.toBe(first.value);
    // Labels needing quoting decline structured.
    const refused = exportSimParetoCsv([frontCandidate(1, 4)], {
      objectives: [{ name: 'mass "x"', unit: "g" }],
      geneParameters: [],
      geneRecords: [],
    });
    expect(refused.ok).toBe(false);
    // Declined candidates never ride a Pareto export.
    const declined = exportSimParetoCsv(
      [
        {
          index: 0,
          genomeParameters: [],
          genomeRecords: [],
          status: "declined",
          objectives: [],
          declineCode: "sim/run-diverged",
          rank: 0,
        },
      ],
      columns,
    );
    expect(declined.ok).toBe(false);
  });

  it("selects best-per-generation with the selection's own generation", async () => {
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
      population: 8,
      generations: 3,
      seed: 77,
    });
    const outcome = await runSimOptimization(toyContext(study), {
      engines: [createToyMassEngine({})],
      geometry: toyGeometryProvider(),
    });
    if (outcome.result === undefined) throw new Error("no result");
    const selected = selectSimCampaignCandidates(
      outcome,
      "best-per-generation",
    );
    expect(selected.length).toBe(outcome.result.generations.length);
    const generations = selected.map((entry) => entry.generation);
    expect(generations).toEqual([0, 1, 2]);
    for (const entry of selected) {
      expect(entry.candidate.status).toBe("ok");
    }
  }, 30_000);

  it("refuses a replay genome that leaves the study's gene set", () => {
    const study = toyStudy({
      objectives: [{ quantity: "mass", direction: "minimize" }],
    });
    const missing = authoredGenomeFromAssignments(study, [], []);
    expect(missing.ok).toBe(false);
    const wrongChoice = authoredGenomeFromAssignments(
      toyStudy({
        objectives: [{ quantity: "mass", direction: "minimize" }],
        motorGene: true,
      }),
      [
        { parameterId: "param_width", value: 10 },
        { parameterId: "param_height", value: 10 },
      ],
      [{ recordKind: "motor", recordId: "mot_unknown" }],
    );
    expect(wrongChoice.ok).toBe(false);
  });
});
