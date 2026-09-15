/**
 * Phase 1.6 architecture spike — NON-PRODUCTION reference code.
 * Contracts for the worker transport boundary. See docs/architecture/spike-findings.md.
 */

/**
 * A triangle soup flat enough for a GPU buffer: interleaved vertex properties
 * plus a triangle index buffer. Channels 0–2 of each vertex are xyz positions;
 * when `numProp` ≥ 6, channels 3–5 carry the kernel's unit normals
 * (Manifold.calculateNormals, sharp edges split into separate vertices).
 * `numProp` keeps the buffer layout compatible with further Manifold vertex
 * properties later (UVs).
 */
export interface CadMeshPayload {
  readonly numProp: number;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface CadEvalResult {
  readonly mesh: CadMeshPayload;
  readonly volume: number;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
  readonly triangleCount: number;
  readonly vertexCount: number;
}

export type CadRequest = {
  readonly id: number;
  readonly kind: "evaluate";
  readonly parameters: Readonly<Record<string, number>>;
};

export type CadResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: CadEvalResult;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };
