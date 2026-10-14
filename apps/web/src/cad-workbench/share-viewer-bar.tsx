/**
 * The workbench's share control (Phase — shareable parametric pages):
 * "Share as viewer link" serializes the LIVE session through the native
 * bridge, encodes it with the viewer's share codec, and copies the
 * /viewer link with the whole part inside the fragment. The same codec
 * the viewer page itself uses, so a link copied here IS a link the
 * viewer (and any embedding host) opens.
 *
 * The control is a split button: the main action copies the default lean
 * link (compact JSON, collapsed history — the smallest fragment), and
 * the arrow opens the picker for the other emission variants (compact
 * with history, and the legacy file form byte-identical to pre-variant
 * links) plus the server link — the document uploaded behind a short
 * public id (`/viewer?p=<id>`), for media that truncate long URLs.
 * Every fragment variant rides the same grammar, so any link decodes on
 * any page; the server link needs the shares API (and the signed-in
 * session the workbench already guarantees).
 *
 * The control rides the composition's `statusBar` slot — laid into the
 * status row's free right end beside the default strip, NEVER as a
 * layout row of its own: the bare /workbench-complete route's canvas
 * geometry is pinned by the tutorial driver's workplane-mapped clicks,
 * and one consumed row of chrome shifts every mapped point. Reads only
 * the slot context's public engine surfaces.
 */

import { useCallback, useState } from "react";
import type { ReactElement } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCadStore } from "@slopcad/cad-react";
import { Button } from "@slopcad/ui/components/button";
import { DropdownMenuItem } from "@slopcad/ui/components/dropdown-menu";
import { Link2, Loader2, Upload } from "lucide-react";
import type { WorkbenchEngine } from "./workbench-engine";

import {
  serializeSessionToNativeText,
  type NativeShareVariant,
} from "../cad-projects/native-document-bridge";
import { ShareVariantMenu } from "../viewer/share-variant-menu";
import {
  buildSharePath,
  encodeNativeForShare,
  SHARE_VARIANTS,
} from "../viewer/share-codec";

import { useTRPC } from "@/utils/trpc";

/** One share action's honest feedback line. */
interface ShareState {
  readonly kind: "busy" | "copied" | "error";
  readonly message: string;
}

/** The server share's menu label and copied feedback note. */
const SERVER_LINK = {
  label: "Server link — short id",
  hint: "uploads the part; the smallest URL",
  note: "server link, short id",
} as const;

/** The section: feedback line, then the split affordance — status-row height. */
export function WorkbenchShareBar({
  engine,
}: {
  readonly engine: Pick<
    WorkbenchEngine,
    "regenerationStates" | "rollback" | "suppressed"
  >;
}): ReactElement {
  const store = useCadStore("WorkbenchShareBar");
  const trpc = useTRPC();
  const [state, setState] = useState<ShareState | null>(null);

  // The server link's upload: one mutation, its feedback folded into the
  // bar's single state line (busy → copied/error) exactly like the
  // fragment links.
  const uploadShare = useMutation(
    trpc.shares.create.mutationOptions({
      onError: (error) => {
        setState({ kind: "error", message: `share failed: ${error.message}` });
      },
    }),
  );

  /** The live session's native text in the given emission variant. */
  const nativeText = useCallback(
    (variant: NativeShareVariant): string =>
      serializeSessionToNativeText(
        store.getSession(),
        engine.regenerationStates ?? new Map(),
        engine.rollback,
        // The share carries what the live session holds: the bare
        // workbench boots from its authored document and never loads a
        // file, so it persists neither metadata nor a drawing.
        {},
        null,
        // The live suppressed set: a shared part keeps the suppressed
        // timeline its sharer sees.
        engine.suppressed,
        variant,
      ),
    [engine, store],
  );

  const shareFragment = useCallback(
    (variant: NativeShareVariant): void => {
      setState({ kind: "busy", message: "encoding…" });
      const encoded = encodeNativeForShare(nativeText(variant))
        .then((payload) => {
          const url = `${window.location.origin}${buildSharePath(payload)}`;
          return navigator.clipboard.writeText(url).then(() => url);
        })
        .then(
          (url) => ({ ok: true as const, url }),
          (error: unknown) => ({
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      void encoded.then((outcome) => {
        setState(
          outcome.ok
            ? {
                kind: "copied",
                message: `viewer link copied — ${SHARE_VARIANTS[variant].note} · ${String(outcome.url.length)} chars`,
              }
            : { kind: "error", message: `share failed: ${outcome.message}` },
        );
      });
    },
    [nativeText],
  );

  const shareServerLink = useCallback((): void => {
    setState({ kind: "busy", message: "uploading the part…" });
    uploadShare.mutate(
      // The uploaded copy is the lean emission: the viewer replays the
      // part, not the authoring timeline, and the row stays smallest.
      { nativeContent: nativeText("lean") },
      {
        onSuccess: ({ id }) => {
          const url = `${window.location.origin}/viewer?p=${id}`;
          void navigator.clipboard.writeText(url).then(
            () => {
              setState({
                kind: "copied",
                message: `viewer link copied — ${SERVER_LINK.note} · ${String(url.length)} chars`,
              });
            },
            (error: unknown) => {
              setState({
                kind: "error",
                message: `share failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            },
          );
        },
      },
    );
  }, [nativeText, uploadShare]);

  const busy = state?.kind === "busy" || uploadShare.isPending;

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-2 pr-3 pl-2"
      data-testid="workbench-share-bar"
    >
      <span
        aria-live="polite"
        className="text-muted-foreground font-mono text-xs"
        data-testid="workbench-share-state"
      >
        {state?.message ?? null}
      </span>
      <div className="flex items-center">
        <Button
          className="rounded-r-none border-r-0"
          data-testid="workbench-share-viewer"
          disabled={busy}
          onClick={() => shareFragment("lean")}
          size="xs"
          variant="outline"
        >
          {state?.kind === "busy" ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : (
            <Link2 data-icon="inline-start" />
          )}
          Share as viewer link
        </Button>
        <ShareVariantMenu
          ariaLabel="Choose viewer link format"
          disabled={busy}
          onPick={shareFragment}
          testidPrefix="workbench-share"
        >
          <DropdownMenuItem
            data-testid="workbench-share-server"
            onClick={shareServerLink}
          >
            <div className="flex flex-col">
              <span className="flex items-center gap-1">
                <Upload className="size-3" />
                {SERVER_LINK.label}
              </span>
              <span className="text-muted-foreground text-[11px]">
                {SERVER_LINK.hint}
              </span>
            </div>
          </DropdownMenuItem>
        </ShareVariantMenu>
      </div>
    </div>
  );
}
