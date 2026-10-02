/**
 * The viewer engine (Phase — shareable parametric pages): the MINIMAL
 * document session a shared part needs — the workbench engine's data plane
 * cut down to render + re-drive, so the viewer and the workbench stay one
 * derivation apart exactly the way the composed workbench pages do.
 *
 * What is here (each piece imported, not forked):
 *
 * - the store: one cad store over the workbench boot session (replaced by
 *   the shared document through `replaceSession`, the store's one
 *   whole-session door — the projects page's path), with the SELECT tool
 *   registered for click-picks. Nothing is armed: a viewer has no tools.
 * - the threaded regeneration loop: the engine's derivation, trimmed to
 *   the viewer's authoring surface — no suppression, no rollback UI (the
 *   PERSISTED rollback marker still rides: a saved parked timeline reopens
 *   parked). The parameter-bound-sketch edge survives: an edit to a
 *   parameter a sketch binds re-executes the consuming features.
 * - the scene dispatch: `documentSceneBodies` → `dispatchDocument`, the
 *   plate fallback behind it, byte-for-byte the workbench's decision.
 * - the settle surface: the session's settle attributes land on the root
 *   element, the render stamp on `data-cad-rendered-volume` — the same
 *   protocol the harness reads everywhere else.
 *
 * What is deliberately NOT here: every authoring action, the sketch mode,
 * the timeline/machine surfaces. The viewer renders and re-drives; it does
 * not author.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCadStore,
  documentChangeInvalidations,
  initialRegenerationStates,
  markStale,
  parseParameterId,
  regenerate,
  registerTool,
  selectTool,
  useCadDocument,
  useCadStore,
  type FeatureId,
  type FeatureRollbackPoint,
  type RegenerationResultMap,
  type RegenerationStateMap,
} from "@slopcad/cad-react";
import type { SectionDisplayRequest } from "../render-fixture/plate-render-scene";

import { serializeSessionToNativeText } from "../cad-projects/native-document-bridge";
import {
  documentSceneBodies,
  renderableBodyIds,
} from "../cad-workbench/document-scene";
import { sketchIdsBoundToParameters } from "../cad-workbench/extrude";
import {
  clampedRollbackMarker,
  rollbackMarkerKey,
} from "../cad-workbench/rollback-marker";
import { createCadWorkbenchSession } from "../cad-workbench/session";
import {
  bootRenderFixtureSession,
  type FixtureRenderState,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { holeDiameterMm } from "../workbench-fixture/workbench-document";
import { workbenchExecutor } from "../workbench-fixture/workbench-extended-document";
import { loadViewerDocument, type ViewerDocumentLoad } from "./viewer-document";

/** The ids the booted session writes its settle surface into. */
export interface ViewerEngineSurface {
  /** The element receiving the settle `data-*` attributes. */
  readonly rootId: string;
  /** The status span the session writer updates. */
  readonly statusId?: string;
  /** The volume span the session writer updates. */
  readonly volumeId?: string;
  /** The error span the session writer updates. */
  readonly errorId?: string;
}

/** Boot options beyond the ids (the standalone mount's inline worker). */
export interface ViewerEngineOptions {
  /**
   * Overrides the default fixture worker (the bundler-emitted module
   * worker, which a `file://` standalone cannot fetch): the standalone
   * mount passes its inlined blob worker. The session protocol is
   * identical either way.
   */
  readonly workerFactory?: () => Worker;
}

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: FixtureRenderState;
  readonly revision: number;
}

/** The previous inputs the derivation effect diffs against. */
interface DerivationPrevious {
  /** The load epoch the baseline was taken at (a session swap reruns all). */
  readonly epoch: number;
  readonly document: ReturnType<typeof useCadDocument>["document"];
  readonly rollbackKey: string;
  readonly states: RegenerationStateMap;
  readonly results: RegenerationResultMap;
}

