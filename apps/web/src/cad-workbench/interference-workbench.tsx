/**
 * The interference workbench fixture (Phase 58): `/workbench-assembly-interference`.
 * Phase 51's interference detector and Phase 58's clearance batch drawn
 * END TO END at the browser surface — the roadmap's interference report
 * UX: the results panel, isolation of a pair, and the deterministic
 * JSON/HTML snapshot export.
 *
 * The pipeline is the Phase 50 assembly boundary with NO kernel and NO
 * worker: the geometry is a static analytic box soup, every other hop is
 * the REAL boundary — `resolveAssemblyInstances` walks the occurrence
 * tree, `checkResolvedAssemblyInterference` runs the detector batch
 * against a host-bound seam, and `checkAssemblyClearances` measures the
 * pair distances over the submitted soups.
 *
 * ## The seam (honesty about what computes what)
 *
 * The detector's `intersectVolume` seam is bound to the fixture's
 * ANALYTIC axis-aligned box kernel: every body is an axis-aligned box
 * and every placement a pure translation, so the boolean intersection
 * volume of two placed solids IS the world-AABB overlap product — exact,
 * deterministic, and honestly labelled as the fixture's stand-in for the
 * executor's active-kernel binding. The clearance batch needs no seam:
 * it measures over the submitted triangles with its documented
 * sampled-vertex-triangle precision (exact for these planar pairs).
 *
 * Machine surfaces (additive): `data-cad-interference-pairs`,
 * `data-cad-interference-skipped`, `data-cad-checked-pairs`,
 * `data-cad-clearance-count`, `data-cad-isolated-pair`, and the snapshot
 * export trio `data-cad-report-format` / `data-cad-report-digest` /
 * `data-cad-report-bytes` (the byte-stability stamps), plus the
 * inherited occurrence/instance/hydration stamps.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  addBody,
  addOccurrence,
  checkAssemblyClearances,
  checkResolvedAssemblyInterference,
  createBodyId,
  createDocument,
  createDocumentId,
  createOccurrenceId,
  createRenderProjection,
  parsePlacementTransform,
  placementTransformBounds,
  projectPlacedInstance,
  projectTessellation,
  resolveAssemblyInstances,
  type BodyId,
  type CadDocument,
  type ClearanceInstance,
  type ClearanceMesh,
  type ClearanceReport,
  type DatumVec3,
  type InterferenceReport,
  type OccurrenceId,
  type PlacementTransform,
  type RenderObject,
  type RenderProjection,
} from "@slopcad/cad-core";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

import {
  interferencePanelModel,
  isInstanceIsolated,
  isolationStamp,
  prepareSnapshotExports,
  type IsolatedPair,
  type PreparedSnapshotExport,
} from "./interference-panel";

/** An axis-aligned box's triangle soup: 24 vertices, per-face normals. */
function boxTessellation(
  width: number,
  depth: number,
  height: number,
): {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
} {
  const x = width;
  const y = depth;
  const z = height;
  return {
    positions: [
      // -z face
      0,
      0,
      0,
      x,
      0,
      0,
      x,
      y,
      0,
      0,
      y,
      0,
      // +z face
      0,
      0,
      z,
      x,
      0,
      z,
      x,
      y,
      z,
      0,
      y,
      z,
      // -y face
      0,
      0,
      0,
      x,
      0,
      0,
      x,
      0,
      z,
      0,
      0,
      z,
      // +y face
      0,
      y,
      0,
      x,
      y,
      0,
      x,
      y,
      z,
      0,
      y,
      z,
      // -x face
      0,
      0,
      0,
      0,
      y,
      0,
      0,
      y,
      z,
      0,
      0,
      z,
      // +x face
      x,
      0,
      0,
      x,
      y,
      0,
      x,
      y,
      z,
      x,
      0,
      z,
    ],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 14, 13, 12,
      15, 14, 16, 18, 17, 16, 19, 18, 20, 21, 22, 20, 22, 23,
    ],
  };
}

/** The fixture's three axis-aligned boxes (mm). */
const PLATE_EXTENTS = [60, 40, 12] as const;
const BLOCK_EXTENTS = [30, 30, 30] as const;

/** Deterministic fixture body ids. */
const PLATE_BODY = createBodyId("body_int_plate");
const BLOCK_BODY = createBodyId("body_int_block");
const CLEAR_BODY = createBodyId("body_int_clear");

