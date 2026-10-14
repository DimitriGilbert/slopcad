/**
 * The workbench's study-run controller (Phase 70b): the orchestration
 * that turns one saved {@link SimStudy} record into a persisted campaign
 * — the 70a batch-spine driver (`runSimOptimization`) hosted on the MAIN
 * thread with the workbench's routed engines, the per-candidate geometry
 * re-drive provided by the page's render session (the async provider
 * seam: every candidate's re-driven document dispatches through the real
 * kernel worker, the settle's per-body tessellations become the compile
 * geometry, and the viewport SHOWS each re-drive — the visible-evaluation
 * story), every generation notice applied through the committed-
 * application ledger (law S6 — the `data-sim-*` counters advance only on
 * committed applications), and the selected candidates persisted as
 * family-tagged runs through the law-S7 store (`persistSimCampaign`).
 *
 * The engine composition mirrors the sim worker entry's routed engine
 * (`./sim-worker-entry`) — dynamics to the dynamics engine, combustion
 * to the combustion engine, structural to the structural engine, every
 * other kind to the flow package's routed default — because THIS host
 * runs the same engines the worker serves, on the main thread, where
 * the geometry provider lives beside them (a function cannot cross the
 * worker wire; the host seam is the design, not a compromise).
 */

import type {
  CadDocument,
  DocumentMotorRecord,
  ParameterCollection,
  SimStudy,
} from "@slopcad/cad-core";
import {
  serializeDocumentMotor,
  serializeParameterCollection,
  serializeSimScenario,
  serializeSimStudy,
} from "@slopcad/cad-core";
import type {
  SimEngine,
  SimResultStore,
  SimWorkerNotification,
  WorkerSimOptimizeResult,
} from "@slopcad/sim-core";
import { createDefaultSimEngine } from "@slopcad/sim-flow";
import {
  type SimOptimizationGeometry,
  type SimOptimizationRunContext,
  type SimOptimizationRunOutcome,
  buildSimOptimizationRunContext,
  persistSimCampaign,
  replaySimCandidate,
  runSimOptimization,
} from "@slopcad/sim-optimization";
import { createCombustionSimEngine } from "@slopcad/sim-combustion";
import { createDynamicsSimEngine } from "@slopcad/sim-dynamics";
import { createStructuralSimEngine } from "@slopcad/sim-structural";
import type {
  SimAppliedCounters,
  SimApplicationLedger,
} from "../cad-workbench/sim-application-ledger";

import { applySimNotification } from "../cad-workbench/sim-application-ledger";
import { structuralMaterialPresetOf } from "./structural-materials";
import { thermalMaterialPresetOf } from "./thermal-materials";

/** The campaign's user-visible phases, in order. */
export type StudyRunPhase = "running" | "persisting" | "completed" | "failed";

/** One committed application the campaign's notices produce. */
export interface StudyRunEvents {
  onPhase?: (phase: StudyRunPhase, detail?: string) => void;
  /** Every committed ledger application (a generation or a progress step). */
  onApplied?: (counters: SimAppliedCounters) => void;
}

/** The completed campaign: the run outcome plus the persisted records. */
export interface StudyRunOutcome {
  readonly outcome: SimOptimizationRunOutcome;
  readonly result: WorkerSimOptimizeResult;
  /** The campaign's context and re-drive service (the replay handle). */
  readonly handle: StudyCampaignHandle;
}

/** A structured campaign failure: the `sim/*` code and its message. */
export class StudyRunFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StudyRunFailure";
    this.code = code;
  }
}

/**
 * The study host's geometry re-drive service: given the re-driven
 * parameter table (the candidate's gene literals with every expression
 * re-derived) and the candidate's motor choice, the compile geometry.
 * The page's implementation dispatches the re-driven document through
 * the render session's kernel worker and awaits the settle — so the
 * tessellations are the REAL re-driven geometry, and the viewport shows
 * each candidate as it is evaluated.
 */
export type StudyGeometryRedrive = (candidate: {
  readonly parameters: ParameterCollection;
  readonly motor: DocumentMotorRecord | undefined;
}) => Promise<SimOptimizationGeometry>;

/** What a study needs beside its own record: the page's services. */
export interface StudyRunOptions {
  /** The working document the study's records address. */
  readonly document: CadDocument;
  /** The saved study record (already in the document's studies section). */
  readonly study: SimStudy;
  /** The document's persisted run store (law S7). */
  readonly store: SimResultStore;
  /** The runs persist against this document version id. */
  readonly documentVersionId: string;
  /** The Phase 61d ledger the campaign's notices apply through (law S6). */
  readonly ledger: SimApplicationLedger;
  /** The host's per-candidate geometry re-drive (the render session). */
  readonly geometry: StudyGeometryRedrive;
  readonly events?: StudyRunEvents;
}

/** The study campaign's replay surface (the same context and host). */
export interface StudyCampaignHandle {
  readonly context: SimOptimizationRunContext;
  readonly geometry: StudyGeometryRedrive;
}

/** Options of {@link replayStudyCandidate}. */
export interface StudyReplayOptions {
  readonly handle: StudyCampaignHandle;
  readonly candidate: Parameters<typeof replaySimCandidate>[2];
}

