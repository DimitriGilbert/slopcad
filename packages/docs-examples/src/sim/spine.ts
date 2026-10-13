/**
 * The `simulation` guide's runnable example (docs/guides/simulation.md):
 * the Phase 61 spine walk-through — author a scenario record, compute its
 * scenario-snapshot hash, compile it through the units/S9 boundary (the
 * regime numbers), pin the `structural` kind's live compile (the empty
 * regime report — Phase 69), encode and decode a {@link SimResult}
 * payload, and export the CSV/.vti bytes every run ships with. The example is the spine ONLY: no solver
 * runs here (the deterministic fake engine exercises the worker protocol
 * in `@slopcad/sim-core`'s own suite; the first real solver is Phase 63's
 * flow kernel).
 */

import {
  compileSimScenario,
  decodeSimResultPayload,
  encodeSimResultPayload,
  exportSimFieldVti,
  exportSimHistoryCsv,
  SIM_RESULT_SUMMARY_VERSION,
  simScenarioSnapshotHash,
  type SimResult,
  type SimResultFieldBlock,
} from "@slopcad/sim-core";

/** What the example reports back to the guide and the docs page. */
export interface SimSpineExampleSummary {
  /** The scenario record's snapshot hash (8 hex digits, djb2 — stable, not cryptographic). */
  readonly snapshotHash: string;
  /** The identical scenario with reordered keys hashes identically. */
  readonly reorderedSnapshotHash: string;
  /** Any authored change to the record changes the hash. */
  readonly editedSnapshotHash: string;
  /** The compiled domain's min corner, metres (−500 mm → −0.5). */
  readonly domainMinM: readonly [number, number, number];
  /** The compiled cell size, metres (2 mm → 0.002). */
  readonly cellSizeM: number;
  /** The characteristic length the regime numbers form with, m. */
  readonly characteristicLengthM: number;
  /** S9: Re = ρ·V·L/μ at the inlet speed. */
  readonly reynolds: number;
  /** S9: Ma = V/c. */
  readonly mach: number;
  /** S9: Pr = μ·cp/k. */
  readonly prandtl: number;
  /** The advisory honesty flags the numbers raise. */
  readonly qualitative: readonly string[];
  /** The compile stamps the record's snapshot hash into the compiled form. */
  readonly compiledSnapshotHash: string;
  /** The structural kind compiles with the empty regime report (Phase 69 live). */
  readonly structuralRegimeEmpty: boolean;
  /** The `SMR1` payload's byte length. */
  readonly payloadBytes: number;
  /** The decoded payload reproduces the authored block exactly. */
  readonly decodedRoundTrip: boolean;
  /** The `.vti` export's byte length. */
  readonly vtiBytes: number;
  /** The `.vti` export declares a VTK XML ImageData whole extent. */
  readonly vtiIsImageData: boolean;
  /** The history CSV's row count (header + samples). */
  readonly csvRows: number;
  /** The history CSV's header (the quoting-free dialect). */
  readonly csvHeader: string;
}

/** Unwraps a parse result or throws with its message (a guide example fails loud). */
function unwrap<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The simulation spine example rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** A serialized flow scenario over an explicit 1000×500×500 mm domain. */
function windTunnelScenario(): Record<string, unknown> {
  return {
    id: "sim_000001",
    name: "Wind tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [-500, -250, -250],
      max: [500, 250, 250],
      resolutionMm: 2,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 10,
        direction: [1, 0, 0],
      },
      { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
      { kind: "wall", face: "yMin", slip: false },
      { kind: "symmetry", face: "yMax" },
    ],
    fluid: "air",
    materials: [],
    gravityMPerS2: [0, -9.80665, 0],
  };
}

/** The example's one field block: a 2×2×2 sample velocity-magnitude grid. */
function velocityBlock(): SimResultFieldBlock {
  return {
    id: "velocity-magnitude",
    unit: "mm/s",
    extent: [2, 2, 2],
    originMm: [-500, -250, -250],
    spacingMm: [500, 500, 500],
    dataType: "float32",
    values: [0, 2500, 5000, 7500, 10000, 7500, 5000, 2500],
  };
}