/** The fixture's body soup and extents, one entry per body. */
const FIXTURE_BODIES: readonly {
  readonly id: BodyId;
  readonly name: string;
  readonly extents: readonly [number, number, number];
}[] = [
  { id: PLATE_BODY, name: "plate", extents: PLATE_EXTENTS },
  { id: BLOCK_BODY, name: "block", extents: BLOCK_EXTENTS },
  { id: CLEAR_BODY, name: "clear block", extents: BLOCK_EXTENTS },
];

/** The plate's mesh; the two 30-cubes share one soup (reuse before create). */
const MESH_BY_BODY = new Map<BodyId, ClearanceMesh>(
  FIXTURE_BODIES.map((body) => [
    body.id,
    boxTessellation(body.extents[0], body.extents[1], body.extents[2]),
  ]),
);

/** Local-space bounds per body — the detector's and seam's extents. */
const LOCAL_BOUNDS = new Map<BodyId, { min: DatumVec3; max: DatumVec3 }>(
  FIXTURE_BODIES.map((body) => [
    body.id,
    {
      min: [0, 0, 0] as [number, number, number],
      max: [body.extents[0], body.extents[1], body.extents[2]] as [
        number,
        number,
        number,
      ],
    },
  ]),
);

/** Deterministic fixture identities. */
const INTERFERENCE_DOC_ID = "doc_assembly_interference";

/** The placed occurrences: the plate, an overlapping block, a clear one. */
const PLATE_OCCURRENCE = createOccurrenceId("occ_int_plate");
const BLOCK_OCCURRENCE = createOccurrenceId("occ_int_block");
const CLEAR_OCCURRENCE = createOccurrenceId("occ_int_clear");

/** The placements: the block penetrates 15 mm into the plate; 140 mm gap. */
const PLACEMENTS: readonly {
  readonly id: OccurrenceId;
  readonly name: string;
  readonly bodyId: BodyId;
  readonly translation: readonly [number, number, number];
}[] = [
  {
    id: PLATE_OCCURRENCE,
    name: "plate",
    bodyId: PLATE_BODY,
    translation: [0, 0, 0],
  },
  {
    id: BLOCK_OCCURRENCE,
    name: "block",
    bodyId: BLOCK_BODY,
    translation: [45, 0, 0],
  },
  {
    id: CLEAR_OCCURRENCE,
    name: "clear block",
    bodyId: CLEAR_BODY,
    translation: [200, 0, 0],
  },
];

/** Builds the fixture document: three bodies, three placed occurrences. */
function buildInitialDocument(): CadDocument {
  let document = createDocument(createDocumentId(INTERFERENCE_DOC_ID));
  for (const body of FIXTURE_BODIES) {
    const added = addBody(document, { id: body.id, name: body.name });
    if (!added.ok) throw new Error("expected the fixture body to add");
    document = added.value.document;
  }
  for (const occurrence of PLACEMENTS) {
    const added = addOccurrence(document, {
      id: occurrence.id,
      name: occurrence.name,
      source: { kind: "body", bodyId: occurrence.bodyId },
      placement:
        occurrence.translation[0] === 0 &&
        occurrence.translation[1] === 0 &&
        occurrence.translation[2] === 0
          ? undefined
          : { kind: "offset", translation: occurrence.translation },
    });
    if (!added.ok) throw new Error("expected the fixture occurrence to add");
    document = added.value.document;
  }
  return document;
}

/**
 * The fixture's analytic axis-aligned box kernel: the intersection VOLUME
 * of two placed axis-aligned boxes under translation-only placements is
 * the world-AABB overlap product (exact; see the module header).
 */
function boxIntersectionVolume(
  a: { readonly bodyId: BodyId; readonly transform: PlacementTransform },
  b: { readonly bodyId: BodyId; readonly transform: PlacementTransform },
): number | null {
  const aBounds = LOCAL_BOUNDS.get(a.bodyId);
  const bBounds = LOCAL_BOUNDS.get(b.bodyId);
  if (aBounds === undefined || bBounds === undefined) return null;
  const aWorld = placementTransformBounds(
    a.transform,
    aBounds.min,
    aBounds.max,
  );
  const bWorld = placementTransformBounds(
    b.transform,
    bBounds.min,
    bBounds.max,
  );
  const overlapX =
    Math.min(aWorld.max[0], bWorld.max[0]) -
    Math.max(aWorld.min[0], bWorld.min[0]);
  const overlapY =
    Math.min(aWorld.max[1], bWorld.max[1]) -
    Math.max(aWorld.min[1], bWorld.min[1]);
  const overlapZ =
    Math.min(aWorld.max[2], bWorld.max[2]) -
    Math.max(aWorld.min[2], bWorld.min[2]);
  if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return 0;
  return overlapX * overlapY * overlapZ;
}

