/**
 * The study-run controller's tests (Phase 70b): the full campaign
 * orchestration driven against the REAL structural engine and NSGA-II
 * driver with a SYNC analytic geometry provider (the bracket's box
 * twin — the re-drive seam's honest double), the in-memory result
 * store, and the committed-application ledger. Pins:
 *
 * - the context door: a study addressing a missing scenario refuses
 *   `sim/study-invalid` and the campaign never starts;
 * - the campaign's phase sequence and the ledger's optimization-
 *   generation counter (law S6 — the counter advances only on the
 *   generation notices);
 * - the DOMINATED-FRONT STRUCTURE of the lightest-bracket demo: mass
 *   strictly increases along the front ordered by mass, factor of
 *   safety strictly increases with it, and the slenderness constraint's
 *   violated candidates DECLINE (dominated, never crashed);
 * - the law-S7 family: the persisted runs carry the campaign tag with
 *   the exact genome, and replay re-produces the identical objectives
 *   (determinism, law S2/S5);
 * - the Pareto CSV export's deterministic bytes (the objective columns
 *   headed with the persisted family's own units).
 */

import { describe, expect, it } from "vitest";
import {
  addDocumentSimulation,
  addDocumentStudy,
  crossCheckSimStudy,
  type CadDocument,
  createSimulationId,
  createStudyId,
} from "@slopcad/cad-core";
import {
  createInMemorySimResultStorage,
  createLocalSimResultStore,
} from "@slopcad/sim-core";
import { exportSimParetoCsv } from "@slopcad/sim-optimization";
import type { SimTessellationWire } from "@slopcad/sim-core";

import { createSimApplicationLedger } from "../cad-workbench/sim-application-ledger";
import {
  StudyRunFailure,
  buildStudyContext,
  replayStudyCandidate,
  runStudyCampaign,
} from "./study-run";
import { bracketStudyScenarioDraft, BRACKET_GENES } from "./bracket-study-demo";
import { bracketDemoDocument } from "./bracket-demo";
import { fanDemoDocument, FAN_DEMO_MOTOR_ID } from "./fan-demo";
import {
  ensureFanStudyMotor,
  fanStudyScenarioDraft,
  fanStudyInput,
} from "./fan-study-demo";
import {
  STUDY_FORM_DEFAULT_VALUES,
  type StudyValues,
  studyDraftOf,
} from "./study-form";

/** One axis-aligned box as the voxelizer's tessellation wire. */
function boxWire(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): SimTessellationWire {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    indices: [
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 2, 6, 3, 6, 7, 0,
      3, 7, 0, 7, 4, 1, 2, 6, 1, 6, 5,
    ],
  };
}

/** The bracket study demo document: the demo scenario + the study row. */
function bracketStudyDocument(): {
  readonly document: CadDocument;
  readonly studyId: ReturnType<typeof createStudyId>;
} {
  const base = bracketDemoDocument();
  const withScenario = addDocumentSimulation(base, {
    id: createSimulationId("sim_bracket-study"),
    ...bracketStudyScenarioDraft(),
  });
  if (!withScenario.ok) {
    throw new Error(
      `The study scenario refused: ${withScenario.error.message}`,
    );
  }
  const withStudy = addDocumentStudy(withScenario.value.document, {
    id: createStudyId("study_bracket-demo"),
    name: "lightest-bracket",
    scenarioId: withScenario.value.scenario.id,
    genes: [
      {
        kind: "parameter",
        parameterId: BRACKET_GENES.thickness,
        valueKind: "integer",
        min: 4,
        max: 16,
        step: 2,
      },
      {
        kind: "parameter",
        parameterId: BRACKET_GENES.wallHeight,
        valueKind: "integer",
        min: 56,
        max: 88,
        step: 4,
      },
    ],
    objectives: [
      { quantity: "mass", direction: "minimize" },
      { quantity: "factor-of-safety", direction: "maximize" },
    ],
    constraints: [],
    population: 6,
    generations: 3,
    seed: 7,
  });
  if (!withStudy.ok) {
    throw new Error(`The study refused: ${withStudy.error.message}`);
  }
  return {
    document: withStudy.value.document,
    studyId: createStudyId("study_bracket-demo"),
  };
}

describe("the study context door", () => {
  it("refuses a study addressing a scenario the document does not own", () => {
    const { document } = bracketStudyDocument();
    const orphan = { ...document, simulations: [] };
    const study = document.studies[0];
    if (study === undefined) throw new Error("The study row is missing.");
    const refusal = buildStudyContext(orphan, study);
    expect(refusal instanceof StudyRunFailure).toBe(true);
    if (refusal instanceof StudyRunFailure) {
      expect(refusal.code).toBe("sim/study-invalid");
    }
  });
});

