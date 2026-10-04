/**
 * The part renderers' decoding layer (PLAN-AGENT-CHAT Phase 4.3): pure,
 * node-testable functions that turn UNTRUSTED part payloads — streamed tool
 * inputs, wire-format tool results — into display models. The renderers stay
 * dumb; every narrowing lives here and follows the repo's untrusted-JSON
 * convention (structural guards, `unknown` in, typed models out, no `any`,
 * never throw on display paths).
 *
 * Three decode families, one per special-cased tool surface (D4/D9/D10):
 *
 * - `cad_apply_commands` — the input `commands` array is re-parsed with the
 *   domain's own {@link parseCommand} (the same strict parser the registry
 *   tool runs), so what renders as a "readable command diff" is exactly what
 *   the tool would (or did) validate; entries the parser refuses render with
 *   their structured reason. Display only (D4) — nothing here executes.
 * - `cad_capture_views` — the input `views` array becomes angle labels
 *   (preset names or azimuth/elevation pairs); the RESULT content (the Phase
 *   2.3 bridge's multimodal parts) becomes an image gallery, with captions
 *   recovered from the bridge's own summary text ("Captured N views: …" —
 *   the only place the per-view names survive) and positional fallbacks.
 * - error-state tool results — decoded through {@link parseAgentToolRefusal}
 *   (D9) by the renderer itself; the chip model is the refusal verbatim.
 */

import type { ContentPart, ContentPartSource } from "@tanstack/ai";
import {
  parseCommand,
  printExpression,
  serializeDimensionalValueResult,
  type AnyDimensionalValue,
  type CadCommand,
} from "@slopcad/cad-core";

import { safeHttpUrl } from "../safe-http-url";

/** The `cad_apply_commands` tool's registry name. */
export const APPLY_COMMANDS_TOOL = "cad_apply_commands";

/** The `cad_capture_views` tool's registry name. */
export const CAPTURE_VIEWS_TOOL = "cad_capture_views";

/** One entry of the decoded command list: parsed, or refused with a reason. */
export type DecodedCommand =
  | { readonly ok: true; readonly command: CadCommand }
  | { readonly ok: false; readonly message: string };

/** The decoded `cad_apply_commands` input (null when the shape is wrong). */
export interface DecodedApplyCommandsInput {
  readonly commands: readonly DecodedCommand[];
}

/**
 * Reads an unknown value as a plain record (the repo's untrusted-JSON guard).
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Formats a dimensional value for display as `<magnitude> <unit>` (never throws). */
function formatDimensional(value: AnyDimensionalValue): string {
  const serialized = serializeDimensionalValueResult(value);
  if (!serialized.ok) return "(unreadable value)";
  return `${String(serialized.value.value)} ${String(serialized.value.unit)}`;
}

/**
 * The readable one-line summary of one parsed CAD command — the "diff" row of
 * the `cad_apply_commands` view. The switch is exhaustive over the command
 * vocabulary: a new {@link CadCommand} type fails the build here (the
 * renderer must learn to display it, not silently drop it).
 */