/** Everything the viewer surface renders from. */
export interface ViewerEngine {
  /** The store (the parameter panel's apply surface below the provider). */
  readonly store: ReturnType<typeof useCadStore>;
  readonly documentApi: ReturnType<typeof useCadDocument>;
  /** The applied render state, or `null` before the first settle. */
  readonly applied: AppliedRenderState | null;
  /** The live rollback marker (restored from the shared document). */
  readonly rollback: FeatureRollbackPoint | null;
  /** The threaded loop's durable state map (serialized with shares). */
  readonly regenerationStates: RegenerationStateMap | null;
  /** The last derivation failure, or `null`. */
  readonly regenerationIssue: string | null;
  /** The settled render-frame count (the scene's frame counter). */
  readonly renderedFrames: number;
  /**
   * Adopts shared native text: the bridge's parse, then `replaceSession`
   * + the persisted rollback + a full regeneration pass (the epoch bump).
   * Refusals return the structured load failure and change nothing.
   */
  readonly adopt: (nativeText: string) => ViewerDocumentLoad;
  /**
   * Serializes the LIVE session through the native bridge — the text a
   * share link encodes and the standalone export embeds. Edits made in
   * the viewer are part of it.
   */
  readonly currentNativeText: () => string;
  /**
   * Counts one settled projection frame and stamps the scene's settle
   * volume into the root (`null` counts only — a frame that does not
   * belong to the document projection must not stamp it).
   */
  readonly noteRenderedFrame: (stampVolume: string | null) => void;
}

/**
 * Runs the viewer engine below a `CadProvider`: the store's hook surfaces,
 * the trimmed regeneration loop, the booted worker session writing its
 * settle surface into `surface`, the scene dispatch, and the settle stamp.
 */
