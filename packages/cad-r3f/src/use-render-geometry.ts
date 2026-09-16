/**
 * React binding for the render geometry controller: owns one controller per
 * mounted renderer, applies the projection in an effect, and reports the
 * id-keyed geometry snapshot as state. React-free diff, disposal, and
 * quantization semantics live in `./geometry`; this hook adds only the
 * React lifecycle:
 *
 * - sync runs post-commit, so a projection change applies exactly once per
 *   commit — never during render — and content-diffing makes the effect
 *   safe under identity churn (an equal projection re-syncs as a no-op);
 * - disposal happens in the unmount cleanup only, never on projection
 *   changes, which is what lets same-id geometries update their buffers in
 *   place across updates;
 * - the cleanup disposes and a later sync rebuilds, so React StrictMode's
 *   mount → cleanup → mount simulation resurrects the full geometry set
 *   instead of leaving a wiped controller;
 * - `onSync` is reported through a latest-ref so callers may pass inline
 *   closures (e.g. triggering a demand-frame invalidate) without changing
 *   effect identity, and it fires only when the snapshot instance changed.
 */

import { useEffect, useRef, useState } from "react";
import type { RenderProjection } from "@slopcad/cad-core";

import {
  createRenderGeometryController,
  type RenderGeometryController,
  type RenderGeometrySnapshot,
} from "./geometry";

const EMPTY_GEOMETRIES: RenderGeometrySnapshot = new Map();

function useRenderGeometryController(): RenderGeometryController {
  const ref = useRef<RenderGeometryController | null>(null);
  if (ref.current === null) {
    ref.current = createRenderGeometryController();
  }
  return ref.current;
}

export function useRenderGeometry(
  projection: RenderProjection,
  onSync?: (geometries: RenderGeometrySnapshot) => void,
): RenderGeometrySnapshot {
  const controller = useRenderGeometryController();
  const [geometries, setGeometries] =
    useState<RenderGeometrySnapshot>(EMPTY_GEOMETRIES);
  const onSyncRef = useRef(onSync);
  const reportedRef = useRef<RenderGeometrySnapshot | undefined>(undefined);

  useEffect(() => {
    onSyncRef.current = onSync;
  });

  useEffect(() => {
    const next = controller.sync(projection);
    setGeometries(next);
    if (next !== reportedRef.current) {
      reportedRef.current = next;
      onSyncRef.current?.(next);
    }
  }, [controller, projection]);

  useEffect(() => () => controller.dispose(), [controller]);

  return geometries;
}
