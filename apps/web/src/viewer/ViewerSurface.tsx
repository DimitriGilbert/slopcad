/**
 * The viewer surface (Phase — shareable parametric pages): THE shared-part
 * viewer, written once and mounted twice — the public /viewer route mounts
 * it over the site chrome (the document arrives in the URL fragment or via
 * the local load affordances), and the standalone HTML export's entry
 * mounts the very same component with the document injected as a JS
 * variable. One source of truth for the render+re-drive behavior; the two
 * mounts differ only in where the document comes from and which share
 * affordances make sense.
 *
 * Layout (720p+): the part fills the left, the variables dock holds the
 * right — the CadViewport over the viewer engine's session (render + free
 * orbit), and the parameter panel's Formedible form (literal variables as
 * number fields, expression variables as expression fields with the live
 * `= quantity` preview). Edits commit through the SAME store command path
 * the workbench panel uses (`parameter.set`), so the part re-drives live —
 * the entire point. Below the `lg` breakpoint the split stacks (part on
 * top, variables under it) so an embed at any width scrolls, never
 * overflows horizontally.
 *
 * The share link re-encodes the LIVE document (edits included) into the
 * fragment — a copied link shares the part as it stands, not as it was
 * shared. The standalone export fetches the site's compiled viewer assets,
 * embeds the live native document as a JS variable, and downloads one
 * self-contained file that runs offline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CadProvider } from "@slopcad/cad-react";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import { Button } from "@slopcad/ui/components/button";
import { Panel, PanelHeader } from "@slopcad/ui/components/cockpit/panel";
import { Download, Link2, Loader2 } from "lucide-react";
import type { NativeShareVariant } from "../cad-projects/native-document-bridge";
import type { ViewerDocumentSummary } from "./viewer-document";

import { ShareVariantMenu } from "./share-variant-menu";
import {
  buildSharePath,
  decodeNativeFromShare,
  encodeNativeForShare,
  SHARE_FORMAT_NOTE,
  SHARE_VARIANTS,
} from "./share-codec";
import {
  assembleStandaloneHtml,
  type StandaloneAssemblyInput,
} from "./standalone-html";
import { STANDALONE_ASSETS } from "./standalone-assets";
import { useViewerEngine, useViewerStore } from "./viewer-engine";

/**
 * The id-based server share's resolved state, as the ROUTE (which sits
 * under the app's tRPC and query providers) hands it down. The surface
 * itself stays provider-free: the standalone export mounts it in a
 * `file://`-opened single HTML with no providers at all.
 */
export type ServerShareState =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "text"; readonly text: string };

/** Props of {@link ViewerSurface}. */
export interface ViewerSurfaceProps {
  /**
   * `"page"` — the site route: share + export affordances are live.
   * `"standalone"` — the exported single file: it IS the share, so those
   * affordances yield their place to the offline note.
   */
  readonly variant: "page" | "standalone";
  /**
   * The embed flag (the route's `?embed=1`): a cross-origin iframe host
   * usually refuses the clipboard API and blob-URL downloads, so an
   * embedded page mount hides the share affordances instead of offering
   * buttons that cannot succeed. `false` by default.
   */
  readonly embed?: boolean;
  /**
   * The injected native document text (the standalone mount's
   * `window.__SLOPCAD_NATIVE__`). Present, it is adopted on mount and the
   * URL fragment is ignored.
   */
  readonly injectedNativeText?: string | null;
  /** The injected document title (the standalone mount's). */
  readonly injectedTitle?: string | null;
  /**
   * The id-based server share's resolved state (the route fetched
   * `?p=<id>` through the shares API before mounting). `"none"` by
   * default — the standalone mount fetches nothing. Adopted on mount
   * when the URL carries no fragment; the self-contained fragment link
   * wins when both are present.
   */
  readonly serverShare?: ServerShareState;
  /**
   * The worker override (the standalone mount's inlined blob worker — a
   * stable, module-level factory: the engine boots exactly once). The
   * page mount omits it and boots the default fixture worker.
   */
  readonly workerFactory?: () => Worker;
}

