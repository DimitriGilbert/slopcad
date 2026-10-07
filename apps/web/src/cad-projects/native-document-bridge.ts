/**
 * The persistence bridge (Phase 31): the ONLY place the workbench's live
 * session meets the native `slopcad` document format. Save serializes the
 * session (document at the cursor + the dual-persisted history) plus the
 * engine's regeneration states, rollback marker, and suppressed-feature
 * set, and the document-level metadata and drawing held from the load,
 * into the format's canonical text — plain data, never kernel objects.
 * Open parses that text with the format's own full parser (which replays
 * the transaction log over the base and refuses any internal
 * inconsistency) and hands back a real `CadSession` for the store's
 * `replaceSession` door, plus the scene kind the reopened document's
 * features call for.
 *
 * This module imports from `@slopcad/cad-core` and the workbench engine
 * types ONLY — the database/api boundary lives in the routers, keeping the
 * CAD packages database-independent.
 */

import {
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type CadDocument,
  type CadSession,
  type DrawingDocument,
  type FeatureId,
  type FeatureRollbackPoint,
  type NativeCadDocument,
  type ParameterMetadataValue,
  type RegenerationStateMap,
} from "@slopcad/cad-core";

/** The engine's scene vocabulary (see the workbench engine's dispatch). */
export type WorkbenchSceneKind = "plate" | "extrude" | "revolve" | "hole";

/**
 * Serializes a live session into the native format's canonical text,
 * together with the document-level fields the session does not carry:
 * the metadata record and the drawing envelope are passed through from
 * the load (or empty/absent), so a round trip through the model
 * workbench never silently rewrites them — a drawing document saved
 * there keeps its drawing — and the engine's suppressed-feature set
 * rides the format's optional envelope field, so a suppressed timeline
 * survives the save. The format's serializer emits fixed key
 * order with sorted metadata, so the same session always persists to
 * identical bytes.
 */
export function serializeSessionToNativeText(
  session: CadSession,
  regeneration: RegenerationStateMap,
  rollback: FeatureRollbackPoint | null,
  metadata: Readonly<Record<string, ParameterMetadataValue>>,
  drawing: DrawingDocument | null,
  suppressedFeatures: ReadonlySet<FeatureId>,
): string {
  const native: NativeCadDocument = {
    document: session.document,
    history: session.history,
    regeneration,
    metadata,
    rollback,
    suppressedFeatures,
    drawing,
  };
  return stringifyNativeCadDocument(serializeNativeCadDocument(native));
}

/** The outcome of opening persisted text. */
export type ParsedNativeSession =
  | {
      readonly ok: true;
      readonly session: CadSession;
      readonly document: CadDocument;
      readonly scene: WorkbenchSceneKind;
      /** The document-level metadata (the shareable display title lives here). */
      readonly metadata: Readonly<Record<string, ParameterMetadataValue>>;
      /**
       * The persisted rollback marker (null when the file carries none), so
       * a reopened document executes the same parked timeline that was
       * saved — the marker is document-level state and survives the file
       * boundary like the history does.
       */
      readonly rollback: FeatureRollbackPoint | null;
      /**
       * The persisted authoring-suppressed feature set — the timeline
       * chips' suppression survives the file boundary like the marker
       * does. A payload without the field (every pre-field file) parses to
       * an empty set.
       */
      readonly suppressedFeatures: ReadonlySet<FeatureId>;
      /**
       * The document-resident drawing (sheets and views), or `null` when
       * the file carries none. Held by the model workbench and passed
       * back through Save untouched, so opening a drawing document there
       * and saving it never appends a drawing-less version (the review
       * fix for the save-path data loss).
       */
      readonly drawing: DrawingDocument | null;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Parses persisted native text through the format's own machinery (full
 * replay + state/log agreement check) and derives the scene kind the
 * document's newest solid feature calls for — a reopened document lands
 * with its model visible, not on an empty plate scene — surfacing the
 * persisted rollback marker and suppressed-feature set for the engine to
 * restore and the document-level metadata and drawing envelope for the
 * workbench to hold and pass back through Save.
 */
export function parseNativeTextToSession(text: string): ParsedNativeSession {
  const parsed = parseNativeCadDocumentFromString(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error.message };
  }
  return {
    ok: true,
    session: Object.freeze({
      document: parsed.value.document,
      history: parsed.value.history,
    }),
    document: parsed.value.document,
    metadata: parsed.value.metadata,
    scene: sceneKindOfDocument(parsed.value.document),
    rollback: parsed.value.rollback,
    // The parser defaults a field-free payload to the empty set; the `??`
    // only tames the envelope field's optional in-memory typing.
    suppressedFeatures: parsed.value.suppressedFeatures ?? new Set(),
    drawing: parsed.value.drawing,
  };
}

/**
 * The scene kind a document's features call for: the newest solid feature
 * (extrude, revolve, or hole) wins; a document with none stays on the
 * plate scene.
 */
export function sceneKindOfDocument(document: CadDocument): WorkbenchSceneKind {
  let scene: WorkbenchSceneKind = "plate";
  for (const feature of document.features) {
    if (
      feature.kind === "extrude" ||
      feature.kind === "revolve" ||
      feature.kind === "hole"
    ) {
      scene = feature.kind;
    }
  }
  return scene;
}
