/**
 * The workbench's share control (Phase — shareable parametric pages):
 * "Share as viewer link" serializes the LIVE session through the native
 * bridge, encodes it with the viewer's share codec, and copies the
 * /viewer link with the whole part inside the fragment. The same codec
 * the viewer page itself uses, so a link copied here IS a link the
 * viewer (and any embedding host) opens.
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
import { Link2, Loader2 } from "lucide-react";
import type { WorkbenchEngine } from "./workbench-engine";

import { serializeSessionToNativeText } from "../cad-projects/native-document-bridge";
import { buildSharePath, encodeNativeForShare } from "../viewer/share-codec";

/** One share action's honest feedback line. */
interface ShareState {
  readonly kind: "busy" | "copied" | "error";
  readonly message: string;
}

/** The section: feedback line, then the one affordance — status-row height. */
export function WorkbenchShareBar({
  engine,
}: {
  readonly engine: WorkbenchEngine;
}): ReactElement {
  const store = useCadStore("WorkbenchShareBar");
  const [state, setState] = useState<ShareState | null>(null);

  const share = useCallback((): void => {
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
      ),
    )
      .then((payload) =>
        navigator.clipboard.writeText(
          `${window.location.origin}${buildSharePath(payload)}`,
        ),
      )
      .then(
        () => "copied" as const,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    void encoded.then((outcome) => {
      setState(
        outcome === "copied"
          ? {
              kind: "copied",
              message: "viewer link copied — the part rides in the URL",
            }
          : { kind: "error", message: `share failed: ${outcome}` },
      );
    });
  }, [engine, store]);

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
      <Button
        data-testid="workbench-share-viewer"
        disabled={state?.kind === "busy"}
        onClick={share}
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
    </div>
  );
}
