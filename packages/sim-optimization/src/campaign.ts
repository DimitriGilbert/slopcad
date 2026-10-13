/**
 * Campaign persistence and export (Phase 70a, law S7): optimization runs
 * persist as VERSIONED RUN FAMILIES through the SimResultStore — every
 * persisted candidate carries a campaign tag on its summary (the
 * additive `campaign` field of `SimResultSummary`) keying it to its
 * deterministic family (study content + seed hash), its generation, its
 * evaluation index, and its EXACT genome, so any stored campaign member
 * replays from its own record.
 *
 * The selection discipline: a campaign's every-generation survivors are
 * already logged in the run result (the wire data); the STORE carries the
 * chosen subset — the best candidate of each generation
 * (`best-per-generation`, the live-preview story persisted) or the final
 * Pareto front (`pareto`, the export story) — each as a full run with its
 * field payloads, statuses, and S9 provenance intact.
 *
 * The Pareto CSV export is byte-deterministic: LF line endings, the
 * quoting-free dialect (labels free of commas/quotes/newlines), the
 * shared deterministic float formatter, fixed column order, candidates
 * ordered by evaluation index, trailing newline — identical fronts
 * export to identical bytes (the history-CSV exporter's discipline).
 *
 * The fitness-landscape caveat travels with the campaign: multi-seed
 * campaigns are the named mitigation for the voxel staircase's
 * plateaus/jumps, and the family key encodes the seed precisely so rungs
 * of a multi-seed campaign stay distinguishable in the store.
 */

import type { SimStudy } from "@slopcad/cad-core";
import {
  type SimError,
  type SimResult,
  type SimResultCampaignTag,
  type SimResultRunRecord,
  type SimResultStore,
  type SimParseResult,
  type WorkerSimOptimizeCandidate,
  formatSimFloat,
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
} from "@slopcad/sim-core";

import { type AuthoredGenome } from "./genome";
import {
  type SimOptimizationCandidateEvaluation,
  type SimOptimizationHostServices,
  type SimOptimizationRunContext,
  type SimOptimizationRunOutcome,
  evaluateAuthoredGenome,
  simCampaignFamilyId,
} from "./evaluate";

/** A selected candidate with the generation it was selected FROM. */
export interface SimCampaignSelectionEntry {
  readonly candidate: WorkerSimOptimizeCandidate;
  readonly generation: number;
}

/** Which candidates of a completed campaign persist as family runs. */
export type SimCampaignSelection = "best-per-generation" | "pareto";

/**
 * The candidates a selection extracts from a campaign outcome, each with
 * the generation it was selected from (best-of-its-generation for
 * `best-per-generation`; the final generation for `pareto`).
 */
export function selectSimCampaignCandidates(
  outcome: SimOptimizationRunOutcome,
  selection: SimCampaignSelection,
): readonly SimCampaignSelectionEntry[] {
  if (outcome.result === undefined) return [];
  if (selection === "pareto") {
    const finalGeneration =
      outcome.result.generations[outcome.result.generations.length - 1]
        ?.generation ?? 0;
    return outcome.result.pareto.map((candidate) => ({
      candidate,
      generation: finalGeneration,
    }));
  }
  const selected: SimCampaignSelectionEntry[] = [];
  for (const generation of outcome.result.generations) {
    const best = generation.candidates.find(
      (candidate) => candidate.status === "ok",
    );
    if (best !== undefined) {
      selected.push({ candidate: best, generation: generation.generation });
    }
  }
  return selected;
}

/** Builds the campaign tag of one persisted candidate. */
function campaignTag(
  study: SimStudy,
  family: string,
  entry: SimCampaignSelectionEntry,
): SimResultCampaignTag {
  const candidate = entry.candidate;
  return {
    studyId: study.id,
    family,
    generation: entry.generation,
    candidate: candidate.index,
    seed: study.seed,
    genome: {
      parameters: candidate.genomeParameters.map((entryParameter) => ({
        parameterId: entryParameter.parameterId,
        value: entryParameter.value,
      })),
      records: candidate.genomeRecords.map((entryRecord) => ({
        recordKind: entryRecord.recordKind,
        recordId: entryRecord.recordId,
      })),
    },
  };
}

/**
 * Persists a campaign's selected candidates through the store as
 * family-tagged runs, sequentially (deterministic put order). Returns the
 * minted run records in the same order as the selection. A candidate
 * whose solve result is missing (a declined best, a log/evaluation
 * disagreement) refuses `sim/result-record-malformed` — never a fake run.
 */
