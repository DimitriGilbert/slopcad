/**
 * The assembly workbench fixture (Phase 50): `/workbench-assembly`. The
 * assembly-as-document pipeline drawn END TO END with no kernel and no
 * worker — the geometry is a static analytic box soup, but every other
 * hop is the REAL boundary:
 *
 * - the document carries its bodies and component occurrences through the
 *   cad-core add doors (`addBody`/`addOccurrence`);
 * - `resolveAssemblyInstances` walks the occurrence tree and composes
 *   placements (the fixed outermost-first path order);
 * - `projectPlacedInstance` attaches each instance's path and transform
 *   to the shared source soup (world bounds, verbatim positions);
 * - `CadModel` applies the transforms as mesh matrices and
 *   `CadModelTree` renders the occurrence tree with its BOM chips.
 *
 * The instance list is the document's: the Add/Remove buttons mutate the
 * document through the same structured doors (`addOccurrence` /
 * `removeOccurrence`), and the viewport/tree re-derive. This page is the
 * Phase 50 machine surface: `data-cad-instance-count` (placed instances
 * the projection carries), `data-cad-occurrence-count` (document
 * records), and the settled-frame stamp.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  addBody,
  addOccurrence,
  createBodyId,
  createDocument,
  createDocumentId,
  createOccurrenceId,
  createRenderProjection,
  parsePlacementTransform,
  projectPlacedInstance,
  projectTessellation,
  removeOccurrence,
  resolveAssemblyInstances,
  type CadDocument,
  type OccurrenceId,
  type RenderProjection,
} from "@slopcad/cad-core";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import {
  CadModelTree,
  type CadModelTreeAssemblyNode,
} from "@slopcad/ui/components/cad/cad-model-tree";

/** The unit-cube soup every instance shares (24 verts would be nicer; a
 * single triangles soup is enough to SEE placement). */
const BOX_TESSELLATION = {
  // 24 vertices: four per face, each carrying its face normal (the
  // projection's paired-unit-normal contract).
  positions: [
    // -z face
    0, 0, 0, 60, 0, 0, 60, 40, 0, 0, 40, 0,
    // +z face
    0, 0, 12, 60, 0, 12, 60, 40, 12, 0, 40, 12,
    // -y face
    0, 0, 0, 60, 0, 0, 60, 0, 12, 0, 0, 12,
    // +y face
    0, 40, 0, 60, 40, 0, 60, 40, 12, 0, 40, 12,
    // -x face
    0, 0, 0, 0, 40, 0, 0, 40, 12, 0, 0, 12,
    // +x face
    60, 0, 0, 60, 40, 0, 60, 40, 12, 60, 0, 12,
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

/** Deterministic identity of the fixture's single source body. */
const PLATE_BODY = createBodyId("body_plate");

/** The per-instance placement step: each new instance shifts +80 mm in x. */
const INSTANCE_STEP_X_MM = 80;

/**
 * Deterministic explicit occurrence ids for the fixture (no generator
 * coupling): `occ_assembly_1..n`.
 */
const OccurrenceIdFixture = {
  first: (): OccurrenceId => OccurrenceIdFixture.at(1),
  at: (index: number): OccurrenceId =>
    createOccurrenceId(`occ_assembly_${String(index)}`),
};

/** Builds the fixture document: one body, one default-placed occurrence. */
function buildInitialDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_assembly_fixture"));
  const body = addBody(document, { id: PLATE_BODY, name: "plate" });
  if (!body.ok) throw new Error("expected the plate body to add");
  document = body.value.document;
  const first = addOccurrence(document, {
    id: OccurrenceIdFixture.first(),
    name: "plate instance 1",
    source: { kind: "body", bodyId: PLATE_BODY },
  });
  if (!first.ok) throw new Error("expected the first occurrence to add");
  return first.value.document;
}

/** The projection: the direct body render plus every placed instance. */
function projectAssembly(document: CadDocument): RenderProjection | null {
  const base = projectTessellation(PLATE_BODY, BOX_TESSELLATION);
  if (!base.ok) return null;
  const resolution = resolveAssemblyInstances(document);
  if (!resolution.ok) return null;
  const objects = [base.value];
  for (const instance of resolution.instances) {
    // The boundary stays honest even though the fixture's placements are
    // identity/offsets: the composed transform is validated at parse.
    const transform = parsePlacementTransform(instance.transform);
    if (!transform.ok) return null;
    const placed = projectPlacedInstance(
      base.value,
      instance.path,
      transform.value,
    );
    if (!placed.ok) return null;
    objects.push(placed.value);
  }
  const projection = createRenderProjection(objects, {
    kind: "perspective",
    position: [220, -260, 220],
    target: [140, 20, 0],
    up: [0, 0, 1],
    fovDeg: 40,
  });
  return projection.ok ? projection.value : null;
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

export function AssemblyWorkbenchPage(): ReactElement {
  const [document, setDocument] = useState<CadDocument>(buildInitialDocument);
  const [hydrated, setHydrated] = useState(false);
  const projection = useMemo(() => projectAssembly(document), [document]);
  const occurrenceCount = document.occurrences.length;

  // The machine-visible hydration stamp: the Add/Remove buttons only work
  // once React owns the DOM, so the e2e journey waits for this flag
  // instead of racing the click against hydration.
  useEffect(() => {
    setHydrated(true);
  }, []);

  const addInstance = (): void => {
    const next = addOccurrence(document, {
      id: OccurrenceIdFixture.at(occurrenceCount + 1),
      name: `plate instance ${occurrenceCount + 1}`,
      source: { kind: "body", bodyId: PLATE_BODY },
      placement: {
        kind: "offset",
        translation: [INSTANCE_STEP_X_MM * occurrenceCount, 0, 0],
      },
      bomFlag: occurrenceCount % 2 === 0 ? "phantom" : undefined,
    });
    if (next.ok) setDocument(next.value.document);
  };

  const removeLastInstance = (): void => {
    const last = document.occurrences[document.occurrences.length - 1];
    if (last === undefined) return;
    const next = removeOccurrence(document, last.id);
    if (next.ok) setDocument(next.value);
  };

  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      id="assembly-workbench-root"
      data-cad-hydrated={hydrated ? "true" : "false"}
      data-cad-occurrence-count={String(occurrenceCount)}
      data-cad-instance-count={String(
        projection === null
          ? 0
          : projection.objects.filter(
              (object) => object.occurrencePath !== undefined,
            ).length,
      )}
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 50 Assemblies fixture — instances, placements, BOM flags
        </h1>
        <p className="text-muted-foreground text-sm">
          One plate body, its occurrences placed along +x. Add and remove
          instances; the tree and the viewport derive from the document.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="assembly-add-instance"
          onClick={addInstance}
          type="button"
        >
          Add instance
        </button>
        <button
          className="border-border rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="assembly-remove-instance"
          disabled={occurrenceCount === 0}
          onClick={removeLastInstance}
          type="button"
        >
          Remove last instance
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