export function formatCadCommand(command: CadCommand): string {
  switch (command.type) {
    case "parameter.set": {
      if (command.expression !== undefined && command.expression !== null) {
        return `Set ${String(command.id)} = ${printExpression(command.expression)}`;
      }
      return `Set ${String(command.id)} = ${formatDimensional(command.value)}`;
    }
    case "parameter.create": {
      const defined =
        command.expression === undefined
          ? ""
          : ` = ${printExpression(command.expression)}`;
      return `Create $${command.name} = ${formatDimensional(command.value)}${defined}`;
    }
    case "parameter.rename":
      return `Rename ${String(command.id)} to $${command.name}`;
    case "parameter.delete":
      return `Delete parameter ${String(command.id)}`;
    case "body.create":
      return `Create body "${command.name}"${command.kind === "sheet" ? " (sheet)" : ""}`;
    case "body.update": {
      const changes: string[] = [];
      if (command.name !== undefined) changes.push(`name "${command.name}"`);
      if (command.visible !== undefined)
        changes.push(command.visible ? "show" : "hide");
      if (command.isolated !== undefined)
        changes.push(command.isolated ? "isolate" : "un-isolate");
      if (command.appearance !== undefined)
        changes.push(
          command.appearance === null ? "clear appearance" : "set appearance",
        );
      if (command.faceAppearances !== undefined)
        changes.push(
          command.faceAppearances === null
            ? "clear face overrides"
            : `set ${String(command.faceAppearances.length)} face override(s)`,
        );
      return `Update body ${String(command.id)}${changes.length === 0 ? "" : `: ${changes.join(", ")}`}`;
    }
    case "sketch.create":
      return `Create sketch "${command.name}"`;
    case "reference.create":
      return `Create reference "${command.name}"`;
    case "datum.create":
      return `Create datum "${command.name}"`;
    case "curve.create":
      return `Create curve "${command.name}"`;
    case "feature.create":
      return `Create ${command.kind} feature${command.id === undefined ? "" : ` ${String(command.id)}`} (${String(command.inputs.length)} input${command.inputs.length === 1 ? "" : "s"})`;
    case "feature.update":
      return `Update ${command.kind} feature ${String(command.id)}`;
    case "feature.delete":
      return `Delete feature ${String(command.id)}`;
    case "feature.reorder":
      return `Move feature ${String(command.id)} after ${
        command.afterFeatureId === null
          ? "the timeline start"
          : String(command.afterFeatureId)
      }`;
    case "configuration.create":
      return `Create configuration "${command.name}" (${countConfigurationDeltas(command)})`;
    case "configuration.update":
      return `Update configuration ${String(command.id)} (${countConfigurationDeltas(command)})`;
    case "configuration.delete":
      return `Delete configuration ${String(command.id)}`;
    default: {
      // Exhaustiveness: a future command type must extend the summaries.
      const exhaustive: never = command;
      void exhaustive;
      return "(unknown command)";
    }
  }
}

/** Counts one configuration command's authored deltas for its summary line. */
function countConfigurationDeltas(
  command:
    | Extract<CadCommand, { type: "configuration.create" }>
    | Extract<CadCommand, { type: "configuration.update" }>,
): string {
  const overrides = command.parameterOverrides?.length ?? 0;
  const suppressed = command.suppressedFeatures?.length ?? 0;
  const hidden = command.hiddenBodies?.length ?? 0;
  const parts = [
    `${String(overrides)} override${overrides === 1 ? "" : "s"}`,
    `${String(suppressed)} suppressed`,
    `${String(hidden)} hidden`,
  ];
  return parts.join(", ");
}

/**
 * Decodes a `cad_apply_commands` input: every entry runs through the domain's
 * strict {@link parseCommand} — the same parser the tool itself applies — so
 * the rendered list is exactly the command set the tool saw. `null` when the
 * input is not the `{ commands: […] }` shape (the renderer then falls back to
 * raw JSON, never a fabricated list).
 */
export function decodeApplyCommandsInput(
  input: unknown,
): DecodedApplyCommandsInput | null {
  const record = asRecord(input);
  if (record === null || !Array.isArray(record.commands)) return null;
  const commands: DecodedCommand[] = [];
  for (const raw of record.commands) {
    const parsed = parseCommand(raw);
    commands.push(
      parsed.ok
        ? { command: parsed.value, ok: true }
        : { message: parsed.error.message, ok: false },
    );
  }
  return { commands };
}

/** One decoded capture-view request label (preset name or angle pair). */
export interface DecodedCaptureView {
  readonly label: string;
}

/** Reads one `views[]` entry's angle label, or `null` when it is malformed. */
function captureViewLabel(view: unknown): string | null {
  const record = asRecord(view);
  if (record === null) return null;
  if (typeof record.preset === "string") return record.preset;
  if (
    typeof record.azimuth === "number" &&
    typeof record.elevation === "number"
  ) {
    return `az ${String(record.azimuth)}\u00b0 / el ${String(record.elevation)}\u00b0`;
  }
  return null;
}

/**
 * Decodes a `cad_capture_views` input into per-view angle labels (D10):
 * presets render by name, arbitrary angles as an azimuth/elevation pair.
 * `null` when the input is not the `{ views: […] }` shape.
 */