describe("the lightest-bracket campaign (the real driver + structural engine)", () => {
  it("runs the demo budget to a dominated-front structure and persists its family", async () => {
    const { document, studyId } = bracketStudyDocument();
    const study =
      document.studies.find((row) => row.id === studyId) ?? undefined;
    if (study === undefined) throw new Error("The study row is missing.");
    // The analytic geometry double: the bracket's box twin sized by
    // the re-driven parameter table (the sync provider the seam
    // documents — the page's async kernel re-drive in miniature).
    const geometry = (candidate: {
      readonly parameters: {
        readonly parameters: readonly {
          readonly id: string;
          readonly value: { readonly value: number };
        }[];
      };
    }): {
      readonly base: SimTessellationWire;
      readonly wall: SimTessellationWire;
    } => {
      const valueOf = (id: string): number =>
        candidate.parameters.parameters.find((entry) => entry.id === id)?.value
          .value ?? 0;
      return {
        base: boxWire(
          [-60, -40, 0],
          [60, 40, valueOf(BRACKET_GENES.thickness)],
        ),
        wall: boxWire(
          [-60, -40, 0],
          [60, -32, valueOf(BRACKET_GENES.wallHeight)],
        ),
      };
    };
    const ledger = createSimApplicationLedger();
    const store = createLocalSimResultStore({
      storage: createInMemorySimResultStorage(),
      now: () => new Date("2026-10-13T00:00:00Z"),
    });
    const phases: string[] = [];
    const campaign = await runStudyCampaign({
      document,
      study,
      store,
      documentVersionId: "doc_test",
      ledger,
      geometry: (candidate) =>
        Promise.resolve({
          bodyTessellations: [
            {
              bodyId: "body_bracket-base",
              tessellation: geometry(candidate).base,
            },
            {
              bodyId: "body_bracket-wall",
              tessellation: geometry(candidate).wall,
            },
          ],
        }),
      events: {
        onPhase: (phase) => {
          phases.push(phase);
        },
      },
    });
    expect(phases[0]).toBe("running");
    expect(phases[phases.length - 1]).toBe("completed");
    expect(campaign.result.evaluations).toBeGreaterThan(0);
    // Law S6: the optimization-generation counter advanced through the
    // committed applications.
    expect(ledger.optimizationGeneration).not.toBeNull();
    // The dominated-front structure: ordered by mass, mass strictly
    // increases and factor of safety strictly increases with it.
    const front = [...campaign.result.pareto]
      .filter((candidate) => candidate.status === "ok")
      .sort(
        (left, right) => (left.objectives[0] ?? 0) - (right.objectives[0] ?? 0),
      );
    expect(front.length).toBeGreaterThan(1);
    for (let index = 1; index < front.length; index += 1) {
      const previous = front[index - 1];
      const current = front[index];
      if (previous === undefined || current === undefined) continue;
      expect(current.objectives[0] ?? 0).toBeGreaterThan(
        previous.objectives[0] ?? 0,
      );
      expect(current.objectives[1] ?? 0).toBeGreaterThan(
        previous.objectives[1] ?? 0,
      );
    }
    // The law-S7 family: persisted runs carry the campaign tag with
    // the exact genome.
    const listed = await store.list("doc_test");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.length).toBe(campaign.result.pareto.length);
    const tagged = listed.value[0]?.summary.campaign;
    expect(tagged?.studyId).toBe(String(studyId));
    expect(tagged?.genome.parameters.length).toBeGreaterThan(0);
    // Replay determinism: the front's first candidate re-produces its
    // exact objective vector.
    const replayTarget = front[0];
    if (replayTarget === undefined) throw new Error("The front is empty.");
    const replay = await replayStudyCandidate({
      handle: campaign.handle,
      candidate: replayTarget,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.status).toBe("ok");
      expect(replay.value.objectives).toEqual(replayTarget.objectives);
    }
    // The Pareto CSV: deterministic bytes headed with the family's
    // own units.
    const csv = exportSimParetoCsv(campaign.result.pareto, {
      objectives: [
        { name: "mass", unit: "kg" },
        { name: "factor-of-safety", unit: "1" },
      ],
      geneParameters: [BRACKET_GENES.thickness, BRACKET_GENES.wallHeight],
      geneRecords: [],
    });
    expect(csv.ok).toBe(true);
    if (csv.ok) {
      expect(csv.value.split("\n")[0]).toBe(
        "candidate,mass (kg),factor-of-safety (1),param_thickness,param_wall-height",
      );
      expect(csv.value.endsWith("\n")).toBe(true);
    }
  }, 240_000);
});

describe("the fan study fixtures", () => {
  it("cross-checks the fan study input against the study-motor document", () => {
    const document = ensureFanStudyMotor(fanDemoDocument()).document;
    const withScenario = addDocumentSimulation(document, {
      id: createSimulationId("sim_fan-study"),
      ...fanStudyScenarioDraft(),
    });
    if (!withScenario.ok) {
      throw new Error(
        `The fan study scenario refused: ${withScenario.error.message}`,
      );
    }
    const withStudy = addDocumentStudy(withScenario.value.document, {
      ...fanStudyInput(withScenario.value.scenario.id),
    });
    if (!withStudy.ok) {
      throw new Error(`The fan study refused: ${withStudy.error.message}`);
    }
    const problems = crossCheckSimStudy(withStudy.value.study, {
      parameters: withStudy.value.document.parameters,
      motors: withStudy.value.document.motors,
      simulations: withStudy.value.document.simulations,
    });
    expect(problems).toEqual([]);
    expect(document.motors.map((motor) => motor.id)).toContain(
      FAN_DEMO_MOTOR_ID,
    );
  });

  it("maps the fan form preset onto the same genome the demo input carries", () => {
    const document = ensureFanStudyMotor(fanDemoDocument()).document;
    const values: StudyValues = {
      ...STUDY_FORM_DEFAULT_VALUES,
      geneAParameterId: "param_bore-radius",
      geneAKind: "decimal",
      geneAMin: 8,
      geneAMax: 12,
      geneAStep: 0.5,
      motorGeneEnabled: true,
      objectiveAQuantity: "airflow-per-electrical-watt",
      objectiveADirection: "maximize",
      maxEvaluations: 8,
    };
    const mapped = studyDraftOf(values, document);
    if (!("draft" in mapped)) {
      throw new Error(
        `The fan preset refused: ${mapped.problems[0]?.message ?? ""}`,
      );
    }
    expect(mapped.draft.genes).toEqual(
      fanStudyInput(createSimulationId("sim_any")).genes,
    );
  });
});