/** Runs the interference batch over the document's placed instances. */
function runInterferenceCheck(
  document: CadDocument,
): InterferenceReport | null {
  const resolution = resolveAssemblyInstances(document);
  if (!resolution.ok) return null;
  const report = checkResolvedAssemblyInterference({
    instances: resolution.instances,
    boundsOf: (bodyId) => LOCAL_BOUNDS.get(bodyId),
    intersectVolume: boxIntersectionVolume,
    tolerance: 0.001,
  });
  return report.ok ? report.value : null;
}

/** Runs the clearance batch over every unordered instance pair. */
function runClearanceCheck(document: CadDocument): ClearanceReport | null {
  const resolution = resolveAssemblyInstances(document);
  if (!resolution.ok) return null;
  const instances: ClearanceInstance[] = [];
  for (const instance of resolution.instances) {
    const mesh = MESH_BY_BODY.get(instance.bodyId);
    if (mesh === undefined) return null;
    instances.push({
      path: instance.path,
      bodyId: instance.bodyId,
      transform: instance.transform,
      mesh,
    });
  }
  const pairs: (readonly [number, number])[] = [];
  for (let i = 0; i < instances.length; i += 1) {
    for (let j = i + 1; j < instances.length; j += 1) {
      pairs.push([i, j]);
    }
  }
  const report = checkAssemblyClearances({ instances, pairs });
  return report.ok ? report.value : null;
}

/** The projection: every placed instance, or only the isolated pair's. */
function projectAssembly(
  document: CadDocument,
  isolated: IsolatedPair | undefined,
): RenderProjection | null {
  const resolution = resolveAssemblyInstances(document);
  if (!resolution.ok) return null;
  const objects: RenderObject[] = [];
  for (const instance of resolution.instances) {
    const transform = parsePlacementTransform(instance.transform);
    if (!transform.ok) return null;
    if (!isInstanceIsolated(instance.path[0] ?? "", isolated)) continue;
    const base = MESH_BY_BODY.get(instance.bodyId);
    if (base === undefined) return null;
    const placed = projectTessellation(instance.bodyId, base);
    if (!placed.ok) return null;
    const object = projectPlacedInstance(
      placed.value,
      instance.path,
      transform.value,
    );
    if (!object.ok) return null;
    objects.push(object.value);
  }
  if (objects.length === 0) return null;
  const projection = createRenderProjection(objects, {
    kind: "perspective",
    position: [260, -320, 240],
    target: [130, 15, 0],
    up: [0, 0, 1],
    fovDeg: 40,
  });
  return projection.ok ? projection.value : null;
}

/** The download's MIME type per format. */
function snapshotMediaType(format: PreparedSnapshotExport["format"]): string {
  return format === "json" ? "application/json" : "text/html";
}