export function decodeCaptureViewsInput(
  input: unknown,
): readonly DecodedCaptureView[] | null {
  const record = asRecord(input);
  if (record === null || !Array.isArray(record.views)) return null;
  const views: DecodedCaptureView[] = [];
  for (const view of record.views) {
    const label = captureViewLabel(view);
    if (label === null) return null;
    views.push({ label });
  }
  return views;
}

/** One gallery image: a renderable `src` (or why there is none) plus caption. */
export interface CapturedGalleryImage {
  /** The element source (`data:` URI or checked http(s) URL); null when unrenderable. */
  readonly src: string | null;
  /** The angle caption (bridge view name when recoverable, positional otherwise). */
  readonly caption: string;
}

/** The decoded capture result content: summary text plus the image gallery. */
export interface DecodedCaptureGallery {
  /** The bridge's summary line ("Captured 2 views: front, iso."), when present. */
  readonly summary: string | null;
  readonly images: readonly CapturedGalleryImage[];
}

/**
 * Renders a media source to an element-safe URL: inline base64 becomes a
 * `data:` URI, URL sources survive only as http(s) through the ported
 * template's {@link safeHttpUrl} guard (`javascript:`-style injection is
 * refused with `null`), provider file handles render nothing (opaque by
 * contract).
 */
export function mediaSourceSrc(source: ContentPartSource): string | null {
  switch (source.type) {
    case "data": {
      if (source.mimeType.length === 0 || source.value.length === 0) {
        return null;
      }
      return `data:${source.mimeType};base64,${source.value}`;
    }
    case "url":
      return safeHttpUrl(source.value) ?? null;
    case "file":
      return null;
    default: {
      // Exhaustiveness over the source union (AG-UI PartSource).
      const exhaustive: never = source;
      void exhaustive;
      return null;
    }
  }
}

/**
 * Reads the per-view names out of the Phase 2.3 bridge's capture summary
 * ("Captured 2 views: front, iso.") — the only place the labels survive the
 * wrap into image content parts. `null` for any other text.
 */
function captureViewNames(summary: string): readonly string[] | null {
  const match = /^Captured (\d+) views?: (.*)\.$/u.exec(summary);
  if (match === null) return null;
  const countText = match[1];
  const listText = match[2];
  if (countText === undefined || listText === undefined) return null;
  const count = Number(countText);
  const names = listText.split(", ");
  return names.length === count && count > 0 ? names : null;
}

/**
 * Decodes a `cad_capture_views` RESULT part's content (the bridge's multimodal
 * content parts: a summary text part plus one image part per view) into the
 * gallery model — captions from the summary when it matches the bridge
 * contract, positional fallbacks otherwise. A plain string content (any other
 * producer) becomes the summary with no images.
 */
export function decodeCaptureGallery(
  content: string | readonly ContentPart[],
): DecodedCaptureGallery {
  if (typeof content === "string") {
    const summary = content.trim();
    return { images: [], summary: summary.length === 0 ? null : summary };
  }
  let summary: string | null = null;
  const sources: ContentPartSource[] = [];
  for (const part of content) {
    if (part.type === "text") {
      const text = part.content.trim();
      if (text.length === 0) continue;
      summary = summary === null ? text : `${summary}\n${text}`;
    } else if (part.type === "image") {
      sources.push(part.source);
    }
  }
  const names =
    summary === null ? null : captureViewNames(summary.split("\n")[0] ?? "");
  const images: CapturedGalleryImage[] = sources.map((source, index) => {
    const name = names === null ? undefined : names[index];
    return {
      caption:
        name === undefined
          ? `View ${String(index + 1)} of ${String(sources.length)}`
          : name,
      src: mediaSourceSrc(source),
    };
  });
  return { images, summary };
}

/** Pretty, deterministic JSON for collapsed raw views of untyped payloads. */
export function stableJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? "undefined" : text;
}

/**
 * Best-effort JSON parse for display fallbacks (a call whose `input` never
 * materialized can still carry its raw `arguments` string): the parsed value,
 * or `undefined` when the text is not valid JSON — including the PARTIAL JSON
 * of a still-streaming arguments string.
 */
export function parseLooseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
