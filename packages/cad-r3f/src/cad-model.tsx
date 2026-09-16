/**
 * `CadModel` — the Phase 11.2 R3F model renderer. Consumes the public
 * {@link RenderProjection} from `@slopcad/cad-core` as data and renders one
 * keyed `<mesh>` per render object into whatever R3F canvas it is mounted
 * in. It never imports kernel or worker modules (the import allowlist is
 * enforced by a structural test), adds no camera, no lights, and no
 * framing of its own — the deterministic scene around it is Phase 11.3 —
 * and holds no randomness or clock-dependent state, so the same projection
 * always produces the same scene graph.
 *
 * ## Update semantics
 *
 * Geometry creation, same-id in-place buffer updates, and disposal are
 * delegated to {@link useRenderGeometry}. Meshes are keyed by the stable
 * render object id, so R3F instance identity follows body identity: an
 * updated body swaps buffer contents in place, a removed body unmounts,
 * and unrelated bodies are left untouched.
 *
 * ## Material
 *
 * One documented default — `MeshStandardMaterial` with the spike's fixed
 * parameters (color `#8aadf4`, metalness 0.15, roughness 0.55) — applied
 * per mesh. The `material` prop overrides individual parameters; anything
 * beyond these three parameters needs a renderer decision, not a prop
 * escape hatch, so the override surface is deliberately narrow.
 *
 * Geometry data materializes in the commit after mount (standard effect
 * timing); demand-framed scenes should invalidate on the {@link onSync}
 * callback, which reports each changed snapshot exactly once.
 */

import type { ThreeElements } from "@react-three/fiber";
import type { ReactElement } from "react";
import type { RenderProjection } from "@slopcad/cad-core";
import type { RenderGeometrySnapshot } from "./geometry";

import { useRenderGeometry } from "./use-render-geometry";

/** The overridable subset of the default material. */
export type CadModelMaterialProps = Pick<
  ThreeElements["meshStandardMaterial"],
  "color" | "metalness" | "roughness"
>;

/**
 * The documented default material: the deterministic parameters from the
 * Phase 1.6 architecture spike scene, applied identically to every mesh.
 */
const DEFAULT_MATERIAL: CadModelMaterialProps = {
  color: "#8aadf4",
  metalness: 0.15,
  roughness: 0.55,
};

export interface CadModelProps {
  /** The validated render projection (see `@slopcad/cad-core`). */
  readonly projection: RenderProjection;
  /** Per-parameter overrides applied over {@link DEFAULT_MATERIAL}. */
  readonly material?: CadModelMaterialProps;
  /** Reports each changed geometry snapshot exactly once, post-commit. */
  readonly onSync?: (geometries: RenderGeometrySnapshot) => void;
}

export function CadModel({
  material,
  onSync,
  projection,
}: CadModelProps): ReactElement {
  const geometries = useRenderGeometry(projection, onSync);
  const materialProps: CadModelMaterialProps = {
    ...DEFAULT_MATERIAL,
    ...material,
  };
  return (
    <>
      {[...geometries].map(([id, geometry]) => (
        <mesh key={id} geometry={geometry}>
          <meshStandardMaterial {...materialProps} />
        </mesh>
      ))}
    </>
  );
}
