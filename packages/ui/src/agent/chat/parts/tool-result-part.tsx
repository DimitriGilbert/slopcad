/**
 * The tool-result part renderer (PLAN-AGENT-CHAT Phase 4.3): the ANSWER side
 * of a tool invocation — what the workbench reported back, keyed to the
 * request the tool-call part rendered.
 *
 * - `cad_capture_views` complete results render as the image gallery (D10):
 *   the bridge's summary line plus one image per captured angle, captions
 *   recovered from the bridge's own text (positional fallbacks otherwise).
 * - error-state results render the D9 diagnostics surface: the error text is
 *   decoded with {@link parseAgentToolRefusal} (the lossless JSON the Phase
 *   2.3 bridge encodes into every thrown refusal) and shown as a
 *   severity-colored diagnostics chip — code, message, and location — in the
 *   same visual language as the timeline and viewport chips. Non-refusal
 *   error text (any other producer) renders as a plain destructive line;
 *   cancelled/denied outcomes render quiet, not loud. A COMPLETE result
 *   whose string content parses as a refusal renders the same chip: the
 *   framework's interrupt-resolution arm hands a thrown refusal's text over
 *   as result CONTENT instead of an error state.
 * - everything else renders the generic answer: collapsed JSON for string
 *   content, text + media for multimodal content.
 *
 * The state switch is exhaustive over `ToolResultState` (never-checked).
 */

import type { ReactElement } from "react";
import { CircleAlertIcon } from "lucide-react";
import type { ContentPart } from "@tanstack/ai";
import type { AgentChatToolResultPart } from "./part-types";

import {
  CAPTURE_VIEWS_TOOL,
  decodeCaptureGallery,
  stableJson,
} from "./decoders";
import { AgentDiagnosticsChip } from "./diagnostics-chip";
import {
  AgentAudioPart,
  AgentDocumentPart,
  AgentImagePart,
  AgentVideoPart,
} from "./media-parts";
import { PartStatusLine } from "./busy";
import { parseAgentToolRefusal } from "../../tools";

/** Everything the tool-result renderer takes. */
export interface AgentToolResultPartProps {
  readonly part: AgentChatToolResultPart;
  /**
   * The called tool's name, resolved from the sibling tool-call part by the
   * dispatcher: the framework's wire shape carries a tool-result's identity
   * as `toolCallId` only — `part.name` is unset on the live path, so the
   * per-tool renderers (the capture gallery) key on THIS.
   */
  readonly toolName?: string;
}

