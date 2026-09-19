/**
 * The honest scene fallback decision: the one rule the shared workbench
 * layout needs whenever the document regresses under the active scene —
 * an undo that reverts the anchored solid feature, a reopened older
 * version — leaving the scene's request reader returning `null`. The
 * engine's dispatch then silently no-ops (it fabricates nothing), but the
 * viewport would keep showing the removed solid with a stale
 * `data-scene-kind`, exactly the fabrication the engine's own contract
 * forbids: a host whose authoring actions can invalidate the active scene
 * "falls back honestly: point the dispatch at the plate scene rather than
 * leave stale pixels up". This module is that fallback as a pure decision
 * (the same one the complete workbench implements inline): when the
 * active scene no longer resolves, re-point at the highest scene the
 * document still resolves, in the create actions' precedence — hole over
 * revolve over extrude, then the plate.
 */

import type { CadDocument } from "@slopcad/cad-core";

import { documentExtrudeRequest } from "./extrude";
import { documentHoleSceneRequest } from "./hole";
import { documentRevolveRequest } from "./revolve";

/**
 * The workbench scene kinds the engine's dispatch can follow (the same
 * vocabulary the engine's `activeScene` state and the native-document
 * bridge's reopen derivation use).
 */
export type WorkbenchSceneKind = "plate" | "extrude" | "revolve" | "hole";

/**
 * The highest scene the document still resolves, in the create actions'
 * precedence: the hole composition when every hole still cuts its base,
 * else the revolve, else the extrude, else the plate (which follows the
 * stored hole parameter and always resolves).
 */
export function highestResolvableScene(
  document: CadDocument,
): WorkbenchSceneKind {
  if (documentHoleSceneRequest(document) !== null) return "hole";
  if (documentRevolveRequest(document) !== null) return "revolve";
  if (documentExtrudeRequest(document) !== null) return "extrude";
  return "plate";
}

/**
 * The honest fallback for the active scene over a document: `null` while
 * the active scene still resolves (the caller keeps it — the fallback only
 * ever falls back, so a newly created deeper scene wins through its own
 * action's scene switch, never through this), otherwise the highest scene
 * the document still resolves. The plate scene always resolves, so it
 * never falls back.
 */
export function honestSceneFallback(
  document: CadDocument,
  activeScene: WorkbenchSceneKind,
): WorkbenchSceneKind | null {
  if (activeScene === "plate") return null;
  const resolved =
    activeScene === "hole"
      ? documentHoleSceneRequest(document) !== null
      : activeScene === "revolve"
        ? documentRevolveRequest(document) !== null
        : documentExtrudeRequest(document) !== null;
  return resolved ? null : highestResolvableScene(document);
}
