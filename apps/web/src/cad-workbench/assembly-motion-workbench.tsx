/**
 * The assembly motion workbench fixture (Phase 52): `/workbench-assembly-motion`.
 * The Assemblies III machinery drawn END TO END on the Phase 50 pipeline —
 * component patterns and mirror components stamp ordinary occurrences
 * through `addOccurrence` (the resolution walk, the projection, and the
 * native format stay untouched), the explode state and the motion joint
 * compose ON TOP of the resolved instances as pure cad-core algebra, and
 * the cross-document staleness strip exercises the host-seam revision rule.
 *
 * Machine surfaces (additive): `data-cad-occurrence-count`,
 * `data-cad-instance-count`, `data-cad-pattern-count` (pattern-generated
 * occurrences), `data-cad-explode-factor`, `data-cad-explode-active`,
 * `data-cad-explode-scene` (a deterministic JSON stamp of the exploded
 * placements — the scrub determinism probe), `data-cad-motion-parameter`,
 * `data-cad-motion-scene` (the joint's local pose stamp),
 * `data-cad-clearance-mm` (the sampled clearance floor), and the staleness
 * pair `data-cad-stale` / `data-cad-stale-sources`.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  addBody,
  addOccurrence,
  applyExplodeState,
  applyMotionJoint,
  ASSEMBLY_MOTION_CAPABILITIES,
  ASSEMBLY_PATTERN_CAPABILITIES,
  composePlacementTransforms,
  computeAssemblyStaleness,
  createBodyId,
  createDocument,
  createDocumentId,
  createOccurrenceId,
  createRenderProjection,
  motionDragDecline,
  parseAssemblyMotionJoint,
  parseExplodeState,
  parsePlacementTransform,
  probeMotionClearance,
  projectPlacedInstance,
  projectTessellation,
  resolveAssemblyInstances,
  resolveCircularOccurrencePattern,
  resolveLinearOccurrencePattern,
  resolveMirroredOccurrencePlacement,
  resolveOccurrencePlacement,
  serializeExplodeState,
  transformPlacementPoint,
  type CadDocument,
  type OccurrenceId,
  type PlacementTransform,
  type RenderObject,
  type AssemblyExplodeState,
} from "@slopcad/cad-core";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import {
  CadModelTree,
  type CadModelTreeAssemblyNode,
} from "@slopcad/ui/components/cad/cad-model-tree";

/** The plate soup both bodies share (the Phase 50 fixture's, verbatim). */
const BOX_TESSELLATION = {
  positions: [
    0, 0, 0, 60, 0, 0, 60, 40, 0, 0, 40, 0, 0, 0, 12, 60, 0, 12, 60, 40, 12, 0,
    40, 12, 0, 0, 0, 60, 0, 0, 60, 0, 12, 0, 0, 12, 0, 40, 0, 60, 40, 0, 60, 40,
    12, 0, 40, 12, 0, 0, 0, 0, 40, 0, 0, 40, 12, 0, 0, 12, 60, 0, 0, 60, 40, 0,
    60, 40, 12, 60, 0, 12,
  ],
  indices: [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 14, 13, 12, 15,
    14, 16, 18, 17, 16, 19, 18, 20, 21, 22, 20, 22, 23,
  ],
  normals: [
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ],
} as const;

/** The plate's local bounds (the soup's extents) — centroids and probes. */
const PLATE_LOCAL_BOUNDS = {
  min: [0, 0, 0] as [number, number, number],
  max: [60, 40, 12] as [number, number, number],
};

/** Deterministic fixture identities. */
const PLATE_BODY = createBodyId("body_plate");
const SOURCE_BODY = createBodyId("body_source_plate");
const ASSEMBLY_DOC_ID = "doc_assembly_motion";
const SOURCE_DOC_ID = "doc_motion_source";

/** The linear pattern's step (mm) and count; the circular run's constants. */
const LINEAR_STEP_MM = 80;
const LINEAR_COUNT = 3;
const CIRCULAR_COUNT = 6;
const CIRCULAR_STEP_DEG = 60;

/** The fixture's explicit occurrence ids (no generator coupling). */
const OccurrenceFixtures = {
  seed: (): OccurrenceId => createOccurrenceId("occ_motion_seed"),
  source: (): OccurrenceId => createOccurrenceId("occ_motion_source"),
  at: (label: string): OccurrenceId =>
    createOccurrenceId(`occ_motion_${label}`),
};

