/**
 * The stale rollback-marker clamp: the one decision every regeneration
 * pass needs about the page-level marker — is it still meaningful for THIS
 * feature list? A marker is page-level authoring state that can outlive
 * the feature it anchors (an undo removes the anchored feature; an opened
 * older version never had it), while every marker consumer
 * (`regenerate`, `featureTimeline`, the native serializer) hard-fails on a
 * dead anchor — wedging the regeneration loop until the marker is cleared
 * by hand. The clamp keeps the consumers' contract while making the
 * document's own regression self-heal: a stale marker reads as "no
 * marker", so the full timeline executes again.
 *
 * Shared by the workbench engine and the chain workbench page, which run
 * the identical derivation pass over their own documents.
 */

import type { FeatureId, FeatureRollbackPoint } from "@slopcad/cad-react";

/**
 * The marker a regeneration pass should run with for a feature list: the
 * marker itself when it names one of the list's features (or sits at the
 * timeline start, where `rollbackZoneBoundary` is always `ok(0)`), `null`
 * when it has gone stale. Valid markers keep today's parking semantics
 * exactly; only the dead-anchor case changes.
 */
export function clampedRollbackMarker(
  features: readonly { readonly id: FeatureId }[],
  rollback: FeatureRollbackPoint | null,
): FeatureRollbackPoint | null {
  if (rollback === null) return null;
  if (rollback.afterFeatureId === null) return rollback;
  return features.some((feature) => feature.id === rollback.afterFeatureId)
    ? rollback
    : null;
}

/**
 * The derivation pass's memo key for a marker (the empty string for none)
 * — the key the engine and chain page diff their previous run against.
 */
export function rollbackMarkerKey(
  rollback: FeatureRollbackPoint | null,
): string {
  return rollback === null ? "" : `after:${String(rollback.afterFeatureId)}`;
}