export function InterferenceWorkbenchPage(): ReactElement {
  // The document is the fixture's constant; the panel state lives in the
  // reports and the isolation, so no setter is carried.
  const [document] = useState<CadDocument>(buildInitialDocument);
  const [hydrated, setHydrated] = useState(false);
  const [report, setReport] = useState<InterferenceReport | null>(null);
  const [clearances, setClearances] = useState<ClearanceReport | null>(null);
  const [isolated, setIsolated] = useState<IsolatedPair | undefined>(undefined);
  const [held, setHeld] = useState<
    | {
        readonly url: string;
        readonly prepared: PreparedSnapshotExport;
      }
    | undefined
  >(undefined);
  const heldUrlRef = useRef<string | undefined>(undefined);

  // The object URL of the held snapshot lives exactly as long as it is
  // held — revoked on replace and on unmount, never leaked.
  useEffect(() => {
    return () => {
      if (heldUrlRef.current !== undefined) {
        URL.revokeObjectURL(heldUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const labelOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const occurrence of document.occurrences) {
      names.set(occurrence.id, occurrence.name);
    }
    return (occurrenceId: string): string =>
      names.get(occurrenceId) ?? occurrenceId;
  }, [document]);

  const model = interferencePanelModel({
    interference: report,
    clearances,
    labelOf,
  });

  const projection = useMemo(
    () => projectAssembly(document, isolated),
    [document, isolated],
  );

  const preparedExports = useMemo(() => {
    if (report === null) return null;
    return prepareSnapshotExports({
      documentId: document.id,
      interference: report,
      clearances: clearances ?? undefined,
      labelOf,
      nameStem: "interference-snapshot",
    });
  }, [report, clearances, labelOf, document.id]);

  const runCheck = (): void => {
    setReport(runInterferenceCheck(document));
    setClearances(runClearanceCheck(document));
    setIsolated(undefined);
  };

  const exportSnapshot = (prepared: PreparedSnapshotExport): void => {
    const url = URL.createObjectURL(
      new Blob([prepared.text], { type: snapshotMediaType(prepared.format) }),
    );
    if (heldUrlRef.current !== undefined) {
      URL.revokeObjectURL(heldUrlRef.current);
    }
    heldUrlRef.current = url;
    setHeld({ url, prepared });
  };

  const occurrenceCount = document.occurrences.length;

  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      id="interference-workbench-root"
      data-cad-hydrated={hydrated ? "true" : "false"}
      data-cad-occurrence-count={String(occurrenceCount)}
      data-cad-instance-count={String(
        projection === null
          ? 0
          : projection.objects.filter(
              (object) => object.occurrencePath !== undefined,
            ).length,
      )}
      data-cad-interference-pairs={String(model.pairCount)}
      data-cad-interference-skipped={String(model.skippedCount)}
      data-cad-checked-pairs={String(model.checkedCount)}
      data-cad-clearance-count={String(model.clearanceCount)}
      data-cad-isolated-pair={isolationStamp(isolated)}
      data-cad-report-format={held?.prepared.format ?? "none"}
      data-cad-report-digest={held?.prepared.digest ?? "none"}
      data-cad-report-bytes={
        held === undefined ? "none" : String(held.prepared.bytes)
      }
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 58 interference fixture — report panel, isolation, snapshots
        </h1>
        <p className="text-muted-foreground text-sm">
          A plate, an overlapping block, and a clear block. Run the check to
          fill the report panel; isolate a pair; export the snapshot.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="interference-run"
          onClick={runCheck}
          type="button"
        >
          Run interference check
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="interference-show-all"
          disabled={isolated === undefined}
          onClick={() => setIsolated(undefined)}
          type="button"
        >
          Show all instances
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          data-testid="interference-export-json"
          disabled={preparedExports === null}
          onClick={() => {
            if (preparedExports !== null) exportSnapshot(preparedExports.json);
          }}
          type="button"
        >
          Export snapshot (JSON)
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          data-testid="interference-export-html"
          disabled={preparedExports === null}
          onClick={() => {
            if (preparedExports !== null) exportSnapshot(preparedExports.html);
          }}
          type="button"
        >
          Export snapshot (HTML)
        </button>
        {held !== undefined ? (
          <a
            className="text-sm underline underline-offset-2"
            data-testid="interference-download"
            download={held.prepared.name}
            href={held.url}
          >
            Download {held.prepared.name}
          </a>
        ) : null}
      </div>
      <section
        className="border-border rounded-md border p-4"
        data-testid="interference-panel"
      >
        <h2 className="text-sm font-semibold">Interference report</h2>
        {model.status === "idle" ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No report yet — run the check. The panel shows nothing before a
            report exists.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground mt-1 text-xs">
              checked {model.checkedCount} · interfering {model.pairCount} ·
              skipped {model.skippedCount} · clearances {model.clearanceCount}
            </p>
            <table className="mt-2 w-full text-left text-sm">
              <thead>
                <tr className="text-muted-foreground text-xs">
                  <th className="py-1 pr-3 font-medium">First</th>
                  <th className="py-1 pr-3 font-medium">Second</th>
                  <th className="py-1 pr-3 font-medium">Verdict</th>
                  <th className="py-1 pr-3 font-medium">Measure</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row, index) => (
                  <tr key={row.key} data-testid={`interference-row-${index}`}>
                    <td className="py-1 pr-3">{row.firstLabel}</td>
                    <td className="py-1 pr-3">{row.secondLabel}</td>
                    <td className="py-1 pr-3">{row.verdict}</td>
                    <td className="py-1 pr-3">
                      {row.volumeText ?? row.clearanceText ?? row.reasonText}
                    </td>
                    <td className="py-1">
                      {row.verdict === "interferes" ? (
                        <button
                          className="border-border rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-muted"
                          data-testid={`interference-isolate-${index}`}
                          onClick={() =>
                            setIsolated({
                              firstId: row.firstId,
                              secondId: row.secondId,
                            })
                          }
                          type="button"
                        >
                          Isolate
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      <div className="flex gap-4">
        <CadViewport className="h-[420px] flex-1" projection={projection} />
      </div>
    </div>
  );
}
