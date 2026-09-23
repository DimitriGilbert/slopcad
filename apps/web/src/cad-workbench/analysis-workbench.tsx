/**
 * The analysis workbench fixture (Phase 58 round 2): `/workbench-analysis`.
 * The block's remaining analysis consumers drawn END TO END on analytic
 * box/cylinder soups — draft analysis (face classification against a pull
 * datum with the deterministic color bands), curvature display (the 2D
 * sketch comb and the mesh-based surface band), the zebra reflection
 * display mode (the shader-level viewport visual), and the COG marker
 * datum with the document-level material records' mass aggregate.
 *
 * ## The seams (honesty about what computes what)
 *
 * - Draft/band analysis consume the fixture's soups with paired normals;
 *   the classification is cad-core's, the colors are the module's fixed
 *   band constants.
 * - The comb consumes SAMPLES of a planar arc (the seam: a real spline
 *   host substitutes cad-sketch's spline evaluators; the three-point
 *   circumradius math is cad-core's and exactly pins κ = 1/r on circles).
 * - The mass aggregate consumes the fixture's ANALYTIC box volumes and
 *   centroids (the same stand-in kernel measurement the interference
 *   fixture declares) joined to document-level material records — the
 *   consumer layer the block defines; the kernel contract stays
 *   density-free.
 * - Zebra is the display-mode family's opt-in `zebra` mode: a fixed
 *   stripe frequency patched into the surface material, deterministic
 *   given scene state, default raster untouched.
 *
 * Machine surfaces (additive): `data-cad-draft-classes`,
 * `data-cad-draft-faces`, `data-cad-band-census`, `data-cad-comb-max-kappa`,
 * `data-cad-zebra`, `data-cad-mass-g`, `data-cad-cog-mm`, plus the
 * inherited hydration/occurrence/instance stamps.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  analyzeDraft,
  createBodyId,
  createOccurrenceId,
  createRenderProjection,
  documentMassProperties,
  parseMaterialId,
  projectTessellation,
  sketchCurvatureComb,
  surfaceCurvatureBands,
  type DatumVec3,
  type DocumentMaterialRecord,
  type DraftFaceClassification,
  type MassContribution,
  type RenderObject,
  type RenderProjection,
} from "@slopcad/cad-core";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

/** Formats a stamp number — three decimals, the shared readout form. */
function stampNumber(value: number): string {
  return value.toFixed(3);
}

/** An axis-aligned box soup: 24 corners, per-face normals. */
function boxSoup(
  width: number,
  depth: number,
  height: number,
): {
  positions: number[];
  indices: number[];
  normals: number[];
} {
  const x = width;
  const y = depth;
  const z = height;
  const face = (
    quads: [number, number, number][],
    normal: [number, number, number],
  ): { positions: number[]; normals: number[] } => ({
    positions: quads.flat(),
    normals: quads.flatMap(() => normal),
  });
  const corners = {
    min: face(
      [
        [0, 0, 0],
        [x, 0, 0],
        [x, y, 0],
        [0, y, 0],
      ],
      [0, 0, -1],
    ),
    max: face(
      [
        [0, 0, z],
        [x, 0, z],
        [x, y, z],
        [0, y, z],
      ],
      [0, 0, 1],
    ),
  };
  const assembled = [
    corners.min,
    corners.max,
    face(
      [
        [0, 0, 0],
        [x, 0, 0],
        [x, 0, z],
        [0, 0, z],
      ],
      [0, -1, 0],
    ),
    face(
      [
        [0, y, 0],
        [x, y, 0],
        [x, y, z],
        [0, y, z],
      ],
      [0, 1, 0],
    ),
    face(
      [
        [0, 0, 0],
        [0, y, 0],
        [0, y, z],
        [0, 0, z],
      ],
      [-1, 0, 0],
    ),
    face(
      [
        [x, 0, 0],
        [x, y, 0],
        [x, y, z],
        [x, 0, z],
      ],
      [1, 0, 0],
    ),
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of assembled) {
    positions.push(...part.positions);
    normals.push(...part.normals);
  }
  const indices: number[] = [];
  for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
    const base = faceIndex * 4;
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return { positions, indices, normals };
}

/**
 * An open FACETED cylinder wall: `sectors` quads around +z, no caps — the
 * pure "curved" curvature fixture. Each quad's corners carry the quad's
 * mid-sector radial normal (faceted, like a real tessellated wall), so a
 * welded seam vertex holds two normals one sector (15°) apart.
 */
