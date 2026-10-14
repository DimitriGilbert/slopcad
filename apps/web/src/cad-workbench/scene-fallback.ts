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
 * revolve over extrude, then the fixture plate, then the empty scene.
 */

import type { CadDocument } from "@slopcad/cad-core";

import { holeDiameterMm } from "../workbench-fixture/workbench-document";
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
import { documentPrimitiveSceneRequests } from "./primitive";
import { documentMoveBodySceneRequests } from "./move-body";
import { documentTopologyCutSceneRequests } from "./topology-cut";
import { documentFaceOpSceneRequests } from "./face-op";

/**
 * The workbench scene kinds the engine's dispatch can follow (the same
 * vocabulary the engine's `activeScene` state and the native-document
 * bridge's reopen derivation use). Phase 38 adds the sweep and loft
 * scenes. Phase 47 adds the `curves` scene (the curve-record authoring
 * surface — it resolves while the document carries at least one curve
 * record and renders them as the curve overlay over the highest solid
 * scene). The `primitive` scene resolves while the document carries at
 * least one in-domain box/sphere/cylinder/cone feature; the `topologyCut`
 * scene while it carries at least one in-domain fillet/chamfer/shell; the
 * `faceOp` scene while it carries at least one in-domain moveFace/
 * deleteFace/replaceFace.
 */
export type WorkbenchSceneKind =
  | "empty"
  | "plate"
  | "extrude"
  | "primitive"
  | "topologyCut"
  | "faceOp"
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
 * any resolving move-body feature (a placed primitive on a blank bench),
 * else any in-domain primitive, else the plate when the document carries the
 * fixture's hole parameter (the plate computation follows it), else
 * `empty` — the clean bench resolves nothing and renders the honest empty
 * scene.
 */
export function highestResolvableScene(
  document: CadDocument,
): WorkbenchSceneKind {
  if (documentSheetSceneRequest(document) !== null) return "sheet";
  if (documentHoleSceneRequest(document) !== null) return "hole";
  if (documentThreadSceneRequest(document) !== null) return "thread";
  if (documentFaceOpSceneRequests(document).length > 0) return "faceOp";
  if (documentTopologyCutSceneRequests(document).length > 0) {
    return "topologyCut";
  }
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
  if (documentMoveBodySceneRequests(document).length > 0) return "moveBody";
  if (documentPrimitiveSceneRequests(document).length > 0) {
    return "primitive";
  }
  return holeDiameterMm(document) !== null ? "plate" : "empty";
}

/**
 * The honest fallback for the active scene over a document: `null` while
 * the active scene still resolves (the caller keeps it — the fallback only
 * ever falls back, so a newly created deeper scene wins through its own
 * action's scene switch, never through this), otherwise the highest scene
 * the document still resolves. The empty scene never falls back (it
 * resolves always); the plate holds only while the document carries the
 * fixture's hole parameter — a parameter delete strands it like any
 * other scene's regression.
 */
export function honestSceneFallback(
  document: CadDocument,
  activeScene: WorkbenchSceneKind,
): WorkbenchSceneKind | null {
  if (activeScene === "empty") return null;
  if (activeScene === "plate") {
    return holeDiameterMm(document) !== null
      ? null
      : highestResolvableScene(document);
  }
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
          : activeScene === "faceOp"
            ? documentFaceOpSceneRequests(document).length > 0
            : activeScene === "topologyCut"
              ? documentTopologyCutSceneRequests(document).length > 0
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
                                      ? documentRevolveRequest(document) !==
                                        null
                                      : activeScene === "moveBody"
                                        ? documentMoveBodySceneRequests(
                                            document,
                                          ).length > 0
                                        : activeScene === "primitive"
                                          ? documentPrimitiveSceneRequests(
                                              document,
                                            ).length > 0
                                          : documentExtrudeRequest(document) !==
                                            null;
  return resolved ? null : highestResolvableScene(document);
}
