// @vitest-environment node

/**
 * The Phase 2.2 assembly WebMCP tools (PLAN-AGENT-CHAT D11): the
 * occurrence/pattern/mate/joint doors and the interference/clearance
 * report, driven through the registry boundary against REAL cad-core
 * documents — the same doors the assembly pages' own buttons use. The
 * page seams (commit setter, interference geometry) are the surface;
 * no DOM, no WebGL, no React.
 *
 * Also pins the phase-wide output-shape constraint: the tools' RESULT field
 * names never contain apiKey-like fragments (the relay's D1 deep-scan
 * constraint).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentReference,
  addMate,
  addOccurrence,
  createBodyId,
  createDocument,
  createDocumentId,
  createOccurrenceId,
  createReferenceId,
  type BodyId,
  type CadDocument,
  type ClearanceMesh,
  type PlacementTransform,
} from "@slopcad/cad-core";

import {
  createAssemblyWebMcpTools,
  INTERFERENCE_TOLERANCE_MM3,
  type AssemblyInterferenceSeams,
  type AssemblyWebMcpSurface,
} from "./assembly-tools";
import {
  executeWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
  webMcpToolSnapshot,
} from "./registry";
import { bindWebMcpTools } from "./use-webmcp-tools";

/** The structured outcome of driving one tool through the registry. */
type ToolRun =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The ten assembly tools of a mutable surface, in mint order. */
const MUTABLE_TOOL_NAMES = [
  "cad_get_document",
  "cad_get_diagnostics",
  "cad_assembly_add_occurrence",
  "cad_assembly_remove_occurrence",
  "cad_assembly_pattern",
  "cad_assembly_add_mate",
  "cad_assembly_remove_mate",
  "cad_assembly_add_joint",
  "cad_assembly_remove_joint",
  "cad_assembly_check_interference",
] as const;

/** The three tools of a read-only surface, in mint order. */
const READONLY_TOOL_NAMES = [
  "cad_get_document",
  "cad_get_diagnostics",
  "cad_assembly_check_interference",
] as const;

/** The apiKey-like fragments no output field name may contain (D1). */
const FORBIDDEN_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "credential",
  "key",
] as const;

/**
 * Recursively asserts no field name in the payload carries an apiKey-like
 * fragment (the relay's D1 deep-scan constraint, pinned per tool).
 */
function expectNoApiKeyLikeFieldNames(payload: unknown): void {
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [fieldName, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const normalized = fieldName.toLowerCase();
        for (const fragment of FORBIDDEN_FRAGMENTS) {
          expect(
            normalized.includes(fragment),
            `field "${fieldName}" must not contain "${fragment}"`,
          ).toBe(false);
        }
        scan(entry);
      }
    }
  };
  scan(payload);
}

/** The probe plate body every fixture document shares. */
const PLATE_BODY = createBodyId("body_agent_plate");

/** The plate's local-space box extents (mm) — the seams' geometry. */
const PLATE_BOUNDS = {
  max: [60, 40, 12] as [number, number, number],
  min: [0, 0, 0] as [number, number, number],
};

/** A one-triangle clearance mesh (the batch only needs a valid soup). */
const PLATE_MESH: ClearanceMesh = {
  indices: [0, 1, 2],
  positions: [0, 0, 0, 60, 0, 0, 60, 40, 0],
};

/** The analytic axis-aligned box kernel (the Phase 58 fixture's own rule). */
function boxIntersectionVolume(
  a: { readonly bodyId: BodyId; readonly transform: PlacementTransform },
  b: { readonly bodyId: BodyId; readonly transform: PlacementTransform },
): number | null {
  const [ax, ay, az] = a.transform.translation;
  const [bx, by, bz] = b.transform.translation;
  const [aMinX, aMinY, aMinZ] = PLATE_BOUNDS.min;
  const [aMaxX, aMaxY, aMaxZ] = PLATE_BOUNDS.max;
  const [bMinX, bMinY, bMinZ] = PLATE_BOUNDS.min;
  const [bMaxX, bMaxY, bMaxZ] = PLATE_BOUNDS.max;
  const overlapX =
    Math.min(aMaxX + ax, bMaxX + bx) - Math.max(aMinX + ax, bMinX + bx);
  const overlapY =
    Math.min(aMaxY + ay, bMaxY + by) - Math.max(aMinY + ay, bMinY + by);
  const overlapZ =
    Math.min(aMaxZ + az, bMaxZ + bz) - Math.max(aMinZ + az, bMinZ + bz);
  if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return 0;
  return overlapX * overlapY * overlapZ;
}

