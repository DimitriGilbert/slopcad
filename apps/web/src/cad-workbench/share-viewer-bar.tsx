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
 * links). Every variant rides the same fragment grammar, so any link
 * decodes on any page.
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
import { useCadStore } from "@slopcad/cad-react";
import { Button } from "@slopcad/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@slopcad/ui/components/dropdown-menu";
import { ChevronDown, Link2, Loader2 } from "lucide-react";
import type { WorkbenchEngine } from "./workbench-engine";

import {
  serializeSessionToNativeText,
  type NativeShareVariant,
} from "../cad-projects/native-document-bridge";
import {
  buildSharePath,
  encodeNativeForShare,
  SHARE_VARIANTS,
  SHARE_VARIANT_ORDER,
} from "../viewer/share-codec";

/** One share action's honest feedback line. */
interface ShareState {
  readonly kind: "busy" | "copied" | "error";
  readonly message: string;
}

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
  const [state, setState] = useState<ShareState | null>(null);

  const share = useCallback(
    (variant: NativeShareVariant): void => {
      setState({ kind: "busy", message: "encoding…" });
      const encoded = encodeNativeForShare(
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
      )
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
    [engine, store],
  );

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
          disabled={state?.kind === "busy"}
          onClick={() => share("lean")}
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
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="Choose viewer link format"
                className="rounded-l-none px-1"
                data-testid="workbench-share-variant"
                disabled={state?.kind === "busy"}
                size="xs"
                variant="outline"
              />
            }
          >
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-64">
            {SHARE_VARIANT_ORDER.map((variant) => (
              <DropdownMenuItem
                data-testid={`workbench-share-variant-${variant}`}
                key={variant}
                onClick={() => share(variant)}
              >
                <div className="flex flex-col">
                  <span>{SHARE_VARIANTS[variant].label}</span>
                  <span className="text-muted-foreground text-[11px]">
                    {SHARE_VARIANTS[variant].hint}
                  </span>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