/** The seed occurrence's id — the probe's stationary side. */
const SEED_ID = OccurrenceFixtures.seed();
/** The jointed occurrence's id — the first linear-pattern instance. */
const JOINTED_ID = OccurrenceFixtures.at("lin_1");

/** Builds the assembly document: the seed plate + the cross-document source. */
function buildInitialDocument(): CadDocument {
  let document = createDocument(createDocumentId(ASSEMBLY_DOC_ID));
  const body = addBody(document, { id: PLATE_BODY, name: "plate" });
  if (!body.ok) throw new Error("expected the plate body to add");
  document = body.value.document;
  const seed = addOccurrence(document, {
    id: SEED_ID,
    name: "plate seed",
    source: { kind: "body", bodyId: PLATE_BODY },
  });
  if (!seed.ok) throw new Error("expected the seed occurrence to add");
  document = seed.value.document;
  const source = addOccurrence(document, {
    id: OccurrenceFixtures.source(),
    name: "sourced plate",
    source: { kind: "document", documentId: SOURCE_DOC_ID },
  });
  if (!source.ok) throw new Error("expected the source occurrence to add");
  return source.value.document;
}

/** Builds the source document the assembly consumes through the seam. */
function buildSourceDocument(): CadDocument {
  const document = createDocument(createDocumentId(SOURCE_DOC_ID));
  const body = addBody(document, { id: SOURCE_BODY, name: "source plate" });
  if (!body.ok) throw new Error("expected the source body to add");
  return body.value.document;
}

/** The host document seam (the persistence layer's stand-in, project-local). */
const DOCUMENT_SEAM = (documentId: string): CadDocument | undefined =>
  documentId === SOURCE_DOC_ID ? buildSourceDocument() : undefined;

/** The soup per body id: both fixture bodies render the plate. */
function tessellationFor(bodyId: string) {
  return bodyId === PLATE_BODY || bodyId === SOURCE_BODY
    ? BOX_TESSELLATION
    : undefined;
}

/** A rigid seed placement used by the fixture's pattern actions. */
function seedAt(
  translation: readonly [number, number, number],
): PlacementTransform {
  return {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [...translation],
  };
}