/** The interference seams over the probe plate. */
function plateSeams(): AssemblyInterferenceSeams {
  return {
    boundsOf: () => PLATE_BOUNDS,
    intersectVolume: boxIntersectionVolume,
    meshOf: () => PLATE_MESH,
  };
}

/** Builds the probe document: the plate body + one identity seed occurrence. */
function buildSeedDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_agent_assembly"));
  const body = addBody(document, { id: PLATE_BODY, name: "plate" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const seed = addOccurrence(document, {
    id: createOccurrenceId("occ_agent_seed"),
    name: "plate seed",
    source: { bodyId: PLATE_BODY, kind: "body" },
  });
  if (!seed.ok) throw new Error(seed.error.message);
  return seed.value.document;
}

/**
 * The mutable harness: the document cell the commit door writes and the
 * tools read — the page's useState pairing, in plain node form. Tests read
 * `cell.document` LIVE (it is the same object the commit mutates).
 */
function mutableHarness(options?: {
  readonly document?: CadDocument;
  readonly interference?: AssemblyInterferenceSeams | null;
}): {
  readonly cell: { document: CadDocument };
  readonly unbind: () => void;
} {
  const cell = { document: options?.document ?? buildSeedDocument() };
  const surface: AssemblyWebMcpSurface = {
    commit: (next) => {
      cell.document = next;
    },
    document: () => cell.document,
    interference: options?.interference ?? null,
    resolveDocument: null,
  };
  return { cell, unbind: bindWebMcpTools(createAssemblyWebMcpTools(surface)) };
}

/** Binds a read-only surface over one immutable document. */
function readonlyHarness(document: CadDocument): {
  readonly document: CadDocument;
  readonly unbind: () => void;
} {
  const unbind = bindWebMcpTools(
    createAssemblyWebMcpTools({
      commit: null,
      document: () => document,
      interference: plateSeams(),
      resolveDocument: null,
    }),
  );
  return { document, unbind };
}

/**
 * Drives one tool with raw JSON input through the registry boundary,
 * decoding the tool's own refusals the way the agent loop does.
 */
async function runTool(name: string, input: unknown): Promise<ToolRun> {
  const outcome = await executeWebMcpTool(name, input, {
    signal: new AbortController().signal,
  });
  if (!outcome.ok) {
    return { code: outcome.code, message: outcome.message, ok: false };
  }
  const payload: unknown = JSON.parse(outcome.result);
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { readonly ok?: unknown }).ok === false
  ) {
    const refusal = payload as {
      readonly code: string;
      readonly message: string;
    };
    return { code: refusal.code, message: refusal.message, ok: false };
  }
  return { ok: true, payload };
}

afterEach(() => {
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
});

describe("the tool set", () => {
  it("mints all ten tools on a mutable surface, in mint order", () => {
    const harness = mutableHarness();
    expect(webMcpToolNames()).toEqual([...MUTABLE_TOOL_NAMES]);
    harness.unbind();
    expect(webMcpToolNames()).toEqual([]);
  });

  it("mints only the reads and the report on a read-only surface", () => {
    const harness = readonlyHarness(buildSeedDocument());
    expect(webMcpToolNames()).toEqual([...READONLY_TOOL_NAMES]);
    harness.unbind();
  });

  it("derives a JSON object schema for every tool", () => {
    const harness = mutableHarness();
    for (const tool of webMcpToolSnapshot()) {
      expect(
        (tool.inputSchema as { readonly type?: string }).type,
        tool.name,
      ).toBe("object");
    }
    harness.unbind();
  });
});

