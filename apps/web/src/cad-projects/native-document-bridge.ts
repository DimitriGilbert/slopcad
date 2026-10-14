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

import { holeDiameterMm } from "../workbench-fixture/workbench-document";

/** The engine's scene vocabulary (see the workbench engine's dispatch). */
export type WorkbenchSceneKind =
  "empty" | "plate" | "extrude" | "primitive" | "revolve" | "hole";

/**
 * The native text's emission variants a share path can choose from (the
 * save path always writes the legacy form). The variants change only the
 * JSON presentation and the authoring history's presence — the format's
 * parser accepts all three through the same replay, and the fragment
 * grammar does not distinguish them (every variant rides `1d`/`1b`), so
 * a link of any variant decodes on every page that can decode one of
 * them.
 */
export type NativeShareVariant = "lean" | "compact" | "legacy";

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
 *
 * The `variant` picks the emission form: `"legacy"` (the default, and
 * the only form the save path writes) keeps the file encoding —
 * two-space pretty JSON with a trailing newline and the full authoring
 * history. `"compact"` emits the same value tree without the
 * pretty-print whitespace (the parser is whitespace-blind). `"lean"`
 * additionally collapses the history to the base-only form the format's
 * own factory emits — the document is its own base, no transactions —
 * because a viewer link's reader replays the part, not the authoring
 * timeline. On a real part the lean link is roughly half the legacy
 * link's length after deflate — the difference between a URL social
 * platforms truncate and one they pass through.
 */
export function serializeSessionToNativeText(
  session: CadSession,
  regeneration: RegenerationStateMap,
  rollback: FeatureRollbackPoint | null,
  metadata: Readonly<Record<string, ParameterMetadataValue>>,
  drawing: DrawingDocument | null,
  suppressedFeatures: ReadonlySet<FeatureId>,
  variant: NativeShareVariant = "legacy",
): string {
  const native: NativeCadDocument = {
    document: session.document,
    // The lean variant's collapsed history must stay the factory's own
    // shape (base = the current document, no entries): the parser replays
    // the log over the base and refuses a state/log mismatch, and an
    // empty replay of the document over itself is exactly what agrees.
    history:
      variant === "lean"
        ? { base: session.document, entries: [], cursor: 0 }
        : session.history,
    regeneration,
    metadata,
    rollback,
    suppressedFeatures,
    drawing,
  };
  const serialized = serializeNativeCadDocument(native);
  return variant === "legacy"
    ? stringifyNativeCadDocument(serialized)
    : JSON.stringify(serialized);
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
 * (extrude, revolve, hole, or a box/sphere/cylinder/cone primitive — the
 * `primitive` scene) wins; a document with none falls to the plate when
 * it carries the fixture's hole parameter (demo-era saves) or the empty
 * scene — the clean bench reopens as the clean bench.
 */
export function sceneKindOfDocument(document: CadDocument): WorkbenchSceneKind {
  let scene: WorkbenchSceneKind =
    holeDiameterMm(document) !== null ? "plate" : "empty";
  for (const feature of document.features) {
    if (
      feature.kind === "extrude" ||
      feature.kind === "revolve" ||
      feature.kind === "hole"
    ) {
      scene = feature.kind;
    } else if (
      feature.kind === "box" ||
      feature.kind === "sphere" ||
      feature.kind === "cylinder" ||
      feature.kind === "cone"
    ) {
      scene = "primitive";
    }
  }
  return scene;
}