/** The facts the simulation guide states, computed by the real API. */
export function runSimSpineExample(): SimSpineExampleSummary {
  const scenario = windTunnelScenario();

  // Provenance first: the scenario-snapshot hash is a content hash of the
  // record AT RUN TIME over a canonical (key-sorted) JSON rendering —
  // identical content hashes identically regardless of key order, any
  // authored change moves it.
  const snapshotHash = unwrap(
    simScenarioSnapshotHash(scenario),
    "the snapshot hash",
  );
  const reorderedSnapshotHash = unwrap(
    simScenarioSnapshotHash({
      fluid: scenario.fluid,
      name: scenario.name,
      kind: scenario.kind,
      id: scenario.id,
      gravityMPerS2: scenario.gravityMPerS2,
      materials: scenario.materials,
      conditions: scenario.conditions,
      domain: scenario.domain,
    }),
    "the reordered snapshot hash",
  );
  const editedSnapshotHash = unwrap(
    simScenarioSnapshotHash({
      ...scenario,
      conditions: [
        ...(scenario.conditions as unknown[]),
        { kind: "wall", face: "zMin", slip: false },
      ],
    }),
    "the edited snapshot hash",
  );

  // The S4/S9 compile boundary: document millimetres become solver SI,
  // the fluid evaluates at its record's reference temperature, and the
  // regime numbers are computed here — once, at compile time.
  const compiled = unwrap(
    compileSimScenario({ scenario }),
    "the scenario compile",
  );
  // Phase 69 flipped the carve live: the structural kind compiles like
  // every other, and its law-S9 claim is the EMPTY regime report (none
  // of the flow/thermal dimensionless gates applies to a linear-elastic
  // static solve — the dynamics precedent).
  const structural = compileSimScenario({
    scenario: { ...scenario, kind: "structural" },
  });
  const structuralCompiled = unwrap(structural, "the structural kind compile");
  if (structuralCompiled.regime.qualitative.length !== 0) {
    throw new Error(
      "The structural compile must carry the empty regime report — its honesty claim.",
    );
  }

  // A result in its persisted form: the summary carries the compiled
  // regime and the scenario-snapshot hash; the field blocks and histories
  // ride the deterministic binary payload and the exporters.
  const result: SimResult = {
    summary: {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
      status: "completed",
      regime: compiled.regime,
      quantities: [{ name: "drag-force", value: 1.25, unit: "N" }],
    },
    fields: [velocityBlock()],
    histories: [
      { name: "drag", unit: "N", samples: [0.25, 0.5, 0.75, 1, 1.25] },
    ],
  };
  const payload = unwrap(
    encodeSimResultPayload(result.fields),
    "the result payload encode",
  );
  const decoded = unwrap(
    decodeSimResultPayload(payload),
    "the result payload decode",
  );
  const authored = result.fields[0];
  const decodedBlock = decoded[0];
  const decodedRoundTrip =
    decoded.length === result.fields.length &&
    decodedBlock !== undefined &&
    authored !== undefined &&
    decodedBlock.id === authored.id &&
    decodedBlock.unit === authored.unit &&
    decodedBlock.dataType === authored.dataType &&
    decodedBlock.extent.every(
      (value, axis) => value === authored.extent[axis],
    ) &&
    decodedBlock.originMm.every(
      (value, axis) => value === authored.originMm[axis],
    ) &&
    decodedBlock.spacingMm.every(
      (value, axis) => value === authored.spacingMm[axis],
    ) &&
    decodedBlock.values.every(
      (value, index) => value === authored.values[index],
    );

  // Law S7's deterministic exports: ParaView-readable .vti for grids, CSV
  // for histories — identical inputs, identical bytes.
  const exportedBlock = result.fields[0];
  if (exportedBlock === undefined) {
    throw new Error("The example's field block is absent.");
  }
  const vti = unwrap(exportSimFieldVti(exportedBlock), "the .vti export");
  const csv = unwrap(
    exportSimHistoryCsv({ columns: result.histories }),
    "the history CSV export",
  );
  const csvRows = csv.split("\n").filter((line) => line.length > 0).length;

  return {
    snapshotHash,
    reorderedSnapshotHash,
    editedSnapshotHash,
    domainMinM: compiled.domainMinM,
    cellSizeM: compiled.cellSizeM,
    characteristicLengthM: compiled.characteristicLengthM,
    reynolds: compiled.regime.reynolds ?? NaN,
    mach: compiled.regime.mach ?? NaN,
    prandtl: compiled.regime.prandtl ?? NaN,
    qualitative: compiled.regime.qualitative,
    compiledSnapshotHash: compiled.scenarioSnapshotHash,
    structuralRegimeEmpty: structuralCompiled.regime.qualitative.length === 0,
    payloadBytes: payload.length,
    decodedRoundTrip,
    vtiBytes: vti.length,
    vtiIsImageData:
      vti.startsWith("<?xml") &&
      vti.includes("<VTKFile") &&
      vti.includes('type="ImageData"'),
    csvRows,
    csvHeader: csv.split("\n")[0] ?? "",
  };
}