export async function persistSimCampaign(
  store: SimResultStore,
  documentVersionId: string,
  study: SimStudy,
  outcome: SimOptimizationRunOutcome,
  selection: SimCampaignSelection,
): Promise<SimParseResult<readonly SimResultRunRecord[], SimError>> {
  if (outcome.result === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.resultRecordMalformed,
        "An aborted campaign persists nothing.",
        outcome.campaign,
      ),
    );
  }
  const family = simCampaignFamilyId(study);
  const records: SimResultRunRecord[] = [];
  for (const entry of selectSimCampaignCandidates(outcome, selection)) {
    const result = outcome.candidateResults?.get(entry.candidate.index);
    if (result === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.resultRecordMalformed,
          `The campaign candidate ${String(entry.candidate.index)} has no solve result to persist.`,
          entry.candidate,
        ),
      );
    }
    const tagged: SimResult = Object.freeze({
      ...result,
      summary: Object.freeze({
        ...result.summary,
        campaign: Object.freeze(campaignTag(study, family, entry)),
      }),
    });
    const put = await store.put(documentVersionId, tagged);
    if (!put.ok) return put;
    records.push(put.value);
  }
  return simOk(records);
}

/** One campaign family's runs, grouped by generation (insertion order). */
export type SimCampaignFamily = ReadonlyMap<
  number,
  readonly SimResultRunRecord[]
>;

/**
 * Groups a version's stored runs into campaign families: only runs whose
 * summaries carry a campaign tag participate, keyed by family id; within
 * a family, runs group by generation, preserving the store's
 * chronological order (the `groupSimResultRunsBySnapshotHash` precedent).
 */
export function groupSimCampaignFamilies(
  runs: readonly SimResultRunRecord[],
): ReadonlyMap<string, SimCampaignFamily> {
  const families = new Map<string, Map<number, SimResultRunRecord[]>>();
  for (const run of runs) {
    const tag = run.summary.campaign;
    if (tag === undefined) continue;
    let byGeneration = families.get(tag.family);
    if (byGeneration === undefined) {
      byGeneration = new Map<number, SimResultRunRecord[]>();
      families.set(tag.family, byGeneration);
    }
    const bucket = byGeneration.get(tag.generation);
    if (bucket === undefined) {
      byGeneration.set(tag.generation, [run]);
    } else {
      bucket.push(run);
    }
  }
  return families;
}

/** One CSV column: a bare label header and numeric or textual values. */
export interface SimParetoColumn {
  readonly header: string;
  readonly kind: "number" | "text";
}

/** The columns a Pareto export renders: candidate, objectives, genes. */
export interface SimParetoCsvColumns {
  /** The objective columns, in study order — `name (unit)` headers. */
  readonly objectives: readonly {
    readonly name: string;
    readonly unit: string;
  }[];
  /** The parameter-gene columns, in genome order — the parameter ids. */
  readonly geneParameters: readonly string[];
  /** The discrete-gene columns, in genome order — the record families. */
  readonly geneRecords: readonly string[];
}