export function useViewerEngine(
  surface: ViewerEngineSurface,
  options: ViewerEngineOptions = {},
): ViewerEngine {
  const { rootId, statusId, volumeId, errorId } = surface;
  const { workerFactory } = options;
  const store = useCadStore("useViewerEngine");
  const documentApi = useCadDocument();

  const [applied, setApplied] = useState<AppliedRenderState | null>(null);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  /**
   * Counts one settled frame and synchronously stamps the settle volume —
   * the workbench engine's exact semantics (the settle protocol compares
   * this stamp against the settled volume before pixels may be asserted).
   */
  const noteRenderedFrame = useCallback(
    (stampVolume: string | null): void => {
      if (stampVolume !== null) {
        document
          .getElementById(rootId)
          ?.setAttribute("data-cad-rendered-volume", stampVolume);
      }
      setRenderedFrames((frames) => frames + 1);
    },
    [rootId],
  );

  // The persisted authoring state that survives the file boundary: the
  // rollback marker (a shared parked timeline reopens parked). Suppression
  // is engine-side session state and has no share representation.
  const [rollback, setRollback] = useState<FeatureRollbackPoint | null>(null);
  // The load epoch: bumped by every `adopt`, it forces the derivation's
  // next pass to run the FULL timeline (a whole-session swap cannot diff).
  const [epoch, setEpoch] = useState(0);

  const [regenerationStates, setRegenerationStates] =
    useState<RegenerationStateMap | null>(null);
  const [regenerationIssue, setRegenerationIssue] = useState<string | null>(
    null,
  );

  const adopt = useCallback(
    (nativeText: string): ViewerDocumentLoad => {
      const load = loadViewerDocument(nativeText);
      if (!load.ok) return load;
      store.replaceSession(load.parsed.session);
      setRollback(load.parsed.rollback ?? null);
      setEpoch((current) => current + 1);
      return load;
    },
    // `load.parsed` is the loaded variant on the `ok` arm (the pipeline's
    // own narrowing); `replaceSession` takes it directly.
    [store],
  );

  const currentNativeText = useCallback(
    (): string =>
      serializeSessionToNativeText(
        store.getSession(),
        // The live states ride so a reopened share keeps its per-feature
        // view; before the first pass there is nothing to persist.
        regenerationStates ?? new Map(),
        rollback,
      ),
    [regenerationStates, rollback, store],
  );

  const workbenchDocument = documentApi.document;

  // -- The threaded regeneration loop (the engine's derivation, trimmed) --
  const previousRef = useRef<DerivationPrevious | null>(null);
  const rollbackKey = rollbackMarkerKey(rollback);

  useEffect(() => {
    const previous = previousRef.current;
    if (
      previous !== null &&
      previous.epoch === epoch &&
      previous.document === workbenchDocument &&
      previous.rollbackKey === rollbackKey
    ) {
      return;
    }
    // The stale-marker clamp: a marker the adopted document no longer
    // declares clears itself and this pass runs the FULL timeline.
    const rollbackPoint = clampedRollbackMarker(
      workbenchDocument.features,
      rollback,
    );
    if (rollbackPoint === null && rollback !== null) {
      setRollback(null);
    }
    const changedNodes =
      previous !== null &&
      previous.epoch === epoch &&
      previous.document !== workbenchDocument
        ? documentChangeInvalidations(previous.document, workbenchDocument)
        : [];
    // The parameter-bound-sketch edge (the engine's rule verbatim): a
    // feature consumes its sketch record, so expand every changed
    // parameter into the sketches bound to it — the sketch→feature edges
    // then invalidate exactly the consuming features.
    const changedParameterIds = new Set(
      changedNodes.flatMap((node) => {
        const parsed = parseParameterId(node);
        return parsed.ok ? [parsed.value] : [];
      }),
    );
    const boundSketchIds = sketchIdsBoundToParameters(
      workbenchDocument,
      changedParameterIds,
    );
    const states =
      previous !== null && previous.epoch === epoch
        ? markStale(workbenchDocument.features, previous.states, [
            ...changedNodes,
            ...boundSketchIds,
          ])
        : initialRegenerationStates(workbenchDocument.features);
    const run = regenerate({
      features: workbenchDocument.features,
      states,
      suppressed: [] as FeatureId[],
      execute: workbenchExecutor(workbenchDocument),
      rollbackPoint,
      results:
        previous !== null && previous.epoch === epoch
          ? previous.results
          : undefined,
    });
    if (!run.ok) {
      setRegenerationIssue(run.error.message);
      return;
    }
    setRegenerationIssue(null);
    setRegenerationStates(run.value.states);
    previousRef.current = {
      epoch,
      document: workbenchDocument,
      // The CLAMPED key (the engine's discipline): the pass above ran with
      // this marker, so the clear lands as a no-op instead of a second pass.
      rollbackKey: rollbackMarkerKey(rollbackPoint),
      states: run.value.states,
      results: run.value.results,
    };
  }, [epoch, workbenchDocument, rollback, rollbackKey]);

  // The boot: the fixture session (client-only) writing its settle surface
  // into the ids the surface names. Declared before the dispatch effect so
  // the mount pass runs with the session already in sessionRef.
  useEffect(() => {
    const session = bootRenderFixtureSession(
      { rootId, statusId, volumeId, errorId },
      (state, revision) => {
        setApplied({ state, revision });
      },
      { workerFactory },
    );
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
    // The factory is boot-time configuration (the standalone mount passes
    // a stable module-level constructor) — remount to change it.
  }, [rootId, statusId, volumeId, errorId, workerFactory]);

  // The scene dispatch (the engine's decision verbatim): every document /
  // rollback change rebuilds the DOCUMENT scene request — one body-scene
  // per lineage tip — and dispatches it as ONE settle. Only when NO active
  // feature's scene resolves (the fixture plate among them) does the plate
  // dispatch follow the stored hole diameter, carrying the document's
  // persisted section record when it ships enabled.
  const documentSection = workbenchDocument.sections[0] ?? null;
  const activeSectionRequest: SectionDisplayRequest | null = useMemo(() => {
    if (documentSection === null || documentSection.enabled !== true) {
      return null;
    }
    return {
      origin: documentSection.origin,
      normal: documentSection.normal,
      keepSide: documentSection.keepSide,
      viewMode: false,
    };
  }, [documentSection]);
  const storedHole = useMemo(
    () => holeDiameterMm(workbenchDocument),
    [workbenchDocument],
  );

  useEffect(() => {
    const bodies = documentSceneBodies(workbenchDocument, new Set(), rollback);
    if (bodies.length > 0) {
      sessionRef.current?.dispatchDocument(
        bodies,
        renderableBodyIds(workbenchDocument),
      );
      return;
    }
    if (storedHole !== null) {
      sessionRef.current?.dispatch(storedHole, activeSectionRequest);
    }
  }, [workbenchDocument, rollback, storedHole, activeSectionRequest]);

  // The host pushes the CURRENT projection into the store — the projection
  // access the (never armed) tools would read; the contract stays intact.
  useEffect(() => {
    store.setProjection(applied === null ? null : applied.state.projection);
  }, [applied, store]);

  return {
    store,
    documentApi,
    applied,
    rollback,
    regenerationStates,
    regenerationIssue,
    renderedFrames,
    adopt,
    currentNativeText,
    noteRenderedFrame,
  };
}

/** The store factory the viewer surface composes ONCE above the provider. */
export function useViewerStore(): ReturnType<typeof createCadStore> {
  const [store] = useState(() =>
    createCadStore({
      session: createCadWorkbenchSession(),
      tools: [registerTool(selectTool)],
    }),
  );
  return store;
}