/** The workbench's routed study engine (the worker entry's composition). */
export function createWorkbenchStudyEngine(): SimEngine {
  const routed = createDefaultSimEngine();
  const dynamics = createDynamicsSimEngine();
  const combustion = createCombustionSimEngine();
  const structural = createStructuralSimEngine();
  return {
    id: "workbench-study-sim",
    supportedKinds: [
      ...new Set([
        ...routed.supportedKinds,
        ...dynamics.supportedKinds,
        ...combustion.supportedKinds,
        ...structural.supportedKinds,
      ]),
    ],
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) => {
      if (dynamics.supportedKinds.includes(request.compiled.kind)) {
        return dynamics.run(request, onProgress, onFieldChunk);
      }
      if (combustion.supportedKinds.includes(request.compiled.kind)) {
        return combustion.run(request, onProgress, onFieldChunk);
      }
      if (structural.supportedKinds.includes(request.compiled.kind)) {
        return structural.run(request, onProgress, onFieldChunk);
      }
      return routed.run(request, onProgress, onFieldChunk);
    },
  };
}

/**
 * Builds the 70a run context from the working document: the serialized
 * study, its scenario, the document's parameter table, every motor
 * record the discrete genes may choose, and the scenario's material
 * RECORDS — the assignments name preset ids, the compile wire carries
 * the records (the page's own run path discipline, restated for the
 * campaign). A structured `sim/study-invalid` refusal surfaces as
 * {@link StudyRunFailure} — the campaign never starts on a study that
 * does not cross-check.
 */
export function buildStudyContext(
  document: CadDocument,
  study: SimStudy,
): StudyCampaignHandle["context"] | StudyRunFailure {
  const scenario = document.simulations.find(
    (candidate) => candidate.id === study.scenarioId,
  );
  if (scenario === undefined) {
    return new StudyRunFailure(
      "sim/study-invalid",
      `The study addresses scenario "${study.scenarioId}", which the working document does not own (re-save the study after switching models).`,
    );
  }
  // The material records the scenario's assignments name — the same
  // preset resolution the page's run path performs (structural presets
  // for structural scenarios, thermal presets otherwise).
  const materialsWithMaps =
    scenario.kind === "thermal" ||
    scenario.kind === "structural" ||
    (scenario.kind === "combustion" && scenario.combustion?.mode === "stove");
  const materials = materialsWithMaps
    ? scenario.materials.map((assignment) =>
        scenario.kind === "structural"
          ? structuralMaterialPresetOf(assignment.materialId).record
          : thermalMaterialPresetOf(assignment.materialId).record,
      )
    : undefined;
  const context = buildSimOptimizationRunContext({
    study: serializeSimStudy(study),
    scenario: serializeSimScenario(scenario),
    parameters: serializeParameterCollection(document.parameters),
    motors: document.motors.map(serializeDocumentMotor),
    ...(materials === undefined ? {} : { materials }),
  });
  if (!context.ok) {
    return new StudyRunFailure(context.error.code, context.error.message);
  }
  return context.value;
}

/**
 * Runs one study campaign to a persisted family: NSGA-II over the
 * study's genome (deterministic, law S2/S5), every generation notice and
 * progress step applied through the committed-application ledger before
 * anything renders, and the final Pareto front persisted as family-tagged
 * runs (the exact genome on every summary — replay from the store).
 */
export async function runStudyCampaign(
  options: StudyRunOptions,
): Promise<StudyRunOutcome> {
  const { study, ledger, events } = options;
  const contextOrFailure = buildStudyContext(options.document, study);
  if (contextOrFailure instanceof StudyRunFailure) {
    events?.onPhase?.("failed", contextOrFailure.message);
    throw contextOrFailure;
  }
  const context = contextOrFailure;
  const engine = createWorkbenchStudyEngine();
  const geometry = options.geometry;
  const applyNotice = (notification: SimWorkerNotification): void => {
    const committed = applySimNotification(ledger, notification);
    if (committed !== null) events?.onApplied?.(committed);
  };
  events?.onPhase?.("running");
  let outcome: SimOptimizationRunOutcome;
  try {
    outcome = await runSimOptimization(context, {
      engines: [engine],
      geometry,
      onEvaluation: (total, budget) => {
        applyNotice({ kind: "progress", step: total, totalSteps: budget });
      },
      onGeneration: (notice) => {
        applyNotice({
          kind: "optimization-generation",
          generation: notice.generation,
          evaluated: notice.evaluated,
          budget: notice.budget,
          ...(notice.best === undefined ? {} : { best: [...notice.best] }),
        });
      },
    });
  } catch (error) {
    const failure =
      error instanceof StudyRunFailure
        ? error
        : new StudyRunFailure(
            "sim/optimization-failed",
            error instanceof Error ? error.message : String(error),
          );
    events?.onPhase?.("failed", failure.message);
    throw failure;
  }
  if (outcome.status !== "completed" || outcome.result === undefined) {
    const failure = new StudyRunFailure(
      "sim/optimization-aborted",
      "The campaign aborted before a front settled.",
    );
    events?.onPhase?.("failed", failure.message);
    throw failure;
  }
  events?.onPhase?.("persisting");
  const persisted = await persistSimCampaign(
    options.store,
    options.documentVersionId,
    study,
    outcome,
    "pareto",
  );
  if (!persisted.ok) {
    const failure = new StudyRunFailure(
      persisted.error.code,
      persisted.error.message,
    );
    events?.onPhase?.("failed", failure.message);
    throw failure;
  }
  events?.onPhase?.("completed");
  return {
    outcome,
    result: outcome.result,
    handle: { context, geometry },
  };
}

/**
 * Replays one candidate: its exact genome against the same document
 * context and the same re-drive service — the identical objective vector
 * with deterministic engines (the replay determinism the suite pins).
 */
export async function replayStudyCandidate(
  options: StudyReplayOptions,
): Promise<ReturnType<typeof replaySimCandidate>> {
  return replaySimCandidate(
    options.handle.context,
    {
      engines: [createWorkbenchStudyEngine()],
      geometry: options.handle.geometry,
    },
    options.candidate,
  );
}
