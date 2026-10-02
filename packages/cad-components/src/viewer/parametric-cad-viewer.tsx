/**
 * `ParametricCadViewer` (the final registry phase): one installable block
 * that draws a part beside its variables — the left-right experience the
 * workbench gives a shared part, packaged for registry consumers.
 *
 * - **Left** — the installed `CadViewport` (this item's registry
 *   dependency) drawing the part from pre-tessellated bodies projected
 *   through the public cad-core projection path, framed by a
 *   deterministic home camera derived from the part's own bounds.
 * - **Right** — the installed `CadParameterPanel` (the other registry
 *   dependency) in provider mode, editing the document's variables
 *   through Formedible and committing every edit as a real `parameter.set`
 *   transaction over a real public `createCadStore` — the domain's single
 *   interpreter re-evaluates expressions and dependents, exactly as in the
 *   app. No second write path, no re-implemented validation.
 *
 * ## The honest capability boundary (read before wiring `rebuild`)
 *
 * This component renders and edits; it does NOT evaluate geometry. The
 * native format's feature graph is host-interpreted (the workbench's
 * worker-backed engine), and no public package exposes that evaluation —
 * so the part arrives as tessellations (`bodies`, from whatever kernel
 * the consumer drove), and re-derivation after a parameter edit is the
 * CONSUMER's side of the loop:
 *
 * - Pass nothing else and the viewer is emit-only: every applied edit
 *   updates the store, and {@link ParametricCadViewerProps.onDocumentChange}
 *   receives the edited session's canonical native text plus the document.
 * - Pass {@link ParametricCadViewerProps.rebuild} and the same edit
 *   re-renders: the callback receives the edited document, returns fresh
 *   tessellations from the consumer's own pipeline (e.g. the main-thread
 *   Manifold kernel the `plate-workbench` block drives, or the registry's
 *   own parametric components), and the viewer swaps the projection. A
 *   stale rebuild (a newer edit arrived) is dropped, and a rejected one
 *   surfaces verbatim in the status region — never a fake re-drive.
 *
 * This file is authored in `packages/cad-components` but installed into a
 * consumer's `src/` by the shadcn CLI: the `@/components/...` imports
 * resolve there against the sibling items this block's registry
 * dependencies installed (the viewport and the parameter panel), and at
 * authoring time against the same files in `packages/ui` (the tsconfig
 * path mapping). One source of truth either way.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  type CadDocument,
  type RenderCamera,
  type RenderProjection,
} from "@slopcad/cad-react";

import {
  loadViewerSource,
  projectViewerBodies,
  serializeViewerSession,
  type ViewerBody,
} from "./parametric-viewer-core";

import { CadViewport } from "@/components/cad/cad-viewport";
import { CadParameterPanel } from "@/components/cad/cad-parameter-panel";

/** The edited document a parameter edit produced, both directions out. */
export interface ParametricCadViewerDocumentChange {
  /** The edited session's canonical native text (a save writes these bytes). */
  readonly nativeText: string;
  /** The edited document at the history cursor. */
  readonly document: CadDocument;
}

/** The consumer's geometry re-derivation: edited document in, bodies out. */
export type ParametricCadViewerRebuild = (
  change: ParametricCadViewerDocumentChange,
) => Promise<readonly ViewerBody[] | null>;

/** The phase of the consumer-side rebuild loop. */
type ViewerRebuildStatus = "idle" | "pending" | "failed";

export interface ParametricCadViewerProps {
  /** The part's native document text — the format a save/share writes. */
  readonly nativeText: string;
  /**
   * The part's tessellated bodies, or `null` while the consumer's kernel
   * works (the viewport's loading state). One body per rendered solid.
   */
  readonly bodies: readonly ViewerBody[] | null;
  /**
   * A fixed camera; omit for the deterministic home view derived from the
   * part's own bounds (re-derived as the part's size changes).
   */
  readonly camera?: RenderCamera;
  /**
   * Emitted after every applied parameter edit: the edited session's
   * canonical native text and document. The escape hatch for consumers
   * that persist, re-share, or re-derive on their own schedule.
   */
  readonly onDocumentChange?: (
    change: ParametricCadViewerDocumentChange,
  ) => void;
  /**
   * The live re-drive: called with the edited document after every applied
   * edit; resolves to fresh tessellations (rendered) or `null` (geometry
   * intentionally unchanged). Rejections surface verbatim in the status
   * region; a stale rebuild (a newer edit superseded it) is dropped.
   */
  readonly rebuild?: ParametricCadViewerRebuild;
  /** Extends the root container's classes. */
  readonly className?: string;
  /** Extends the viewport's classes (default `h-[520px] w-[800px]`). */
  readonly viewportClassName?: string;
  /** Extends the parameter panel's classes (default `w-72`). */
  readonly panelClassName?: string;
}

/** Documented label defaults; every component-authored string lives here. */
const VIEWPORT_DEFAULT_CLASSES = "h-[520px] w-[800px]";
const PANEL_DEFAULT_CLASSES = "w-72";

/**
 * The parametric viewer: the part on the left, its variables on the right.
 */