/** The viewer's machine-surface ids (the settle protocol's anchors). */
export const VIEWER_ROOT_ID = "viewer-root";
export const VIEWER_VIEWPORT_ID = "viewer-viewport";

/** A safe download name from a document title. */
function downloadNameOf(title: string, extension: string): string {
  const cleaned = title
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned === "" ? "part" : cleaned}${extension}`;
}

/**
 * The identity-stable `"none"` state (the standalone mount's default and
 * the route's no-`?p=` arm): a module constant, so the adoption effect's
 * dependency never churns on re-renders that change nothing.
 */
const NO_SERVER_SHARE_VALUE: ServerShareState = { kind: "none" };
export const NO_SERVER_SHARE: Readonly<ServerShareState> = Object.freeze(
  NO_SERVER_SHARE_VALUE,
);

/**
 * The store composition + provider shell: composed ONCE above the engine
 * body, exactly the workbench pages' structure.
 */
export function ViewerSurface({
  embed = false,
  injectedNativeText = null,
  injectedTitle = null,
  serverShare = NO_SERVER_SHARE,
  variant,
  workerFactory,
}: ViewerSurfaceProps): ReactElement {
  const store = useViewerStore();
  return (
    <CadProvider store={store}>
      <ViewerBody
        embed={embed}
        injectedNativeText={injectedNativeText}
        injectedTitle={injectedTitle}
        serverShare={serverShare}
        variant={variant}
        workerFactory={workerFactory}
      />
    </CadProvider>
  );
}

/** One share/export action's honest feedback line. */
interface ActionState {
  readonly kind: "busy" | "done" | "error";
  readonly message: string;
}

function ViewerBody({
  embed,
  injectedNativeText,
  injectedTitle,
  serverShare,
  variant,
  workerFactory,
}: {
  readonly embed: boolean;
  readonly injectedNativeText: string | null;
  readonly injectedTitle: string | null;
  readonly serverShare: ServerShareState;
  readonly variant: "page" | "standalone";
  readonly workerFactory?: () => Worker;
}): ReactElement {
  const engine = useViewerEngine(
    {
      rootId: VIEWER_ROOT_ID,
      statusId: "viewer-status",
      volumeId: "viewer-volume",
      errorId: "viewer-error",
    },
    { workerFactory },
  );
  const { adopt, applied, currentNativeText, noteRenderedFrame } = engine;

  // The loaded document's chrome facts (title, variable split) and the
  // load failure, surfaced verbatim in the empty state. The injected title
  // (the standalone mount) names the part before/without an adoption.
  const [summary, setSummary] = useState<ViewerDocumentSummary | null>(null);
  const displayTitle = summary?.title ?? injectedTitle ?? "Part viewer";
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const adoptedRef = useRef(false);

  /** Adopts text through the engine, keeping the chrome state honest. */
  const adoptText = useCallback(
    (text: string, source: string): void => {
      const load = adopt(text);
      if (!load.ok) {
        setLoadError(`${source}: ${load.error}`);
        return;
      }
      adoptedRef.current = true;
      setSummary(load.summary);
      setLoadError(null);
      setAction(null);
    },
    [adopt],
  );

  // The document source, resolved once per mount: the injected text wins
  // (the standalone mount), else the URL fragment (the share link), else
  // the id-based server share the route already fetched. A decode or
  // parse failure lands in the empty state's error region — never a
  // blank page.
  useEffect(() => {
    if (adoptedRef.current) return;
    if (injectedNativeText !== null) {
      adoptText(injectedNativeText, "embedded document");
      return;
    }
    const hash = window.location.hash;
    if (hash.length > 1) {
      adoptedRef.current = true;
      void decodeNativeFromShare(hash).then((result) => {
        if (!result.ok) {
          adoptedRef.current = false;
          setLoadError(`share link: ${result.error}`);
          return;
        }
        adoptText(result.text, "share link");
      });
      return;
    }
    if (serverShare.kind === "none" || serverShare.kind === "pending") {
      return;
    }
    if (serverShare.kind === "error") {
      adoptedRef.current = true;
      setLoadError(`server share: ${serverShare.message}`);
      return;
    }
    adoptText(serverShare.text, "server share");
  }, [adoptText, injectedNativeText, serverShare]);

  // -- Share link -----------------------------------------------------------
  const handleCopyShare = useCallback(
    (shareVariant: NativeShareVariant): void => {
      setAction({ kind: "busy", message: "encoding share link…" });
      const payload = encodeNativeForShare(currentNativeText(shareVariant))
        .then((encoded) => {
          const url = `${window.location.origin}${buildSharePath(encoded)}`;
          return navigator.clipboard.writeText(url).then(() => url);
        })
        .then(
          (url) => ({ ok: true as const, url }),
          (error: unknown) => ({
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      void payload.then((outcome) => {
        setAction(
          outcome.ok
            ? {
                kind: "done",
                message: `share link copied — ${SHARE_VARIANTS[shareVariant].note} · ${String(outcome.url.length)} chars`,
              }
            : {
                kind: "error",
                message: `share link failed: ${outcome.message}`,
              },
        );
      });
    },
    [currentNativeText],
  );

  // -- Standalone HTML export ------------------------------------------------
  const handleExport = useCallback((): void => {
    setAction({ kind: "busy", message: "building standalone HTML…" });
    const assembled: Promise<StandaloneAssemblyInput> = Promise.all([
      fetchText(STANDALONE_ASSETS.cssUrl),
      fetchText(STANDALONE_ASSETS.jsUrl),
    ]).then(([css, js]) => ({
      css,
      js,
      nativeText: currentNativeText(),
      title: displayTitle,
    }));
    assembled
      .then((input) => {
        const html = assembleStandaloneHtml(input);
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = downloadNameOf(input.title, ".html");
        anchor.click();
        URL.revokeObjectURL(url);
        setAction({
          kind: "done",
          message: `standalone HTML downloaded (${String(Math.round(blob.size / 1024))} KB — the renderer and kernel travel inside)`,
        });
      })
      .catch((error: unknown) => {
        setAction({
          kind: "error",
          message: `standalone export failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  }, [currentNativeText, displayTitle]);

  const loaded = summary !== null && loadError === null;
  const documentVolumeText =
    applied === null ? null : applied.state.measurement.volume.toFixed(3);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="viewer-surface"
      data-loaded={String(loaded)}
      id={VIEWER_ROOT_ID}
    >
      {/* The instrument bar: identity, the settle lamp, the DRO volume, and
          the two share affordances. One row, chrome-thin. */}
      <div className="flex h-(--appbar-h) shrink-0 items-center gap-(--gap-group) border-b border-rule bg-panel px-(--pad-panel)">
        <span
          className="font-display truncate text-title font-semibold text-ink"
          data-testid="viewer-title"
        >
          {displayTitle}
        </span>
        <span
          className="font-mono text-micro text-ink-faint"
          aria-live="polite"
          data-testid="viewer-status"
          id="viewer-status"
        >
          …
        </span>
        <div className="flex-1" />
        <span className="label-section shrink-0 text-ink-faint">vol</span>
        <span
          className="shrink-0 font-mono text-data text-ink tabular"
          data-testid="viewer-volume"
          id="viewer-volume"
        >
          …
        </span>
        {variant === "page" && !embed ? (
          <>
            <div className="flex items-center">
              <Button
                className="rounded-r-none border-r-0"
                data-testid="viewer-share"
                disabled={!loaded || action?.kind === "busy"}
                onClick={() => handleCopyShare("lean")}
                size="xs"
                variant="outline"
              >
                <Link2 data-icon="inline-start" />
                Copy share link
              </Button>
              <ShareVariantMenu
                ariaLabel="Choose share link format"
                disabled={!loaded || action?.kind === "busy"}
                onPick={handleCopyShare}
                testidPrefix="viewer-share"
              />
            </div>
            <Button
              data-testid="viewer-export"
              disabled={!loaded || action?.kind === "busy"}
              onClick={handleExport}
              size="xs"
              variant="outline"
            >
              {action?.kind === "busy" ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Download data-icon="inline-start" />
              )}
              Download standalone HTML
            </Button>
          </>
        ) : (
          <span className="hidden font-mono text-micro text-ink-faint sm:inline">
            standalone export — runs offline
          </span>
        )}
      </div>
      {/* The action's honest feedback: the structured refusal of a clipboard
          or fetch, or the done line with the real byte size. Assertable.
          The strip claims no height until it has something to say. */}
      <div
        className="flex flex-col gap-0.5 px-(--pad-panel) text-ui has-[span:not(:empty)]:border-b has-[span:not(:empty)]:border-rule has-[span:not(:empty)]:py-1"
        aria-live="polite"
      >
        {action !== null ? (
          <span
            className={
              action.kind === "error" ? "text-destructive" : "text-ink-dim"
            }
            data-action-kind={action.kind}
            data-testid="viewer-action"
          >
            {action.message}
          </span>
        ) : null}
        <span
          className="text-destructive"
          data-testid="viewer-error"
          id="viewer-error"
        />
        {engine.regenerationIssue !== null ? (
          <span
            className="text-destructive"
            data-testid="viewer-regeneration-issue"
          >
            {engine.regenerationIssue}
          </span>
        ) : null}
      </div>
      {/* The split: part left, variables right; stacked under `lg` so an
          embed at any width scrolls, never overflows. */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* The stage IS the viewport surface — its own token material, not
            the chrome's (see DESIGN.md: the viewport does not follow the
            register), so a cold share page already reads as the instrument
            bed the loaded part will be drawn on. */}
        <div
          className="relative min-h-[320px] min-w-0 flex-1 bg-viewport lg:min-h-0"
          id={VIEWER_VIEWPORT_ID}
          data-testid="viewer-viewport"
        >
          {loaded ? (
            <CadViewport
              cameraControls
              className="h-full w-full"
              onSettled={() => {
                noteRenderedFrame(documentVolumeText);
              }}
              projection={applied === null ? null : applied.state.projection}
            />
          ) : (
            <>
              <StageRegistration />
              <ViewerEmptyState
                busy={serverShare.kind === "pending"}
                error={loadError}
                onLoad={adoptText}
                variant={variant}
              />
            </>
          )}
        </div>
        <aside className="flex w-full shrink-0 flex-col border-t border-rule bg-panel lg:w-(--rail-w-wide) lg:border-t-0 lg:border-l">
          {loaded ? (
            <CadParameterPanel
              className="min-h-0 flex-1 rounded-none border-0"
              labels={{ title: "Variables" }}
            />
          ) : (
            <>
              <PanelHeader title="Variables" trailing="0" />
              <p className="p-(--pad-panel) text-ui text-ink-dim">
                Load a part to edit its variables. Edits commit as
                <span className="font-mono text-ink"> parameter.set </span>
                commands — the geometry re-drives live.
              </p>
            </>
          )}
        </aside>
      </div>
      {/* The document's live identity stays reachable for the harness and
          screen readers without widening the bar: the feature and body
          counts as a single quiet line. */}
      <div className="sr-only" data-testid="viewer-summary">
        {summary === null
          ? "no document loaded"
          : `${summary.title}: ${String(summary.literalParameters)} literal variables, ${String(summary.expressionParameters)} expression variables, ${String(summary.features)} features, ${String(summary.bodies)} bodies`}
      </div>
    </div>
  );
}