describe("cad_get_document (assembly)", () => {
  it("outlines the occurrence tree, mates, and joints compactly", async () => {
    let document = buildSeedDocument();
    const offset = addOccurrence(document, {
      bomFlag: "purchased",
      id: createOccurrenceId("occ_agent_offset"),
      name: "offset instance",
      placement: { kind: "offset", translation: [120, 0, 0] },
      source: { bodyId: PLATE_BODY, kind: "body" },
    });
    if (!offset.ok) throw new Error(offset.error.message);
    document = offset.value.document;
    const harness = mutableHarness({ document });

    const run = await runTool("cad_get_document", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    const payload = run.payload as {
      documentId: string;
      joints: unknown[];
      mates: unknown[];
      occurrences: {
        bomFlag: string;
        id: string;
        name: string;
        sourceKind: string;
        sourceName: string;
        translation: number[] | null;
      }[];
    };
    expect(payload.documentId).toBe("doc_agent_assembly");
    expect(payload.mates).toEqual([]);
    expect(payload.joints).toEqual([]);
    expect(payload.occurrences).toEqual([
      {
        bomFlag: "default",
        datumId: null,
        id: "occ_agent_seed",
        name: "plate seed",
        sourceKind: "body",
        sourceName: "plate",
        translation: null,
      },
      {
        bomFlag: "purchased",
        datumId: null,
        id: "occ_agent_offset",
        name: "offset instance",
        sourceKind: "body",
        sourceName: "plate",
        translation: [120, 0, 0],
      },
    ]);
    harness.unbind();
  });
});

describe("cad_assembly_add_occurrence / cad_assembly_remove_occurrence", () => {
  it("adds through the door (offset placement, generated id) and commits", async () => {
    const harness = mutableHarness();
    const run = await runTool("cad_assembly_add_occurrence", {
      name: "agent instance",
      source: { bodyId: String(PLATE_BODY), kind: "body" },
      translation: [80, 0, 0],
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    const payload = run.payload as {
      name: string;
      occurrenceCount: number;
      occurrenceId: string;
    };
    expect(payload.name).toBe("agent instance");
    expect(payload.occurrenceCount).toBe(2);
    expect(payload.occurrenceId).toMatch(/^occ_/);
    const added = harness.cell.document.occurrences.find(
      (occurrence) => String(occurrence.id) === payload.occurrenceId,
    );
    expect(added).toMatchObject({
      name: "agent instance",
      placement: { kind: "offset", translation: [80, 0, 0] },
    });
    harness.unbind();
  });

  it("refuses a body source the document does not carry, verbatim from the door", async () => {
    const harness = mutableHarness();
    const run = await runTool("cad_assembly_add_occurrence", {
      name: "ghost",
      source: { bodyId: "body_missing", kind: "body" },
    });
    expect(run).toMatchObject({
      code: "assembly/occurrence-source-unknown",
      ok: false,
    });
    expect(harness.cell.document.occurrences).toHaveLength(1);
    harness.unbind();
  });

  it("removes by id; unknown ids and mate-blocked removals refuse structurally", async () => {
    const harness = mutableHarness();
    const removed = await runTool("cad_assembly_remove_occurrence", {
      occurrenceId: "occ_agent_seed",
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expectNoApiKeyLikeFieldNames(removed.payload);
      expect(removed.payload).toMatchObject({
        occurrenceCount: 0,
        removed: "occ_agent_seed",
      });
    }
    expect(harness.cell.document.occurrences).toHaveLength(0);

    const unknown = await runTool("cad_assembly_remove_occurrence", {
      occurrenceId: "occ_agent_seed",
    });
    expect(unknown).toMatchObject({ code: "document/not-found", ok: false });
    harness.unbind();
  });
});

describe("cad_assembly_pattern", () => {
  it("stamps a linear pattern from the seed through the resolver + door", async () => {
    const harness = mutableHarness();
    const run = await runTool("cad_assembly_pattern", {
      kind: "linear",
      linear: { count: 2, direction: [1, 0, 0], spacingMm: 80 },
      seedOccurrenceId: "occ_agent_seed",
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    const payload = run.payload as {
      added: string[];
      occurrenceCount: number;
      patternKind: string;
    };
    expect(payload.patternKind).toBe("linear");
    expect(payload.added).toHaveLength(2);
    expect(payload.occurrenceCount).toBe(3);
    const stamped = payload.added.map((id) => {
      const occurrence = harness.cell.document.occurrences.find(
        (entry) => String(entry.id) === id,
      );
      return occurrence?.placement;
    });
    expect(stamped).toEqual([
      { kind: "offset", translation: [80, 0, 0] },
      { kind: "offset", translation: [160, 0, 0] },
    ]);
    harness.unbind();
  });

  it("stamps a circular pattern about a datum axis (translation records)", async () => {
    // Seed offset to [80, 0, 0]; a quarter turn about +z moves it to
    // [0, 80, 0], a half turn to [-80, 0, 0] — the rotation composes with
    // the placement, the record keeps the translation form.
    let document = buildSeedDocument();
    const moved = addOccurrence(document, {
      id: createOccurrenceId("occ_agent_at_80"),
      name: "at 80",
      placement: { kind: "offset", translation: [80, 0, 0] },
      source: { bodyId: PLATE_BODY, kind: "body" },
    });
    if (!moved.ok) throw new Error(moved.error.message);
    document = moved.value.document;
    const harness = mutableHarness({ document });
    const run = await runTool("cad_assembly_pattern", {
      circular: {
        angleStepDeg: 90,
        axisDirection: [0, 0, 1],
        axisOrigin: [0, 0, 0],
        count: 2,
      },
      kind: "circular",
      seedOccurrenceId: "occ_agent_at_80",
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const payload = run.payload as { added: string[] };
    expect(payload.added).toHaveLength(2);
    const stamped = payload.added.map((id) => {
      const occurrence = harness.cell.document.occurrences.find(
        (entry) => String(entry.id) === id,
      );
      if (occurrence?.placement.kind !== "offset") return null;
      return occurrence.placement.translation;
    });
    expect(stamped[0]?.[0]).toBeCloseTo(0, 9);
    expect(stamped[0]?.[1]).toBeCloseTo(80, 9);
    expect(stamped[1]?.[0]).toBeCloseTo(-80, 9);
    expect(stamped[1]?.[1]).toBeCloseTo(0, 9);
    harness.unbind();
  });

  it("stamps a mirrored placement across a plane", async () => {
    const harness = mutableHarness({ document: offsetSeedDocument() });
    const run = await runTool("cad_assembly_pattern", {
      kind: "mirror",
      mirror: { planeNormal: [1, 0, 0], planeOrigin: [0, 0, 0] },
      seedOccurrenceId: "occ_agent_seed",
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const payload = run.payload as { added: string[]; patternKind: string };
    expect(payload.patternKind).toBe("mirror");
    expect(payload.added).toHaveLength(1);
    const stamped = harness.cell.document.occurrences.find(
      (entry) => String(entry.id) === payload.added[0],
    );
    expect(stamped?.placement).toMatchObject({
      translation: [-80, 0, 0],
    });
    harness.unbind();
  });

  it("refuses the resolver's own structured failures verbatim", async () => {
    const harness = mutableHarness();
    const nonUnit = await runTool("cad_assembly_pattern", {
      kind: "linear",
      linear: { count: 1, direction: [2, 0, 0], spacingMm: 10 },
      seedOccurrenceId: "occ_agent_seed",
    });
    expect(nonUnit).toMatchObject({
      code: "assembly/pattern-direction-invalid",
      ok: false,
    });
    const unknownSeed = await runTool("cad_assembly_pattern", {
      kind: "linear",
      linear: { count: 1, direction: [1, 0, 0], spacingMm: 10 },
      seedOccurrenceId: "occ_nope",
    });
    expect(unknownSeed).toMatchObject({
      code: "workbench/assembly-occurrence-unknown",
      ok: false,
    });
    expect(harness.cell.document.occurrences).toHaveLength(1);
    harness.unbind();
  });

  it("rejects a kind without its parameters at the registry schema", async () => {
    const harness = mutableHarness();
    const run = await runTool("cad_assembly_pattern", {
      kind: "linear",
      seedOccurrenceId: "occ_agent_seed",
    });
    expect(run).toMatchObject({ code: "webmcp/invalid-input", ok: false });
    harness.unbind();
  });
});

describe("cad_assembly_add_mate / cad_assembly_remove_mate", () => {
  /** The seed document plus a second occurrence and one persistent reference. */
  function matedDocument(): CadDocument {
    let document = buildSeedDocument();
    const second = addOccurrence(document, {
      id: createOccurrenceId("occ_agent_second"),
      name: "second",
      placement: { kind: "offset", translation: [80, 0, 0] },
      source: { bodyId: PLATE_BODY, kind: "body" },
    });
    if (!second.ok) throw new Error(second.error.message);
    document = second.value.document;
    const reference = addDocumentReference(document, {
      name: "plate face",
      reference: { synthetic: true },
    });
    if (!reference.ok) throw new Error(reference.error.message);
    return reference.value.document;
  }

  it("adds through the door when the endpoints' references exist, then removes", async () => {
    const document = matedDocument();
    const referenceId = String(document.references[0]?.id);
    const harness = mutableHarness({ document });
    const added = await runTool("cad_assembly_add_mate", {
      first: { occurrenceId: "occ_agent_seed", referenceId },
      kind: "distance",
      name: "seeds apart",
      second: { occurrenceId: "occ_agent_second", referenceId },
      value: 80,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expectNoApiKeyLikeFieldNames(added.payload);
    const payload = added.payload as { mateId: string; mateCount: number };
    expect(payload.mateId).toMatch(/^mat_/);
    expect(payload.mateCount).toBe(1);
    expect(harness.cell.document.mates).toHaveLength(1);

    const removed = await runTool("cad_assembly_remove_mate", {
      mateId: payload.mateId,
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expectNoApiKeyLikeFieldNames(removed.payload);
    }
    expect(harness.cell.document.mates).toHaveLength(0);

    const unknown = await runTool("cad_assembly_remove_mate", {
      mateId: payload.mateId,
    });
    expect(unknown).toMatchObject({ code: "document/not-found", ok: false });
    harness.unbind();
  });

  it("refuses an endpoint whose reference does not exist (the door's own code)", async () => {
    const harness = mutableHarness({ document: matedDocument() });
    const run = await runTool("cad_assembly_add_mate", {
      first: { occurrenceId: "occ_agent_seed", referenceId: "ref_missing" },
      kind: "coincident",
      name: "bad",
      second: { occurrenceId: "occ_agent_second", referenceId: "ref_missing" },
    });
    expect(run).toMatchObject({ code: "assembly/mate-invalid", ok: false });
    expect(harness.cell.document.mates).toHaveLength(0);
    harness.unbind();
  });

  it("blocks removing an occurrence a mate addresses (the in-use discipline)", async () => {
    const document = matedDocument();
    const referenceId = String(document.references[0]?.id);
    const harness = mutableHarness({ document });
    const added = await runTool("cad_assembly_add_mate", {
      first: { occurrenceId: "occ_agent_seed", referenceId },
      kind: "coincident",
      name: "pinned",
      second: { occurrenceId: "occ_agent_second", referenceId },
    });
    expect(added.ok).toBe(true);
    const blocked = await runTool("cad_assembly_remove_occurrence", {
      occurrenceId: "occ_agent_seed",
    });
    expect(blocked).toMatchObject({
      code: "assembly/occurrence-in-use",
      ok: false,
    });
    harness.unbind();
  });
});

describe("cad_assembly_add_joint / cad_assembly_remove_joint", () => {
  /** The seed document plus a second occurrence. */
  function jointedDocument(): CadDocument {
    const document = buildSeedDocument();
    const second = addOccurrence(document, {
      id: createOccurrenceId("occ_agent_second"),
      name: "second",
      placement: { kind: "offset", translation: [80, 0, 0] },
      source: { bodyId: PLATE_BODY, kind: "body" },
    });
    if (!second.ok) throw new Error(second.error.message);
    return second.value.document;
  }

  it("adds a revolute joint through the door; diagnostics reports its DOF", async () => {
    const harness = mutableHarness({ document: jointedDocument() });
    const added = await runTool("cad_assembly_add_joint", {
      baseOccurrenceId: "occ_agent_seed",
      frame: { axis: [0, 0, 1], origin: [80, 0, 0] },
      kind: "revolute",
      name: "hinge",
      occurrenceId: "occ_agent_second",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expectNoApiKeyLikeFieldNames(added.payload);
    const payload = added.payload as { jointId: string };
    expect(payload.jointId).toMatch(/^jnt_/);
    expect(harness.cell.document.joints).toHaveLength(1);

    const diagnostics = await runTool("cad_get_diagnostics", {});
    expect(diagnostics.ok).toBe(true);
    if (diagnostics.ok) {
      expect(diagnostics.payload).toMatchObject({
        assembly: {
          jointCount: 1,
          jointDof: { rotational: 1, translational: 0 },
        },
      });
    }

    const removed = await runTool("cad_assembly_remove_joint", {
      jointId: payload.jointId,
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expectNoApiKeyLikeFieldNames(removed.payload);
    }
    expect(harness.cell.document.joints).toHaveLength(0);
    harness.unbind();
  });

  it("refuses a rigid joint that carries a frame (the door's own rule)", async () => {
    const harness = mutableHarness({ document: jointedDocument() });
    const run = await runTool("cad_assembly_add_joint", {
      baseOccurrenceId: "occ_agent_seed",
      frame: { axis: [0, 0, 1], origin: [0, 0, 0] },
      kind: "rigid",
      name: "welded",
      occurrenceId: "occ_agent_second",
    });
    expect(run).toMatchObject({ code: "assembly/joint-invalid", ok: false });
    expect(harness.cell.document.joints).toHaveLength(0);
    harness.unbind();
  });
});

describe("cad_assembly_check_interference", () => {
  /** Two plate occurrences: the second penetrates 15 mm into the first. */
  function overlappingDocument(): CadDocument {
    const document = buildSeedDocument();
    const overlapping = addOccurrence(document, {
      id: createOccurrenceId("occ_agent_overlap"),
      name: "overlap",
      placement: { kind: "offset", translation: [45, 0, 0] },
      source: { bodyId: PLATE_BODY, kind: "body" },
    });
    if (!overlapping.ok) throw new Error(overlapping.error.message);
    return overlapping.value.document;
  }

  it("reports the interfering pair's volume and the clearance batch", async () => {
    const harness = mutableHarness({
      document: overlappingDocument(),
      interference: plateSeams(),
    });
    const run = await runTool("cad_assembly_check_interference", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    const payload = run.payload as {
      checkedPairs: number;
      clearances: { clearanceMm: number; first: string[] }[];
      pairs: { first: string[]; volumeMm3: number }[];
      skipped: unknown[];
      toleranceMm3: number;
    };
    expect(payload.pairs).toHaveLength(1);
    expect(payload.pairs[0]?.first).toEqual(["occ_agent_seed"]);
    // 15 mm of x overlap over the full 40 × 12 section.
    expect(payload.pairs[0]?.volumeMm3).toBeCloseTo(15 * 40 * 12, 9);
    expect(payload.checkedPairs).toBe(1);
    expect(payload.skipped).toEqual([]);
    // The tool runs at the page's own shared threshold (D4 fidelity), not
    // the kernel's stricter default.
    expect(payload.toleranceMm3).toBe(INTERFERENCE_TOLERANCE_MM3);
    expect(payload.clearances).toHaveLength(1);
    expect(payload.clearances[0]?.clearanceMm).toBeGreaterThanOrEqual(0);
    harness.unbind();
  });

  it("refuses structurally on a page without interference seams", async () => {
    const harness = mutableHarness({ document: overlappingDocument() });
    const run = await runTool("cad_assembly_check_interference", {});
    expect(run).toMatchObject({
      code: "workbench/assembly-interference-unavailable",
      ok: false,
    });
    harness.unbind();
  });

  it("answers on the read-only surface too (the report is a read)", async () => {
    const harness = readonlyHarness(overlappingDocument());
    const run = await runTool("cad_assembly_check_interference", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const payload = run.payload as { pairs: unknown[] };
    expect(payload.pairs).toHaveLength(1);
    harness.unbind();
  });
});

describe("cad_get_diagnostics (assembly)", () => {
  it("reports the anchor-less mate solve honestly and the joint DOF", async () => {
    let document = buildSeedDocument();
    const second = addOccurrence(document, {
      id: createOccurrenceId("occ_agent_second"),
      name: "second",
      placement: { kind: "offset", translation: [80, 0, 0] },
      source: { bodyId: PLATE_BODY, kind: "body" },
    });
    if (!second.ok) throw new Error(second.error.message);
    document = second.value.document;
    const reference = addDocumentReference(document, {
      name: "plate face",
      reference: { synthetic: true },
    });
    if (!reference.ok) throw new Error(reference.error.message);
    document = reference.value.document;
    const referenceId = createReferenceId(String(reference.value.reference.id));
    const mate = addMate(document, {
      first: {
        occurrenceId: createOccurrenceId("occ_agent_seed"),
        referenceId,
      },
      kind: "coincident",
      name: "pinned",
      second: {
        occurrenceId: createOccurrenceId("occ_agent_second"),
        referenceId,
      },
    });
    if (!mate.ok) throw new Error(mate.error.message);
    document = mate.value.document;

    const harness = mutableHarness({ document });
    const run = await runTool("cad_get_diagnostics", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    expect(run.payload).toMatchObject({
      assembly: {
        jointDof: { rotational: 0, translational: 0 },
        mateCount: 1,
        occurrenceCount: 2,
        solveDiagnostics: [
          { code: "assembly/mate-unresolved", severity: "error" },
        ],
        solveStatus: "unresolved",
      },
      ok: true,
    });
    harness.unbind();
  });
});

/** The seed document with the seed occurrence offset to [80, 0, 0]. */
function offsetSeedDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_agent_assembly"));
  const body = addBody(document, { id: PLATE_BODY, name: "plate" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const seed = addOccurrence(document, {
    id: createOccurrenceId("occ_agent_seed"),
    name: "plate seed",
    placement: { kind: "offset", translation: [80, 0, 0] },
    source: { bodyId: PLATE_BODY, kind: "body" },
  });
  if (!seed.ok) throw new Error(seed.error.message);
  return seed.value.document;
}
