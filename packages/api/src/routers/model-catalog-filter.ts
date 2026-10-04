/**
 * The models.dev picker filter (agent chat, Phase 1.1 — PLAN-AGENT-CHAT.md
 * §1.1, recipe from docs/research/models-dev-api.md §4): narrows one
 * provider's raw `models` map down to the rows the model picker persists in
 * `model_catalog_entries`.
 *
 * Pure and dependency-free by design: the only moving part is `now`, which
 * production supplies as the wall clock and tests pin to the fixture's
 * capture date, so the same rules run deterministically forever. Rules:
 *
 * - vision — `"image"` appears in `modalities.input[]`;
 * - recency — `release_date ≥ now − 6 calendar months` (lexicographic
 *   comparison of `YYYY-MM-DD` strings);
 * - not deprecated — `status` is absent or anything but `"deprecated"`;
 * - no embedding families — embedding models accept image input yet are no
 *   picker candidates (the `gemini-embedding-2` false positive), so an
 *   id/name/family containing "embedding" is excluded;
 * - no OpenRouter `~`-prefixed alias ids — aliases of models that are
 *   already listed under their canonical id;
 * - malformed entries are skipped, never thrown on.
 *
 * The result is ordered by `releaseDate` descending, then `modelId`
 * ascending, so it is deterministic regardless of JSON key order.
 */

import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";

/** A row ready for `model_catalog_entries`, as the filter emits it. */
export interface FilteredCatalogEntry {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  readonly releaseDate: string;
  readonly vision: boolean;
  readonly contextLimit: number | null;
  readonly reasoningOptions: ModelReasoningOption[] | null;
  readonly deprecated: boolean;
}

/** models.dev `release_date` shape — a plain `YYYY-MM-DD` string. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string property value, or undefined. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The ISO date exactly six calendar months before `now` (UTC parts), the
 * recency cutoff. `Date.UTC` rolls negative months over correctly, so
 * e.g. March 15th reaches back to September 15th of the previous year.
 */
export function sixMonthsCutoffISO(now: Date): string {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, now.getUTCDate()),
  );
  const year = cutoff.getUTCFullYear();
  const month = `${cutoff.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${cutoff.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The embedding false-positive guard: models.dev marks embedding models
 * with image input as vision-capable because embeddings accept images.
 * Any of id, name, or family mentioning "embedding" disqualifies the
 * model from the picker.
 */
function isEmbeddingModel(
  modelId: string,
  raw: Record<string, unknown>,
): boolean {
  const family = readString(raw.family);
  const name = readString(raw.name);
  return (
    modelId.toLowerCase().includes("embedding") ||
    (name?.toLowerCase().includes("embedding") ?? false) ||
    (family?.toLowerCase().includes("embedding") ?? false)
  );
}

/** Does the model accept image input (the picker's vision requirement)? */
function acceptsImageInput(raw: Record<string, unknown>): boolean {
  const modalities = raw.modalities;
  if (!isRecord(modalities)) return false;
  const input = modalities.input;
  return Array.isArray(input) && input.includes("image");
}

/**
 * Narrows a raw `reasoning_options` value to well-formed entries, keeping
 * only the three documented types and their well-typed companions. Absent,
 * empty, or entirely malformed declarations collapse to null ("the model
 * declares none").
 */
function parseReasoningOptions(value: unknown): ModelReasoningOption[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: ModelReasoningOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (
      entry.type !== "effort" &&
      entry.type !== "budget_tokens" &&
      entry.type !== "toggle"
    ) {
      continue;
    }
    const option: ModelReasoningOption = { type: entry.type };
    const values = entry.values;
    if (Array.isArray(values)) {
      option.values = values.filter(
        (candidate): candidate is string => typeof candidate === "string",
      );
    }
    const min = entry.min;
    if (typeof min === "number" && Number.isFinite(min)) {
      option.min = min;
    }
    parsed.push(option);
  }
  return parsed.length > 0 ? parsed : null;
}

/**
 * Pulls one provider's `models` map out of a parsed models.dev `api.json`
 * payload (a top-level object keyed by provider id). Unknown shapes —
 * including a provider models.dev does not list — yield undefined, which
 * {@link filterProviderModels} treats as an empty catalog.
 */
export function extractProviderModels(
  payload: unknown,
  provider: string,
): unknown {
  if (!isRecord(payload)) return undefined;
  const rawProvider = payload[provider];
  if (!isRecord(rawProvider)) return undefined;
  return rawProvider.models;
}

/**
 * Filters one provider's models down to the picker's model rows. The input
 * is the unvalidated `models` value straight from the cached JSON; every
 * access is narrowed and anything malformed is skipped, so a surprising
 * upstream can never crash a refresh.
 */
export function filterProviderModels(
  provider: string,
  models: unknown,
  now: Date,
): FilteredCatalogEntry[] {
  if (!isRecord(models)) return [];
  const cutoff = sixMonthsCutoffISO(now);
  const entries: FilteredCatalogEntry[] = [];
  for (const [modelId, raw] of Object.entries(models)) {
    if (!isRecord(raw)) continue;
    if (modelId.startsWith("~")) continue;
    const name = readString(raw.name);
    if (name === undefined) continue;
    const releaseDate = readString(raw.release_date);
    if (releaseDate === undefined || !ISO_DATE.test(releaseDate)) continue;
    if (releaseDate < cutoff) continue;
    if (!acceptsImageInput(raw)) continue;
    if (isEmbeddingModel(modelId, raw)) continue;
    if (readString(raw.status) === "deprecated") continue;

    const limit = raw.limit;
    const rawContext = isRecord(limit) ? limit.context : undefined;
    const contextLimit =
      typeof rawContext === "number" &&
      Number.isInteger(rawContext) &&
      rawContext > 0
        ? rawContext
        : null;

    entries.push({
      provider,
      modelId,
      name,
      releaseDate,
      vision: true,
      contextLimit,
      reasoningOptions: parseReasoningOptions(raw.reasoning_options),
      deprecated: false,
    });
  }
  entries.sort((left, right) =>
    left.releaseDate === right.releaseDate
      ? left.modelId.localeCompare(right.modelId)
      : right.releaseDate.localeCompare(left.releaseDate),
  );
  return entries;
}