function isBareLabel(value: string): boolean {
  return value.length > 0 && !/[",\r\n]/.test(value);
}

/**
 * Exports a Pareto front (or any candidate list) as deterministic CSV:
 * columns `candidate`, the objective columns, the parameter-gene columns,
 * then the record-gene columns; rows ordered by evaluation index;
 * numbers through the shared deterministic formatter; LF endings and a
 * trailing newline. Labels needing quoting decline structured — the
 * quoting-free dialect.
 */
export function exportSimParetoCsv(
  candidates: readonly WorkerSimOptimizeCandidate[],
  columns: SimParetoCsvColumns,
): SimParseResult<string, SimError> {
  for (const column of columns.objectives) {
    if (!isBareLabel(column.name) || !isBareLabel(column.unit)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          "A Pareto CSV objective column's name and unit must be non-empty labels free of commas, quotes, and newlines (the quoting-free dialect).",
          column,
        ),
      );
    }
  }
  for (const label of columns.geneParameters) {
    if (!isBareLabel(label)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          "A Pareto CSV gene column label must be a non-empty label free of commas, quotes, and newlines (the quoting-free dialect).",
          label,
        ),
      );
    }
  }
  for (const label of columns.geneRecords) {
    if (!isBareLabel(label)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          "A Pareto CSV record-gene column label must be a non-empty label free of commas, quotes, and newlines (the quoting-free dialect).",
          label,
        ),
      );
    }
  }
  const header = [
    "candidate",
    ...columns.objectives.map((column) => `${column.name} (${column.unit})`),
    ...columns.geneParameters,
    ...columns.geneRecords,
  ].join(",");
  const lines: string[] = [header];
  const ordered = [...candidates].sort(
    (left, right) => left.index - right.index,
  );
  for (const candidate of ordered) {
    if (candidate.status !== "ok") {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          "A Pareto CSV export carries only scored candidates; a declined candidate has no objective row.",
          candidate,
        ),
      );
    }
    if (candidate.objectives.length !== columns.objectives.length) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          "A Pareto CSV candidate's objective vector disagrees with the declared objective columns.",
          candidate,
        ),
      );
    }
    const cells: string[] = [String(candidate.index)];
    for (const value of candidate.objectives) {
      if (!Number.isFinite(value)) {
        return simFail(
          simError(
            SIM_ERROR_CODES.quantityInvalid,
            "A Pareto CSV candidate carries a non-finite objective.",
            candidate,
          ),
        );
      }
      cells.push(formatSimFloat(value));
    }
    for (const entry of candidate.genomeParameters) {
      cells.push(formatSimFloat(entry.value));
    }
    for (const entry of candidate.genomeRecords) {
      if (!isBareLabel(entry.recordId)) {
        return simFail(
          simError(
            SIM_ERROR_CODES.quantityInvalid,
            "A Pareto CSV record-gene choice must be a bare label (the quoting-free dialect).",
            entry.recordId,
          ),
        );
      }
      cells.push(entry.recordId);
    }
    lines.push(cells.join(","));
  }
  return simOk(`${lines.join("\n")}\n`);
}

/**
 * Rebuilds an authored genome from a persisted or wire candidate's genome
 * assignments: parameter ids map back to their gene positions by id,
 * record ids to their choice indices — the exact replay inputs.
 */
export function authoredGenomeFromAssignments(
  study: SimStudy,
  parameters: readonly {
    readonly parameterId: string;
    readonly value: number;
  }[],
  records: readonly {
    readonly recordKind: string;
    readonly recordId: string;
  }[],
): SimParseResult<AuthoredGenome, SimError> {
  const byParameterId = new Map(
    parameters.map((entry) => [entry.parameterId, entry.value] as const),
  );
  const numericValues: number[] = [];
  const choiceIndices: number[] = [];
  for (const gene of study.genes) {
    if (gene.kind === "parameter") {
      const value = byParameterId.get(gene.parameterId);
      if (value === undefined) {
        return simFail(
          simError(
            SIM_ERROR_CODES.studyInvalid,
            `The replay genome lacks a value for gene parameter "${gene.parameterId}".`,
            gene.parameterId,
          ),
        );
      }
      numericValues.push(value);
      continue;
    }
    const record = records.find(
      (entry) => entry.recordKind === gene.recordKind,
    );
    if (record === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.studyInvalid,
          `The replay genome lacks a choice for the discrete "${gene.recordKind}" gene.`,
          gene.recordKind,
        ),
      );
    }
    const choice = gene.choices.findIndex(
      (candidate) => candidate === record.recordId,
    );
    if (choice < 0) {
      return simFail(
        simError(
          SIM_ERROR_CODES.studyInvalid,
          `The replay genome's choice "${record.recordId}" is not one of the study's discrete gene choices.`,
          record.recordId,
        ),
      );
    }
    choiceIndices.push(choice);
  }
  return simOk({ numericValues, choiceIndices });
}

/**
 * Replays one candidate: its exact genome against the same document
 * context — the same evaluation pipeline, hence (with deterministic
 * engines) the identical objective vector and result.
 */
export async function replaySimCandidate(
  context: SimOptimizationRunContext,
  host: SimOptimizationHostServices,
  candidate: WorkerSimOptimizeCandidate,
): Promise<SimParseResult<SimOptimizationCandidateEvaluation, SimError>> {
  const genome = authoredGenomeFromAssignments(
    context.study,
    candidate.genomeParameters,
    candidate.genomeRecords,
  );
  if (!genome.ok) return simFail(genome.error);
  return simOk(await evaluateAuthoredGenome(context, host, genome.value));
}