export function ParametricCadViewer({
  nativeText,
  bodies,
  camera,
  onDocumentChange,
  rebuild,
  className,
  viewportClassName,
  panelClassName,
}: ParametricCadViewerProps): ReactElement {
  // The parsed source, its store, and the render state. The source memo
  // keys on the text (a stable primitive); the store keys on the source;
  // a changed document text boots a fresh store over the fresh session.
  const source = useMemo(() => loadViewerSource(nativeText), [nativeText]);
  const store = useMemo(
    () => (source.ok ? createCadStore({ session: source.session }) : null),
    [source],
  );

  const [projection, setProjection] = useState<RenderProjection | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rebuildStatus, setRebuildStatus] =
    useState<ViewerRebuildStatus>("idle");
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [settledFrames, setSettledFrames] = useState(0);

  // The camera's identity is not stable across consumer renders (an inline
  // literal would re-run the projection effect forever), so the effect keys
  // on the camera's canonical JSON — the value, not the wrapper — and the
  // handlers below read the live prop through refs.
  const cameraKey = camera === undefined ? "auto" : JSON.stringify(camera);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const onDocumentChangeRef = useRef(onDocumentChange);
  onDocumentChangeRef.current = onDocumentChange;
  const rebuildRef = useRef(rebuild);
  rebuildRef.current = rebuild;
  const generationRef = useRef(0);

  useEffect(() => {
    if (!source.ok) return;
    if (bodies === null) {
      setProjection(null);
      setRenderError(null);
      return;
    }
    const build = projectViewerBodies(bodies, cameraRef.current);
    setProjection(build.ok ? build.projection : null);
    setRenderError(build.ok ? null : build.error);
  }, [source, bodies, cameraKey]);

  useEffect(() => {
    if (store === null || !source.ok) return;
    return store.subscribeDocument(() => {
      const session = store.getSession();
      const change: ParametricCadViewerDocumentChange = {
        nativeText: serializeViewerSession(session, source.persisted),
        document: session.document,
      };
      onDocumentChangeRef.current?.(change);
      const rebuildFn = rebuildRef.current;
      if (rebuildFn === undefined) return;
      generationRef.current += 1;
      const generation = generationRef.current;
      setRebuildStatus("pending");
      setRebuildError(null);
      void rebuildFn(change)
        .then((next: readonly ViewerBody[] | null) => {
          if (generationRef.current !== generation) return;
          setRebuildStatus("idle");
          if (next === null) return;
          const build = projectViewerBodies(next, cameraRef.current);
          setProjection(build.ok ? build.projection : null);
          setRenderError(build.ok ? null : build.error);
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generation) return;
          setRebuildStatus("failed");
          setRebuildError(
            error instanceof Error ? error.message : String(error),
          );
        });
    });
  }, [store, source]);

  const parseError = source.ok ? null : source.error;
  const buildError = parseError ?? renderError ?? rebuildError;

  return (
    <section
      id="parametric-cad-viewer-root"
      aria-labelledby="parametric-cad-viewer-heading"
      className={`w-full max-w-6xl space-y-4${className === undefined ? "" : ` ${className}`}`}
    >
      <header className="space-y-1">
        <h2
          id="parametric-cad-viewer-heading"
          className="text-lg font-semibold"
        >
          {source.ok ? source.summary.title : "Parametric viewer"}
        </h2>
        <p className="text-muted-foreground text-sm">
          {source.ok
            ? `${String(source.summary.parameterCount)} parameters · ${String(source.summary.featureCount)} features · ${String(source.summary.bodyCount)} bodies`
            : "The document could not be loaded."}
        </p>
      </header>
      {source.ok && store !== null ? (
        <CadProvider store={store}>
          <div className="flex w-full flex-wrap items-start gap-6">
            <div className="space-y-2">
              <div id="parametric-cad-viewer-viewport" className="relative">
                <CadViewport
                  className={
                    viewportClassName === undefined
                      ? VIEWPORT_DEFAULT_CLASSES
                      : viewportClassName
                  }
                  projection={projection}
                  onSettled={() => {
                    setSettledFrames((frames) => frames + 1);
                  }}
                />
              </div>
            </div>
            <div className="flex w-72 shrink-0 flex-col gap-4">
              <CadParameterPanel
                className={
                  panelClassName === undefined
                    ? PANEL_DEFAULT_CLASSES
                    : panelClassName
                }
              />
            </div>
            <ul className="space-y-1 font-mono text-xs">
              <li>
                parse ={" "}
                <span data-testid="viewer-parse-status">
                  {parseError === null ? "ok" : "failed"}
                </span>
              </li>
              <li>
                render ={" "}
                <span data-testid="viewer-render-status">
                  {bodies === null
                    ? "waiting"
                    : renderError === null
                      ? "ok"
                      : "failed"}
                </span>
              </li>
              <li>
                rebuild ={" "}
                <span data-testid="viewer-rebuild-status">{rebuildStatus}</span>
              </li>
              <li>
                frames ={" "}
                <span data-testid="viewer-settled-frames">
                  {String(settledFrames)}
                </span>
              </li>
              <li className="text-destructive">
                <span data-testid="viewer-build-error">{buildError ?? ""}</span>
              </li>
            </ul>
          </div>
        </CadProvider>
      ) : (
        <p
          data-testid="viewer-build-error"
          role="alert"
          className="text-destructive font-mono text-xs"
        >
          {buildError ?? ""}
        </p>
      )}
    </section>
  );
}