export function AssemblyMotionWorkbenchPage(): ReactElement {
  const [document, setDocument] = useState<CadDocument>(buildInitialDocument);
  const [hydrated, setHydrated] = useState(false);
  const [patternCount, setPatternCount] = useState(0);
  const [explodeStateJson, setExplodeStateJson] = useState<string | null>(null);
  const [explodeFactor, setExplodeFactor] = useState(0);
  const [motionParameter, setMotionParameter] = useState(0);
  const [dragDecline, setDragDecline] = useState<string | null>(null);
  // The cross-document revision pair: the assembly's save ordinal and the
  // source's. The staleness rule reads ONLY these (host-supplied revisions)
  // and is STRICTLY newer — one source save past the assembly's ordinal
  // marks the assembly stale.
  const [assemblyRevision, setAssemblyRevision] = useState(1);
  const [sourceRevision, setSourceRevision] = useState(1);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const joint = useMemo(
    () =>
      parseAssemblyMotionJoint({
        occurrenceId: JOINTED_ID,
        kind: "revolute",
        axisOrigin: [240, 0, 0],
        axisDirection: [0, 0, 1],
        limitMin: -90,
        limitMax: 90,
      }),
    [],
  );

  const staleness = useMemo(
    () =>
      computeAssemblyStaleness(
        [
          {
            documentId: ASSEMBLY_DOC_ID,
            revision: assemblyRevision,
            sources: [
              {
                occurrenceId: OccurrenceFixtures.source(),
                sourceDocumentId: SOURCE_DOC_ID,
              },
            ],
          },
          {
            documentId: SOURCE_DOC_ID,
            revision: sourceRevision,
            sources: [],
          },
        ],
        ASSEMBLY_DOC_ID,
      ),
    [assemblyRevision, sourceRevision],
  );

  /** The clearance floor of the jointed plate against the seed, sampled. */
  const clearance = useMemo(() => {
    if (!joint.ok) return null;
    return probeMotionClearance({
      joint: joint.value,
      stationCount: 5,
      movingBounds: PLATE_LOCAL_BOUNDS,
      movingTransform: seedAt([LINEAR_STEP_MM, 0, 0]),
      stationaryBounds: PLATE_LOCAL_BOUNDS,
      contactFloorMm: 0,
    });
  }, [joint]);

  /**
   * The full derive: resolution, then the motion joint and explode state
   * composed ON TOP of the resolved transforms (the joint's local pose
   * composes under the occurrence's placement; the explode offset is the
   * outermost world-space move).
   */
  const derived = useMemo(() => {
    const resolution = resolveAssemblyInstances(document, {
      document: DOCUMENT_SEAM,
    });
    if (!resolution.ok) return null;
    const explodeState =
      explodeStateJson === null
        ? null
        : (() => {
            const parsed = parseExplodeState(JSON.parse(explodeStateJson));
            return parsed.ok ? parsed.value : null;
          })();
    const localPlateCenter: [number, number, number] = [
      (PLATE_LOCAL_BOUNDS.min[0] + PLATE_LOCAL_BOUNDS.max[0]) / 2,
      (PLATE_LOCAL_BOUNDS.min[1] + PLATE_LOCAL_BOUNDS.max[1]) / 2,
      (PLATE_LOCAL_BOUNDS.min[2] + PLATE_LOCAL_BOUNDS.max[2]) / 2,
    ];
    const centroids = resolution.instances.map((instance) =>
      transformPlacementPoint(instance.transform, localPlateCenter),
    );
    const worldBounds = centroids.reduce<{
      min: [number, number, number];
      max: [number, number, number];
    }>(
      (bounds, centroid) => ({
        min: [
          Math.min(bounds.min[0], centroid[0]),
          Math.min(bounds.min[1], centroid[1]),
          Math.min(bounds.min[2], centroid[2]),
        ],
        max: [
          Math.max(bounds.max[0], centroid[0]),
          Math.max(bounds.max[1], centroid[1]),
          Math.max(bounds.max[2], centroid[2]),
        ],
      }),
      {
        min: [
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY,
        ],
        max: [
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ],
      },
    );
    const assemblyCentroid: [number, number, number] = [
      (worldBounds.min[0] + worldBounds.max[0]) / 2,
      (worldBounds.min[1] + worldBounds.max[1]) / 2,
      (worldBounds.min[2] + worldBounds.max[2]) / 2,
    ];
    const pathKeyOf = (path: readonly OccurrenceId[]): string =>
      path.map((id) => String(id)).join(">");
    const transforms = new Map<string, PlacementTransform>();
    let motionStamp = "";
    for (const instance of resolution.instances) {
      let transform = instance.transform;
      if (joint.ok && instance.path[0] === joint.value.occurrenceId) {
        const motion = applyMotionJoint(joint.value, motionParameter);
        if (!motion.ok) return null;
        transform = composePlacementTransforms(transform, motion.value);
        motionStamp = JSON.stringify([
          pathKeyOf(instance.path),
          motion.value.translation,
          motion.value.rotation,
        ]);
      }
      transforms.set(pathKeyOf(instance.path), transform);
    }
    let exploded: ReadonlyMap<string, PlacementTransform> | null = null;
    if (explodeState !== null) {
      const applied = applyExplodeState({
        state: explodeState,
        instances: resolution.instances.map((instance, index) => ({
          path: instance.path,
          centroid: centroids[index] ?? [0, 0, 0],
        })),
        transforms,
        factor: explodeFactor,
        centroid: assemblyCentroid,
      });
      if (!applied.ok) return null;
      exploded = applied.value;
    }
    const objects: RenderObject[] = [];
    for (const instance of resolution.instances) {
      const soup = tessellationFor(instance.bodyId);
      if (soup === undefined) continue;
      const base = projectTessellation(instance.bodyId, soup);
      if (!base.ok) return null;
      const key = pathKeyOf(instance.path);
      const transform = parsePlacementTransform(
        exploded?.get(key) ?? transforms.get(key) ?? instance.transform,
      );
      if (!transform.ok) return null;
      const placed = projectPlacedInstance(
        base.value,
        instance.path,
        transform.value,
      );
      if (!placed.ok) return null;
      objects.push(placed.value);
    }
    const sceneStamp = JSON.stringify(
      [...(exploded ?? transforms).entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    return {
      instances: resolution.instances,
      objects,
      sceneStamp,
      motionStamp,
    };
  }, [document, explodeStateJson, explodeFactor, joint, motionParameter]);

  const projection = useMemo(() => {
    if (derived === null) return null;
    const objects = [...derived.objects];
    // The document's own bodies render through the direct pipeline too.
    for (const body of document.bodies) {
      const soup = tessellationFor(body.id);
      if (soup === undefined) continue;
      const base = projectTessellation(body.id, soup);
      if (base.ok) objects.push(base.value);
    }
    const created = createRenderProjection(objects, {
      kind: "perspective",
      position: [420, -420, 320],
      target: [240, 40, 0],
      up: [0, 0, 1],
      fovDeg: 40,
    });
    return created.ok ? created.value : null;
  }, [derived, document.bodies]);

  const occurrenceCount = document.occurrences.length;
  const instanceCount = derived?.instances.length ?? 0;
  const clearanceText =
    clearance !== null && clearance.ok
      ? Math.min(
          ...clearance.value.samples.map((sample) => sample.clearanceMm),
        ).toFixed(3)
      : "";

  /**
   * Stamps a batch of pattern-generated occurrences onto the document in
   * ONE folded state update (each add sees the previous add's document) and
   * counts only the stamps that landed — the machine surface never counts
   * an action the document refused.
   */
  const stampPattern = (
    label: string,
    placements: readonly PlacementTransform[],
  ): void => {
    let working = document;
    let stamped = 0;
    placements.forEach((placement, index) => {
      const next = addOccurrence(working, {
        id: OccurrenceFixtures.at(`${label}_${String(index + 1)}`),
        name: `pattern ${label} ${String(index + 1)}`,
        source: { kind: "body", bodyId: PLATE_BODY },
        placement: {
          kind: "offset",
          translation: [
            placement.translation[0],
            placement.translation[1],
            placement.translation[2],
          ],
        },
      });
      if (!next.ok) return;
      working = next.value.document;
      stamped += 1;
    });
    if (stamped === 0) return;
    setDocument(working);
    setPatternCount((count) => count + stamped);
  };

  const linearPattern = (): void => {
    const seed = document.occurrences.find(
      (occurrence) => occurrence.id === SEED_ID,
    );
    if (seed === undefined) return;
    const placement = resolveOccurrencePlacement(
      seed.placement,
      document.datums,
    );
    if (!placement.ok) return;
    const resolved = resolveLinearOccurrencePattern({
      seed: placement.value,
      direction: [1, 0, 0],
      count: LINEAR_COUNT,
      spacingMm: LINEAR_STEP_MM,
    });
    if (!resolved.ok) return;
    stampPattern("lin", resolved.value);
  };

  const circularPattern = (): void => {
    const resolved = resolveCircularOccurrencePattern({
      seed: seedAt([LINEAR_STEP_MM, 60, 0]),
      axisOrigin: [240, 60, 0],
      axisDirection: [0, 0, 1],
      count: CIRCULAR_COUNT,
      angleStepDeg: CIRCULAR_STEP_DEG,
    });
    if (!resolved.ok) return;
    // Idempotent authoring: a second click re-resolves the same labels and
    // the document refuses the duplicate ids — nothing double-stamps.
    stampPattern("cir", resolved.value);
  };

  const mirrorLast = (): void => {
    const mirrored = resolveMirroredOccurrencePlacement({
      seed: seedAt([0, 60, 0]),
      planeOrigin: [0, 30, 0],
      planeNormal: [0, 1, 0],
    });
    if (!mirrored.ok) return;
    stampPattern("mir", [mirrored.value]);
  };

  const authorExplode = (): void => {
    // Radial auto-explode 60 mm plus ONE explicit offset (the jointed plate
    // lifts +z regardless) — the precedence rule, authored in one state and
    // carried through the canonical serialize/parse pair.
    const state: AssemblyExplodeState = {
      entries: [
        {
          path: [JOINTED_ID],
          offset: { direction: [0, 0, 1], distanceMm: 40 },
        },
      ],
      radialDistanceMm: 60,
    };
    const serialized = serializeExplodeState(state);
    setExplodeStateJson(JSON.stringify(serialized));
    setExplodeFactor(1);
  };

  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      id="assembly-motion-root"
      data-cad-hydrated={hydrated ? "true" : "false"}
      data-cad-occurrence-count={String(occurrenceCount)}
      data-cad-instance-count={String(instanceCount)}
      data-cad-pattern-count={String(patternCount)}
      data-cad-explode-factor={explodeFactor.toFixed(2)}
      data-cad-explode-active={explodeFactor > 0 ? "true" : "false"}
      data-cad-explode-scene={
        explodeFactor > 0 && derived !== null ? derived.sceneStamp : ""
      }
      data-cad-motion-parameter={motionParameter.toFixed(1)}
      data-cad-motion-scene={derived?.motionStamp ?? ""}
      data-cad-clearance-mm={clearanceText}
      data-cad-stale={staleness.stale ? "true" : "false"}
      data-cad-stale-sources={JSON.stringify(
        staleness.staleSources.map((source) => ({
          source: source.sourceDocumentId,
          revision: source.sourceRevision,
        })),
      )}
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 52 Assemblies fixture — patterns, mirror, explode, motion
        </h1>
        <p className="text-muted-foreground text-sm">
          Component patterns and mirror placements stamp ordinary occurrences;
          the explode state and the revolute joint compose on top of the
          resolved instances; the strip below is the cross-document staleness
          rule. Capabilities: path-driven patterns{" "}
          {ASSEMBLY_PATTERN_CAPABILITIES.pathDriven ? "on" : "off"}, mirrored
          geometry{" "}
          {ASSEMBLY_PATTERN_CAPABILITIES.mirroredGeometry ? "on" : "off"}, joint
          drag {ASSEMBLY_MOTION_CAPABILITIES.dragDriven ? "on" : "off"}.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="motion-linear-pattern"
          onClick={linearPattern}
          type="button"
        >
          Linear pattern ×{String(LINEAR_COUNT)}
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="motion-circular-pattern"
          onClick={circularPattern}
          type="button"
        >
          Circular pattern ×{String(CIRCULAR_COUNT)}
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="motion-mirror"
          onClick={mirrorLast}
          type="button"
        >
          Mirror across plane
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="motion-explode-author"
          onClick={authorExplode}
          type="button"
        >
          Author explode state
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="motion-drag-decline"
          onClick={() => {
            const declined = motionDragDecline({
              occurrenceId: String(JOINTED_ID),
            });
            setDragDecline(declined.ok ? null : declined.error.message);
          }}
          type="button"
        >
          Try joint drag
        </button>
        {dragDecline !== null ? (
          <span
            className="text-destructive text-xs"
            data-testid="motion-drag-decline-text"
          >
            {dragDecline}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Explode</span>
          <input
            aria-label="Explode factor"
            className="w-48"
            data-testid="motion-explode-scrub"
            max="1"
            min="0"
            step="0.01"
            type="range"
            value={explodeFactor}
            onChange={(event) => {
              setExplodeFactor(Number(event.target.value));
            }}
          />
          <span className="font-mono text-xs">{explodeFactor.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Joint (deg)</span>
          <input
            aria-label="Joint parameter"
            className="w-48"
            data-testid="motion-joint-scrub"
            max="90"
            min="-90"
            step="1"
            type="range"
            value={motionParameter}
            onChange={(event) => {
              setMotionParameter(Number(event.target.value));
            }}
          />
          <span className="font-mono text-xs">
            {motionParameter.toFixed(0)}°
          </span>
        </label>
        <span className="text-muted-foreground text-xs">
          clearance floor{" "}
          <span className="font-mono" data-testid="motion-clearance">
            {clearanceText} mm
          </span>
        </span>
      </div>
      <div className="border-border flex flex-wrap items-center gap-2 rounded-md border p-3">
        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Cross-document
        </span>
        <span className="font-mono text-xs">
          assembly rev {String(assemblyRevision)} ← source rev{" "}
          {String(sourceRevision)}
        </span>
        <span
          className="rounded px-2 py-0.5 text-xs font-medium"
          data-testid="motion-stale-badge"
        >
          {staleness.stale ? "STALE" : "up to date"}
        </span>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="motion-edit-source"
          onClick={() => {
            setSourceRevision((revision) => revision + 1);
          }}
          type="button"
        >
          Edit source part
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="motion-regenerate"
          disabled={!staleness.stale}
          onClick={() => {
            setAssemblyRevision(sourceRevision);
          }}
          type="button"
        >
          Regenerate assembly
        </button>
      </div>
      <div className="flex gap-4">
        <CadModelTree
          assembly={{ nodes: assemblyNodes(document) }}
          document={document}
        />
        <CadViewport className="h-[420px] flex-1" projection={projection} />
      </div>
    </div>
  );
}

/** The display name of an occurrence's source, host-resolved for bodies. */
function sourceNameOf(
  document: CadDocument,
  source: CadDocument["occurrences"][number]["source"],
): string {
  if (source.kind === "body") {
    return (
      document.bodies.find((body) => body.id === source.bodyId)?.name ??
      source.bodyId
    );
  }
  return source.kind === "document" ? source.documentId : source.componentId;
}

/** Derives the tree's assembly section from the document's occurrences. */
function assemblyNodes(document: CadDocument): CadModelTreeAssemblyNode[] {
  return document.occurrences.map((occurrence) => ({
    key: occurrence.id,
    label: occurrence.name,
    source: occurrence.source.kind,
    sourceName: sourceNameOf(document, occurrence.source),
    bomFlag: occurrence.bomFlag,
  }));
}
