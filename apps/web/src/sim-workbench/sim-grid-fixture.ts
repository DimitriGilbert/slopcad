/**
 * The `/workbench-sim` fixture's pure pipeline (ROADMAP-SIM Phase 62c):
 * the demo document (the cad-jsx model `@slopcad/docs-examples`'s
 * `cadjsx/sim-demo-body` compiles to), the voxelization fixture data
 * (an EXPLICIT domain and resolution presets, law S3), and the
 * committed-application bridge that publishes each grid as a chunk
 * stream through the Phase 61d ledger
 * (`../cad-workbench/sim-application-ledger`) — overlay application IS
 * committed application: the decoded field the overlays render mounts
 * only from chunks the ledger actually APPLIED, and the `data-sim-*`
 * counters advance on exactly those commits.
 *
 * Everything here is pure and deterministic — no Date, no random, no
 * network — so the same (tessellation, controls) always produces the
 * same grid, the same chunk streams, and the same overlay state (the
 * byte-determinism law the render baselines pin).
 */

import {
  createDocument,
  createDocumentId,
  createSession,
  applySessionTransaction,
  type CadDocument,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";
import { compileModel } from "@slopcad/cad-jsx";
import {
  simGridToFieldBlock,
  simSignedDistanceGrid,
  splitSimFieldBlock,
  voxelizeSimTessellation,
  type SimEngineFieldChunk,
  type SimError,
  type SimResultFieldBlock,
  type SimVoxelGrid,
} from "@slopcad/sim-core";
import {
  CAD_FIELD_COLORMAP_VIRIDIS,
  decodedFieldGrid,
  type DecodedFieldGrid,
  type FieldColormap,
} from "@slopcad/cad-r3f";
import {
  SimDemoBodyModel,
  SIM_DEMO_BODY_PLATE,
} from "@slopcad/docs-examples/cadjsx/sim-demo-body";

import {
  applySimNotification,
  type SimAppliedCounters,
  type SimApplicationLedger,
  SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE,
  SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE,
  SIM_APPLIED_OPTIMIZATION_GENERATION_ATTRIBUTE,
  SIM_APPLIED_PROGRESS_STEP_ATTRIBUTE,
} from "../cad-workbench/sim-application-ledger";

// ---------------------------------------------------------------------------
// The demo document
// ---------------------------------------------------------------------------

/**
 * The demo document: the cad-jsx model compiled to its command
 * transaction and folded over a fresh document through the session's
 * single commit path — the exact fold `compileToNative` performs (the
 * loader precedent), minus the native serialization the fixture does
 * not need. Pure and memoized: the walk is deterministic, so every
 * caller sees the one document.
 */
export function simDemoDocument(): CadDocument {
  const compiled = compileModel(SimDemoBodyModel());
  if (!compiled.ok) {
    throw new Error(
      `The sim demo body model failed to compile: ${compiled.error.code}: ${compiled.error.message}`,
    );
  }
  const applied = applySessionTransaction(
    createSession(createDocument(createDocumentId("doc_workbench_sim"))),
    compiled.value,
  );
  if (!applied.ok) {
    throw new Error(
      `The sim demo body transaction did not apply to a fresh document: ${applied.error.message}`,
    );
  }
  return applied.value.document;
}

// ---------------------------------------------------------------------------
// Fixture data: the explicit domain and the resolution presets
// ---------------------------------------------------------------------------

/**
 * The fixture's explicit voxelization domain, canonical mm: the demo
 * plate (80×48×6 centred on the origin, z ∈ [0, 6]) padded by 10 mm in
 * x/y and 6 mm in z — the "tunnel around the part" shape the Phase 63
 * flow scenarios inherit. Fixture DATA (the page's controls select
 * among authored presets; nothing is free-form).
 */
export const SIM_FIXTURE_DOMAIN = {
  minMm: [SIM_DEMO_BODY_PLATE.xMin - 10, SIM_DEMO_BODY_PLATE.yMin - 10, -6],
  maxMm: [
    SIM_DEMO_BODY_PLATE.xMax + 10,
    SIM_DEMO_BODY_PLATE.yMax + 10,
    SIM_DEMO_BODY_PLATE.thickness + 6,
  ],
} as const;

/** One resolution preset the page's control selects among. */
export interface SimFixtureResolution {
  readonly id: "fine" | "coarse";
  readonly label: string;
  readonly resolutionMm: number;
}

/** The authored resolution presets, in selector order (fine default). */
export const SIM_FIXTURE_RESOLUTIONS: readonly SimFixtureResolution[] = [
  { id: "fine", label: "2 mm", resolutionMm: 2 },
  { id: "coarse", label: "4 mm", resolutionMm: 4 },
];

/** The grid name every fixture grid carries (the field id's prefix). */
export const SIM_FIXTURE_GRID_NAME = "sim-demo";

/**
 * The chunk count every published round splits into — the emitter-side
 * twin of the reassembly law: each grid arrives as this many chunks,
 * and a round completes when all of them applied.
 */
export const SIM_FIXTURE_CHUNKS_PER_ROUND = 8;

/**
 * The fine preset's resolved node shape (51 × 35 × 10 over the explicit
 * domain at 2 mm) — the exact boot application's grid, pinned for e2e.
 */
export const SIM_FIXTURE_FINE_SHAPE: readonly [number, number, number] = [
  51, 35, 10,
];

/**
 * The coarse preset's resolved node shape (26 × 18 × 5 at 4 mm) — the
 * resolution-switch assertion's target.
 */
export const SIM_FIXTURE_COARSE_SHAPE: readonly [number, number, number] = [
  26, 18, 5,
];

// ---------------------------------------------------------------------------
// The voxelization door
// ---------------------------------------------------------------------------

/** The page's fixture controls: a resolution preset and the SDF flag. */
export interface SimFixtureControls {
  readonly resolutionId: SimFixtureResolution["id"];
  /** Whether the applied field is the signed distance (occupancy otherwise). */
  readonly signedDistance: boolean;
}

/** The boot controls: the fine preset, occupancy. */
export const SIM_FIXTURE_BOOT_CONTROLS: SimFixtureControls = {
  resolutionId: "fine",
  signedDistance: false,
};

/** The applied semantic the controls select. */
export function simFixtureSemanticOf(
  controls: SimFixtureControls,
): "occupancy" | "signed-distance" {
  return controls.signedDistance ? "signed-distance" : "occupancy";
}

/** The resolution preset a control id names (the fine default). */
export function simFixtureResolutionOf(
  id: SimFixtureResolution["id"],
): SimFixtureResolution {
  const preset = SIM_FIXTURE_RESOLUTIONS.find(
    (candidate) => candidate.id === id,
  );
  if (preset !== undefined) return preset;
  return SIM_FIXTURE_RESOLUTIONS[0] as SimFixtureResolution;
}

/**
 * The node counts the explicit domain resolves to at a resolution —
 * `floor((max − min)/h) + 1` per axis (nodes never pass the max
 * corner), the voxelizer's own shape rule restated for the tests.
 */
export function simFixtureShapeAt(
  resolutionMm: number,
): readonly [number, number, number] {
  const shape: [number, number, number] = [1, 1, 1];
  for (let axis = 0; axis < 3; axis += 1) {
    const extent =
      (SIM_FIXTURE_DOMAIN.maxMm[axis] ?? 0) -
      (SIM_FIXTURE_DOMAIN.minMm[axis] ?? 0);
    shape[axis] = Math.floor(extent / resolutionMm) + 1;
  }
  return shape;
}

/** A voxelized fixture grid ready to publish: the grid and its block. */
export interface SimFixtureField {
  readonly semantic: "occupancy" | "signed-distance";
  readonly grid: SimVoxelGrid;
  /** The document-space field block (through the S4 projection). */
  readonly block: SimResultFieldBlock;
}

/** The structured outcome of the voxelization door (the error verbatim). */
export type SimFixtureFieldResult =
  | { readonly ok: true; readonly field: SimFixtureField }
  | { readonly ok: false; readonly error: SimError };

/**
 * Voxelizes the merged document tessellation under the fixture's
 * explicit domain at the selected resolution — the occupancy grid, or
 * the signed-distance field when the SDF flag is set (the optional
 * consumer choice `simSignedDistanceGrid` documents). Declines
 * structured on any door refusal; the page surfaces the code verbatim.
 */
export function buildSimFixtureField(
  tessellation: Tessellation,
  controls: SimFixtureControls,
): SimFixtureFieldResult {
  const domain = {
    kind: "explicit",
    minMm: SIM_FIXTURE_DOMAIN.minMm,
    maxMm: SIM_FIXTURE_DOMAIN.maxMm,
    resolutionMm: simFixtureResolutionOf(controls.resolutionId).resolutionMm,
  };
  const occupancy = voxelizeSimTessellation({
    tessellation,
    domain,
    name: SIM_FIXTURE_GRID_NAME,
  });
  if (!occupancy.ok) return occupancy;
  if (!controls.signedDistance) {
    const block = simGridToFieldBlock(occupancy.value);
    if (!block.ok) return block;
    return {
      ok: true,
      field: {
        semantic: "occupancy",
        grid: occupancy.value,
        block: block.value,
      },
    };
  }
  const distance = simSignedDistanceGrid({
    tessellation,
    occupancy: occupancy.value,
  });
  if (!distance.ok) return distance;
  const block = simGridToFieldBlock(distance.value);
  if (!block.ok) return block;
  return {
    ok: true,
    field: {
      semantic: "signed-distance",
      grid: distance.value,
      block: block.value,
    },
  };
}

// ---------------------------------------------------------------------------
// The committed-application bridge (law S6 — overlay application IS
// committed application)
// ---------------------------------------------------------------------------

/** The deterministic chunk stream one published field splits into. */
export function simFixtureChunkStream(
  block: SimResultFieldBlock,
): readonly SimEngineFieldChunk[] {
  return splitSimFieldBlock(block, SIM_FIXTURE_CHUNKS_PER_ROUND);
}

/**
 * Publishes one field as a chunk stream and applies every chunk through
 * the Phase 61d ledger: the deterministic emitter (the reassembly law's
 * own twin) feeds the SAME `applySimNotification` door the workbench
 * engine's sim client notifications ride. Returns the committed
 * counters after the LAST application, or `null` when nothing applied
 * (a framing decline — the caller keeps the previous overlay state and
 * moves no counter).
 */
export function applySimFixtureField(
  ledger: SimApplicationLedger,
  field: SimFixtureField,
): SimAppliedCounters | null {
  let last: SimAppliedCounters | null = null;
  for (const chunk of simFixtureChunkStream(field.block)) {
    // The tagged notification form the worker client's decode hands the
    // engine — the ledger's own consumption vocabulary.
    const committed = applySimNotification(ledger, {
      ...chunk,
      kind: "field-chunk",
    });
    if (committed !== null) last = committed;
  }
  return last;
}

/**
 * Stamps the committed counters onto the settle root — the workbench
 * engine's exact synchronous discipline (`workbench-engine.tsx`'s
 * `noteSimApplication`): every attribute the ledger family defines,
 * written at the moment the application committed.
 */
export function stampSimAppliedCounters(
  rootId: string,
  counters: SimAppliedCounters,
): void {
  const root = document.getElementById(rootId);
  if (root === null) return;
  root.setAttribute(
    SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE,
    String(counters.notifications),
  );
  root.setAttribute(
    SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE,
    String(counters.fieldChunks),
  );
  if (counters.progressStep !== null) {
    root.setAttribute(
      SIM_APPLIED_PROGRESS_STEP_ATTRIBUTE,
      String(counters.progressStep),
    );
  }
  if (counters.optimizationGeneration !== null) {
    root.setAttribute(
      SIM_APPLIED_OPTIMIZATION_GENERATION_ATTRIBUTE,
      String(counters.optimizationGeneration),
    );
  }
}

// ---------------------------------------------------------------------------
// The applied overlay state (what the 62b family renders)
// ---------------------------------------------------------------------------

/** The applied overlay: the decoded field plus its authored paint. */
export interface SimFixtureOverlay {
  readonly semantic: "occupancy" | "signed-distance";
  readonly field: DecodedFieldGrid;
  /** The slice plane's normal axis. */
  readonly sliceAxis: "x" | "y" | "z";
  /** The slice plane's document-space position, mm (a grid node plane). */
  readonly slicePositionMm: number;
  /** The iso-contour thresholds, in emission order. */
  readonly thresholds: readonly number[];
  /** The colormap (identity-stable module data — the palette expectation). */
  readonly colormap: FieldColormap;
  /** The value window, or `undefined` for the field's own range. */
  readonly valueRange: readonly [number, number] | undefined;
}

/** The occupancy paint: the 0.5 iso-level over the honest [0, 1] window. */
const OCCUPANCY_THRESHOLDS: readonly number[] = Object.freeze([0.5]);
/** The SDF paint: iso-levels at −2 mm, the surface (0), and +2 mm. */
const DISTANCE_THRESHOLDS: readonly number[] = Object.freeze([-2, 0, 2]);
const OCCUPANCY_VALUE_RANGE: readonly [number, number] = Object.freeze([0, 1]);

/**
 * Derives the overlay the applied field paints: the decoded render-side
 * lattice (`decodedFieldGrid`, the 62b door), the mid-height node plane
 * of the grid's own z lattice as the slice (deterministic in the grid —
 * the same grid always slices the same plane), and the semantic's
 * authored thresholds and value window.
 */
export function simFixtureOverlayOf(field: SimFixtureField): SimFixtureOverlay {
  const decoded = decodedFieldGrid(field.block);
  const zIndex = Math.floor((decoded.shape[2] - 1) / 2);
  return {
    semantic: field.semantic,
    field: decoded,
    sliceAxis: "z",
    slicePositionMm:
      (decoded.originMm[2] ?? 0) + zIndex * (decoded.spacingMm[2] ?? 1),
    thresholds:
      field.semantic === "occupancy"
        ? OCCUPANCY_THRESHOLDS
        : DISTANCE_THRESHOLDS,
    colormap: CAD_FIELD_COLORMAP_VIRIDIS,
    valueRange:
      field.semantic === "occupancy" ? OCCUPANCY_VALUE_RANGE : undefined,
  };
}

/**
 * The occupied node count of an occupancy grid — the readout the page
 * shows beside the grid shape, and the assertion target proving the
 * part is IN the grid (strictly between zero and the lattice total).
 * `null` for the distance field (it has no occupied set).
 */
export function simFixtureOccupiedNodes(grid: SimVoxelGrid): number | null {
  if (grid.semantic !== "occupancy") return null;
  let occupied = 0;
  for (const cell of grid.cells) occupied += cell;
  return occupied;
}