/**
 * The empty stage's registration marks: the same corner brackets the
 * workbench wears around its viewport, drawn in the VIEWPORT's own rule
 * token (not the chrome's) so they read as part of the bed. Decoration
 * with a job: they state where the part will appear.
 */
function StageRegistration(): ReactElement {
  const corners = [
    "top-2 left-2 border-t border-l",
    "top-2 right-2 border-t border-r",
    "bottom-2 left-2 border-b border-l",
    "bottom-2 right-2 border-b border-r",
  ] as const;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {corners.map((corner) => (
        <span
          key={corner}
          className={`absolute size-3 border-viewport-rule-strong ${corner}`}
        />
      ))}
    </div>
  );
}

/** Fetches one standalone asset as text; non-2xx is a refusal, verbatim. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `${url}: ${String(response.status)} ${response.statusText}`,
    );
  }
  return response.text();
}

/**
 * The empty state: the paste zone and the file picker — the two local load
 * paths — with the honest share-format note and the workbench hint. A load
 * refusal (bad link payload, unparsable paste) surfaces verbatim here.
 */
function ViewerEmptyState({
  busy,
  error,
  onLoad,
  variant,
}: {
  /** A `?p=` share fetch is in flight — the paste zone is not the story. */
  readonly busy: boolean;
  readonly error: string | null;
  readonly onLoad: (text: string, source: string) => void;
  readonly variant: "page" | "standalone";
}): ReactElement {
  const [pasted, setPasted] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFile = useCallback(
    (file: File | undefined): void => {
      if (file === undefined) return;
      setFileName(file.name);
      void file.text().then((text) => onLoad(text, `file ${file.name}`));
    },
    [onLoad],
  );

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      {/* An overlay panel floating on the viewport bed: the one rung that
          carries a shadow, because this surface really is above the stage. */}
      <Panel elevation="overlay" className="w-full max-w-md">
        <PanelHeader title="Load a shared part" titleAs="h1" />
        <div className="p-(--pad-panel)">
          <p className="text-body text-ink-dim">
            The viewer draws a parametric part and lets anyone re-drive it: the
            variables on the right are live, the solid follows.
          </p>
          {busy ? (
            <p
              className="mt-3 font-mono text-data text-ink-dim"
              data-testid="viewer-share-fetching"
            >
              fetching the shared part…
            </p>
          ) : null}
          <label
            className="label-section mt-5 block text-ink-faint"
            htmlFor="viewer-paste"
          >
            Paste a native document
          </label>
          <textarea
            className="mt-1.5 h-28 w-full rounded-sm border border-rule-strong bg-well-deep px-2 py-1.5 font-mono text-data text-ink focus-instrument placeholder:text-ink-faint"
            data-testid="viewer-paste"
            id="viewer-paste"
            onChange={(event) => setPasted(event.target.value)}
            placeholder={'{\n  "formatVersion": …,\n  "document": { … }\n}'}
            spellCheck={false}
            value={pasted}
          />
          <div className="mt-3 flex flex-wrap items-center gap-(--gap)">
            <Button
              data-testid="viewer-load-paste"
              disabled={pasted.trim() === ""}
              onClick={() => onLoad(pasted, "pasted document")}
              size="sm"
            >
              Load pasted document
            </Button>
            <Button
              data-testid="viewer-load-file"
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              variant="outline"
            >
              Open a .json file
            </Button>
            <input
              accept=".json,application/json"
              aria-label="Open a native document file"
              className="sr-only"
              data-testid="viewer-file-input"
              onChange={(event) => {
                handleFile(event.target.files?.[0]);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            {fileName !== null ? (
              <span className="font-mono text-micro text-ink-faint">
                {fileName}
              </span>
            ) : null}
          </div>
          {error !== null ? (
            <p
              className="mt-3 text-ui text-destructive"
              data-testid="viewer-load-error"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-5 border-t border-rule pt-2.5">
            <p className="text-ui text-ink-dim">
              {variant === "page" ? (
                <>
                  In the workbench, <span className="font-mono">Share</span>{" "}
                  copies a link to this page with the part inside it.{" "}
                </>
              ) : null}
              {SHARE_FORMAT_NOTE}
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
