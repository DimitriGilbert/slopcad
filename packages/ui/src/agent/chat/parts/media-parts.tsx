/**
 * The media part renderers (PLAN-AGENT-CHAT Phase 4.3): the multimodal arms
 * of the part union — image, audio, video, document. Assistant-side media in
 * this surface arrives almost exclusively as captured-view PNGs inside
 * `cad_capture_views` tool results (the tool-result renderer reuses these
 * components for its content parts), but the union carries the arms on
 * messages too, so they render wherever they appear.
 *
 * Every source goes through {@link mediaSourceSrc}: inline base64 becomes a
 * `data:` URI, URLs survive only as http(s) (the template `safeHttpUrl`
 * javascript: guard, kept local so the renderers stay self-contained), and
 * provider file handles render an honest placeholder instead of an element
 * that could never resolve.
 */

import type { ReactElement } from "react";
import type {
  AudioPart,
  DocumentPart,
  ImagePart,
  VideoPart,
} from "@tanstack/ai";

import { mediaSourceSrc } from "./decoders";

/** The shared placeholder for media whose source cannot render. */
function UnrenderableMedia({ kind }: { kind: string }): ReactElement {
  return (
    <span className="rounded-sm border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
      {kind} held by the provider (no inline bytes to show)
    </span>
  );
}

/** Renders one image part (`<img>` for renderable sources, placeholder otherwise). */
export function AgentImagePart({ part }: { part: ImagePart }): ReactElement {
  const src = mediaSourceSrc(part.source);
  if (src === null) return <UnrenderableMedia kind="Image" />;
  return (
    <img
      src={src}
      alt=""
      className="h-auto max-h-64 w-auto max-w-full rounded-sm border border-border object-contain"
      data-testid="agent-image-part"
    />
  );
}

/** Renders one audio part as a native controls element. */
export function AgentAudioPart({ part }: { part: AudioPart }): ReactElement {
  const src = mediaSourceSrc(part.source);
  if (src === null) return <UnrenderableMedia kind="Audio" />;
  return <audio controls src={src} className="max-w-full" />;
}

/** Renders one video part as a native controls element. */
export function AgentVideoPart({ part }: { part: VideoPart }): ReactElement {
  const src = mediaSourceSrc(part.source);
  if (src === null) return <UnrenderableMedia kind="Video" />;
  return (
    <video
      controls
      src={src}
      className="h-auto max-h-64 w-auto max-w-full rounded-sm border border-border"
    />
  );
}

/** Renders one document part as a guarded link (or the placeholder). */
export function AgentDocumentPart({
  part,
}: {
  part: DocumentPart;
}): ReactElement {
  const src = mediaSourceSrc(part.source);
  if (src === null) return <UnrenderableMedia kind="Document" />;
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="text-xs underline underline-offset-2 hover:text-foreground"
    >
      {part.source.mimeType ?? "document"}
    </a>
  );
}
