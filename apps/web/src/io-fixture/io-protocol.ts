/**
 * Wire contract of the /io fixture's 3MF import endpoint
 * (`/api/io/import-3mf`), shared by the server route and the page so the
 * payload has ONE source of truth.
 *
 * Why the endpoint exists: the Phase 18.4 `importThreeMf` adapter is
 * Node-targeted (it inflates deflate ZIP entries through `node:zlib`; see
 * the cad-io module header's documented browser constraint). The /io
 * fixture therefore imports 3MF through the app's own server — the same
 * production server the page is served from — while STL import (pure JS)
 * runs fully in the browser. The mesh crosses back as plain JSON: f64
 * positions are lossless in JSON text, so the projected geometry is
 * bit-identical to the server-parsed soup.
 */

import type { ThreeMfMetadata, ThreeMfUnit } from "@slopcad/cad-io";

/** The successful import response: the parsed soup plus its 3MF facts. */
export interface ThreeMfImportSuccess {
  readonly ok: true;
  /** The ST_Unit the model declared (geometry is canonical millimetres). */
  readonly units: ThreeMfUnit;
  /** Preserved well-known metadata; absent fields are absent keys. */
  readonly metadata: ThreeMfMetadata;
  /** The mesh's flat xyz positions, canonical millimetres. */
  readonly positions: number[];
  /** The mesh's flat triangle indices. */
  readonly indices: number[];
}

/** The structured rejection, verbatim from the cad-io failure discipline. */
export interface ThreeMfImportFailure {
  readonly ok: false;
  /** The stable `three-mf-import/<cause>` code. */
  readonly code: string;
  /** The human-readable rejection message. */
  readonly message: string;
}

/** Everything the endpoint returns. */
export type ThreeMfImportResponse =
  | ThreeMfImportSuccess
  | ThreeMfImportFailure;