function tubeSoup(
  radius: number,
  height: number,
  sectors: number,
): {
  positions: number[];
  indices: number[];
  normals: number[];
} {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let sector = 0; sector < sectors; sector += 1) {
    const angle0 = (2 * Math.PI * sector) / sectors;
    const angle1 = (2 * Math.PI * (sector + 1)) / sectors;
    const mid = (angle0 + angle1) / 2;
    const normal = [Math.cos(mid), Math.sin(mid), 0];
    const base = sector * 4;
    for (const angle of [angle0, angle1]) {
      positions.push(
        radius * Math.cos(angle),
        radius * Math.sin(angle),
        0,
        radius * Math.cos(angle),
        radius * Math.sin(angle),
        height,
      );
      normals.push(...normal, ...normal);
    }
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return { positions, indices, normals };
}

/**
 * A small octahedron at `center` — the COG marker datum's geometry (six
 * vertices, eight faces, radius 6).
 */
function cogMarkerSoup(center: DatumVec3): {
  positions: number[];
  indices: number[];
  normals: number[];
} {
  const [cx, cy, cz] = center;
  const radius = 6;
  const axis: DatumVec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const vertex: [number, number, number][] = axis.map(([ax, ay, az]) => [
    cx + radius * ax,
    cy + radius * ay,
    cz + radius * az,
  ]);
  const faces: [number, number, number][] = [
    [2, 0, 4],
    [0, 3, 4],
    [3, 1, 4],
    [1, 2, 4],
    [0, 2, 5],
    [3, 0, 5],
    [1, 3, 5],
    [2, 1, 5],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach(([a, b, c], faceIndex) => {
    const pa = vertex[a];
    const pb = vertex[b];
    const pc = vertex[c];
    if (pa === undefined || pb === undefined || pc === undefined) return;
    positions.push(...pa, ...pb, ...pc);
    const ux = pb[0] - pa[0];
    const uy = pb[1] - pa[1];
    const uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0];
    const vy = pc[1] - pa[1];
    const vz = pc[2] - pa[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    // One paired normal PER CORNER — the projection's contract.
    normals.push(
      nx / length,
      ny / length,
      nz / length,
      nx / length,
      ny / length,
      nz / length,
      nx / length,
      ny / length,
      nz / length,
    );
    indices.push(faceIndex * 3, faceIndex * 3 + 1, faceIndex * 3 + 2);
  });
  return { positions, indices, normals };
}

/**
 * The comb's spike soup: one thin world-space triangle per spike (base
 * spread across 1.2 units, tip at the spike end), lying in the z=0
 * plane — the comb drawn as geometry next to its arc.
 */
function combSpikeSoup(
  spikes: readonly {
    readonly base: readonly [number, number];
    readonly tip: readonly [number, number];
  }[],
): { positions: number[]; indices: number[]; normals: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let triangle = 0;
  for (const spike of spikes) {
    const dx = spike.tip[0] - spike.base[0];
    const dy = spike.tip[1] - spike.base[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const halfWidthX = (-dy / length) * 0.6;
    const halfWidthY = (dx / length) * 0.6;
    positions.push(
      spike.base[0] - halfWidthX,
      spike.base[1] - halfWidthY,
      0,
      spike.base[0] + halfWidthX,
      spike.base[1] + halfWidthY,
      0,
      spike.tip[0],
      spike.tip[1],
      0,
    );
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    indices.push(triangle * 3, triangle * 3 + 1, triangle * 3 + 2);
    triangle += 1;
  }
  return { positions, indices, normals };
}

/** Deterministic fixture body ids. */
const DRAFT_BODY = createBodyId("body_analysis_draft");
const TUBE_BODY = createBodyId("body_analysis_tube");
const MARKER_BODY = createBodyId("body_analysis_marker");
const COMB_BODY = createBodyId("body_analysis_comb");

/** The fixture's two mass bodies (mm) and their analytic centroids. */
const MASS_PLATE = {
  extents: [60, 40, 12] as const,
  volumeMm3: 60 * 40 * 12,
  centroid: [30, 20, 6] as DatumVec3,
};
const MASS_CUBE = {
  extents: [30, 30, 30] as const,
  volumeMm3: 30 * 30 * 30,
  centroid: [15, 15, 55] as DatumVec3,
};

/** The document-level material records (the consumer layer's table). */
function buildMaterialRecords(): DocumentMaterialRecord[] {
  const aluminium = parseMaterialId("mat_aluminium");
  const steel = parseMaterialId("mat_steel");
  if (!aluminium.ok || !steel.ok) {
    throw new Error("expected the fixture material ids to parse");
  }
  return [
    { id: aluminium.value, name: "Aluminium", densityGPerCm3: 2.7 },
    { id: steel.value, name: "Steel", densityGPerCm3: 7.85 },
  ];
}

/** The per-occurrence mass contributions (analytic box measurements). */
function buildMassContributions(): MassContribution[] {
  const aluminium = parseMaterialId("mat_aluminium");
  const steel = parseMaterialId("mat_steel");
  if (!aluminium.ok || !steel.ok) {
    throw new Error("expected the fixture material ids to parse");
  }
  return [
    {
      path: [createOccurrenceId("occ_mass_plate")],
      materialId: aluminium.value,
      volumeMm3: MASS_PLATE.volumeMm3,
      centroid: MASS_PLATE.centroid,
    },
    {
      path: [createOccurrenceId("occ_mass_cube")],
      materialId: steel.value,
      volumeMm3: MASS_CUBE.volumeMm3,
      centroid: MASS_CUBE.centroid,
    },
  ];
}

/** The draft analysis' pull datum: straight up the box's height. */
const PULL: DatumVec3 = [0, 0, 1];

/** The comb's sampled arc: radius 30, half circle, 25 samples. */
function arcSamples(): [number, number][] {
  const samples: [number, number][] = [];
  for (let index = 0; index < 25; index += 1) {
    const angle = (Math.PI * index) / 24;
    samples.push([110 + 30 * Math.cos(angle), 20 + 30 * Math.sin(angle)]);
  }
  return samples;
}

/** The comb: derived once from the fixture arc (pure, deterministic). */
const COMB_RESULT = sketchCurvatureComb({
  samples: arcSamples(),
  scale: 12,
});

/** The comb spikes drawn next to the arc (empty when the comb declined). */
const COMB_SPIKES = COMB_RESULT.ok ? COMB_RESULT.value.spikes : [];

/** Composes the fixture's projection: bodies, marker, comb spikes. */
function projectAnalysis(cog: DatumVec3 | undefined): RenderProjection | null {
  const draft = projectTessellation(DRAFT_BODY, boxSoup(60, 40, 12));
  const tube = projectTessellation(
    TUBE_BODY,
    tubeSoup(20, 40, 24),
    undefined,
    true,
  );
  const comb = projectTessellation(
    COMB_BODY,
    combSpikeSoup(COMB_SPIKES),
    undefined,
    true,
  );
  const marker =
    cog === undefined
      ? undefined
      : projectTessellation(MARKER_BODY, cogMarkerSoup(cog));
  const objects: RenderObject[] = [];
  for (const object of [draft, tube, comb, marker]) {
    if (object === undefined) continue;
    if (!object.ok) return null;
    objects.push(object.value);
  }
  if (objects.length === 0) return null;
  const projection = createRenderProjection(objects, {
    kind: "perspective",
    position: [240, -150, 150],
    target: [85, 0, 15],
    up: [0, 0, 1],
    fovDeg: 40,
  });
  return projection.ok ? projection.value : null;
}

export function AnalysisWorkbenchPage(): ReactElement {
  const [hydrated, setHydrated] = useState(false);
  const [zebra, setZebra] = useState(false);
  const [ran, setRan] = useState(false);

  // The page computes nothing at SSR render time beyond the pure
  // derivations below; the hydration stamp flips on mount.
  useEffect(() => {
    setHydrated(true);
  }, []);

  const materials = useMemo(buildMaterialRecords, []);
  const mass = useMemo(
    () =>
      documentMassProperties({
        contributions: buildMassContributions(),
        materialOf: (materialId) =>
          materials.find((record) => record.id === materialId),
      }),
    [materials],
  );
  const draft = useMemo(
    () => analyzeDraft({ mesh: boxSoup(60, 40, 12), pull: PULL }),
    [],
  );
  const bands = useMemo(() => {
    const tube = tubeSoup(20, 40, 24);
    return surfaceCurvatureBands(tube);
  }, []);

  const projection = useMemo(
    () => projectAnalysis(mass.ok ? mass.value.centerOfGravity : undefined),
    [mass],
  );

  const runAnalysis = (): void => {
    setRan(true);
  };

  const draftClassStamp = (classes: {
    readonly [key: string]: number;
  }): string =>
    (["positive", "negative", "vertical", "undercut"] as const)
      .map(
        (classification) => `${classification}=${classes[classification] ?? 0}`,
      )
      .join("|");

  const draftCounts = useMemo(() => {
    const counts: Record<DraftFaceClassification, number> = {
      positive: 0,
      negative: 0,
      vertical: 0,
      undercut: 0,
    };
    if (draft.ok) {
      for (const face of draft.value.faces) {
        counts[face.classification] += 1;
      }
    }
    return counts;
  }, [draft]);

  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      id="analysis-workbench-root"
      data-cad-hydrated={hydrated ? "true" : "false"}
      data-cad-instance-count={String(
        projection === null ? 0 : projection.objects.length,
      )}
      data-cad-draft-classes={
        ran && draft.ok ? draftClassStamp(draftCounts) : "none"
      }
      data-cad-draft-faces={
        ran && draft.ok ? String(draft.value.faces.length) : "none"
      }
      data-cad-band-census={
        ran && bands.ok
          ? bands.value.census
              .map((entry) => `${entry.band}=${entry.vertices}`)
              .join("|")
          : "none"
      }
      data-cad-comb-max-kappa={
        COMB_RESULT.ok ? stampNumber(COMB_RESULT.value.maxCurvature) : "none"
      }
      data-cad-zebra={zebra ? "on" : "off"}
      data-cad-mass-g={mass.ok ? stampNumber(mass.value.massGrams) : "none"}
      data-cad-cog-mm={
        mass.ok ? mass.value.centerOfGravity.map(stampNumber).join("|") : "none"
      }
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 58 analysis fixture — draft, curvature, zebra, COG/mass
        </h1>
        <p className="text-muted-foreground text-sm">
          A draft box, an open tube, a curvature comb arc, and a two-material
          mass compound with its COG marker.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="analysis-run"
          onClick={runAnalysis}
          type="button"
        >
          Run draft &amp; curvature analysis
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="analysis-zebra-toggle"
          onClick={() => setZebra((current) => !current)}
          type="button"
        >
          {zebra ? "Shaded view" : "Zebra view"}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section
          className="border-border rounded-md border p-4"
          data-testid="analysis-draft-panel"
        >
          <h2 className="text-sm font-semibold">Draft analysis</h2>
          {ran && draft.ok ? (
            <ul className="mt-2 space-y-1 text-sm">
              {draft.value.faces.map((face) => (
                <li
                  className="flex items-center gap-2"
                  key={`${face.normal[0]}/${face.normal[1]}/${face.normal[2]}`}
                >
                  <span
                    aria-hidden
                    className="border-border inline-block h-3 w-3 rounded-sm border"
                    style={{ background: face.colorHex }}
                  />
                  <span className="w-16">{face.classification}</span>
                  <span className="text-muted-foreground">
                    {stampNumber(face.angleDeg)}° from pull · {face.cornerCount}{" "}
                    corners
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-2 text-sm">
              {ran
                ? "The draft analysis declined the soup."
                : "No draft report yet — run the analysis."}
            </p>
          )}
        </section>
        <section
          className="border-border rounded-md border p-4"
          data-testid="analysis-curvature-panel"
        >
          <h2 className="text-sm font-semibold">Curvature</h2>
          {ran && bands.ok ? (
            <div className="mt-2 space-y-2 text-sm">
              <ul className="space-y-1">
                {bands.value.census.map((entry) => (
                  <li className="flex items-center gap-2" key={entry.band}>
                    <span
                      aria-hidden
                      className="border-border inline-block h-3 w-3 rounded-sm border"
                      style={{ background: entry.colorHex }}
                    />
                    <span className="w-14">{entry.band}</span>
                    <span className="text-muted-foreground">
                      {entry.vertices} welded vertices
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                Comb over the r=30 arc: max |κ| ={" "}
                {COMB_RESULT.ok
                  ? stampNumber(COMB_RESULT.value.maxCurvature)
                  : "declined"}{" "}
                (1/mm), expected 0.033 — the three-point circumradius is exact
                on circles.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground mt-2 text-sm">
              {ran
                ? "The curvature analysis declined the inputs."
                : "No curvature report yet — run the analysis."}
            </p>
          )}
        </section>
        <section
          className="border-border rounded-md border p-4 lg:col-span-2"
          data-testid="analysis-mass-panel"
        >
          <h2 className="text-sm font-semibold">
            Mass properties — material records
          </h2>
          {mass.ok ? (
            <div className="mt-2 space-y-1 text-sm">
              {mass.value.contributions.map((contribution) => (
                <p key={contribution.path.join("/")}>
                  {contribution.path.join("/")}:{" "}
                  {stampNumber(contribution.massGrams)} g
                </p>
              ))}
              <p className="font-medium">
                Total mass {stampNumber(mass.value.massGrams)} g · COG (
                {mass.value.centerOfGravity.map(stampNumber).join(", ")}) mm
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground mt-2 text-sm">
              The mass aggregate declined — {mass.error.code}
            </p>
          )}
        </section>
      </div>
      <CadViewport
        className="h-[420px]"
        displayMode={zebra ? "zebra" : "shaded"}
        projection={projection}
      />
    </div>
  );
}
