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
import { documentLoftRequest } from "./loft";
import { documentRevolveRequest } from "./revolve";
import { documentHelixRequest } from "./helix";
import { documentThreadSceneRequest } from "./thread";
import { documentSweepRequest } from "./sweep";
import { documentRibSceneRequest } from "./rib";
import {
  documentScaleSceneRequest,
  documentThickenSceneRequest,
} from "./scale-thicken";
import { documentSplitSceneRequest } from "./split";
import { documentSheetSceneRequest } from "./surface-scene";
import {
  documentMirrorSceneRequest,
  documentPatternFeatureSceneRequest,
  documentPatternPathSceneRequest,
} from "./pattern";
import { documentDuplicateSceneRequests } from "./duplicate";

/**
 * The workbench scene kinds the engine's dispatch can follow (the same
 * vocabulary the engine's `activeScene` state and the native-document
 * bridge's reopen derivation use). Phase 38 adds the sweep and loft
 * scenes. Phase 47 adds the `curves` scene (the curve-record authoring
 * surface — it resolves while the document carries at least one curve
 * record and renders them as the curve overlay over the highest solid
 * scene).
 */
export type WorkbenchSceneKind =
  | "plate"
  | "extrude"
  | "revolve"
  | "sweep"
  | "loft"
  | "helix"
  | "thread"
  | "boolean"
  | "moveBody"
  | "rib"
  | "scale"
  | "thicken"
  | "split"
  | "patternFeature"
  | "patternPath"
  | "mirror"
  | "duplicate"
  | "hole"
  | "curves"
  | "sheet";

/**
 * The highest scene the document still resolves, in the create actions'
 * precedence: the hole composition when every hole still cuts its base,
 * else the loft, else the sweep, else the revolve, else the extrude, else
 * the plate (which follows the stored hole parameter and always resolves).
 */
export function highestResolvableScene(
  document: CadDocument,
): WorkbenchSceneKind {
  if (documentSheetSceneRequest(document) !== null) return "sheet";
  if (documentHoleSceneRequest(document) !== null) return "hole";
  if (documentThreadSceneRequest(document) !== null) return "thread";
  if (documentMirrorSceneRequest(document) !== null) return "mirror";
  if (documentPatternPathSceneRequest(document) !== null) {
    return "patternPath";
  }
  if (documentPatternFeatureSceneRequest(document) !== null) {
    return "patternFeature";
  }
  if (documentDuplicateSceneRequests(document).length > 0) {
    return "duplicate";
  }
  if (documentSplitSceneRequest(document) !== null) return "split";
  if (documentThickenSceneRequest(document) !== null) return "thicken";
  if (documentScaleSceneRequest(document) !== null) return "scale";
  if (documentRibSceneRequest(document) !== null) return "rib";
  if (documentHelixRequest(document) !== null) return "helix";
  if (documentLoftRequest(document) !== null) return "loft";
  if (documentSweepRequest(document) !== null) return "sweep";
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
  // The curves scene resolves while the document carries at least one
  // curve record — an undo that removes the last curve falls back to the
  // highest solid scene (never stale curve pixels).
  if (activeScene === "curves") {
    return document.curves.length > 0 ? null : highestResolvableScene(document);
  }
  const resolved =
    activeScene === "sheet"
      ? documentSheetSceneRequest(document) !== null
      : activeScene === "hole"
        ? documentHoleSceneRequest(document) !== null
        : activeScene === "thread"
          ? documentThreadSceneRequest(document) !== null
          : activeScene === "mirror"
            ? documentMirrorSceneRequest(document) !== null
            : activeScene === "patternPath"
              ? documentPatternPathSceneRequest(document) !== null
              : activeScene === "patternFeature"
                ? documentPatternFeatureSceneRequest(document) !== null
                : activeScene === "duplicate"
                  ? documentDuplicateSceneRequests(document).length > 0
                  : activeScene === "split"
                    ? documentSplitSceneRequest(document) !== null
                    : activeScene === "thicken"
                      ? documentThickenSceneRequest(document) !== null
                      : activeScene === "scale"
                        ? documentScaleSceneRequest(document) !== null
                        : activeScene === "rib"
                          ? documentRibSceneRequest(document) !== null
                          : activeScene === "helix"
                            ? documentHelixRequest(document) !== null
                            : activeScene === "loft"
                              ? documentLoftRequest(document) !== null
                              : activeScene === "sweep"
                                ? documentSweepRequest(document) !== null
                                : activeScene === "revolve"
                                  ? documentRevolveRequest(document) !== null
                                  : documentExtrudeRequest(document) !== null;
  return resolved ? null : highestResolvableScene(document);
}