/** The `cad_capture_views` gallery: summary line + captioned images (D10). */
function CaptureGallery({
  content,
}: {
  content: string | readonly ContentPart[];
}): ReactElement {
  const gallery = decodeCaptureGallery(content);
  return (
    <div
      className="flex w-full max-w-full flex-col gap-1.5"
      data-testid="agent-capture-gallery"
    >
      {gallery.summary === null ? null : (
        <p className="px-1.5 text-xs text-muted-foreground">
          {gallery.summary}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {gallery.images.map((image, index) =>
          image.src === null ? (
            <span
              key={index}
              className="rounded-sm border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground"
            >
              {`${image.caption} (unrenderable source)`}
            </span>
          ) : (
            <figure
              key={index}
              className="flex w-40 flex-col gap-1"
              data-testid="agent-captured-view"
            >
              <img
                src={image.src}
                alt={image.caption}
                className="h-auto w-full rounded-sm border border-border object-contain"
              />
              <figcaption className="font-mono text-[10px] text-muted-foreground">
                {image.caption}
              </figcaption>
            </figure>
          ),
        )}
      </div>
    </div>
  );
}

/** Renders one multimodal content array: text as paragraphs, media inline. */
function ContentPartsBody({
  content,
}: {
  content: readonly ContentPart[];
}): ReactElement {
  return (
    <div className="flex w-full max-w-full flex-col gap-1.5">
      {content.map((entry, index) => {
        switch (entry.type) {
          case "text":
            return (
              <p
                key={index}
                className="wrap-break-word px-1.5 text-xs leading-relaxed"
              >
                {entry.content}
              </p>
            );
          case "image":
            return <AgentImagePart key={index} part={entry} />;
          case "audio":
            return <AgentAudioPart key={index} part={entry} />;
          case "video":
            return <AgentVideoPart key={index} part={entry} />;
          case "document":
            return <AgentDocumentPart key={index} part={entry} />;
          default: {
            // Exhaustiveness over the content-part union.
            const exhaustive: never = entry;
            void exhaustive;
            return null;
          }
        }
      })}
    </div>
  );
}

/** The generic complete body: collapsed JSON / text + media. */
function GenericResultBody({
  content,
}: {
  content: string | readonly ContentPart[];
}): ReactElement {
  if (typeof content === "string") {
    return (
      <details className="px-1.5 text-xs">
        <summary className="cursor-pointer text-muted-foreground outline-none select-none focus-visible:ring-1 focus-visible:ring-ring/50">
          Result
        </summary>
        <pre className="overflow-x-auto pt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {stableJson(jsonOrVerbatim(content))}
        </pre>
      </details>
    );
  }
  return <ContentPartsBody content={content} />;
}

/** Parses string content as JSON when it parses, else shows it verbatim. */
function jsonOrVerbatim(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

/** The error-state arm's decoded presentation. */
function ToolErrorBody({
  error,
  outcome,
}: {
  error: string | undefined;
  outcome: AgentChatToolResultPart["outcome"];
}): ReactElement {
  if (outcome === "cancelled" || outcome === "denied") {
    return (
      <p className="px-1.5 text-xs text-muted-foreground italic">
        {outcome === "cancelled"
          ? "Cancelled before it finished."
          : "Denied before it ran."}
      </p>
    );
  }
  const refusal = error === undefined ? null : parseAgentToolRefusal(error);
  if (refusal !== null) {
    return (
      <AgentDiagnosticsChip
        severity="error"
        code={refusal.code}
        message={refusal.message}
        location={refusal.location}
      />
    );
  }
  return (
    <div
      className="flex items-start gap-1.5 rounded-sm border border-destructive/40 bg-background/95 px-2 py-1 text-xs leading-4 text-destructive"
      role="alert"
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span className="wrap-break-word min-w-0">
        {error === undefined || error.length === 0
          ? "The tool call failed."
          : error}
      </span>
    </div>
  );
}

/** Renders one tool-result part against its state machine. */
export function AgentToolResultPart({
  part,
  toolName,
}: AgentToolResultPartProps): ReactElement {
  const name = toolName ?? part.name ?? "tool";
  switch (part.state) {
    case "streaming":
      return <PartStatusLine>{`Running ${name}\u2026`}</PartStatusLine>;
    case "error":
      return <ToolErrorBody error={part.error} outcome={part.outcome} />;
    case "complete":
      if (name === CAPTURE_VIEWS_TOOL) {
        return <CaptureGallery content={part.content} />;
      }
      // A COMPLETE result whose string content IS a refusal: the framework
      // has two client-tool arms — the direct one maps a thrown error into
      // an error-state part, while the interrupt-resolution one (the run
      // the browser actually takes) hands the thrown text over as the
      // result's CONTENT. Both carry the D9 diagnostic, so both render the
      // chip — {@link parseAgentToolRefusal} is the refusal detector, and a
      // success payload never carries its `{ code, message }` shape.
      if (typeof part.content === "string") {
        const refusal = parseAgentToolRefusal(part.content);
        if (refusal !== null) {
          return (
            <AgentDiagnosticsChip
              code={refusal.code}
              location={refusal.location}
              message={refusal.message}
              severity="error"
            />
          );
        }
      }
      return <GenericResultBody content={part.content} />;
    default: {
      // Exhaustiveness: a future ToolResultState must be handled here.
      const exhaustive: never = part.state;
      void exhaustive;
      return <PartStatusLine>{`Running ${name}\u2026`}</PartStatusLine>;
    }
  }
}
