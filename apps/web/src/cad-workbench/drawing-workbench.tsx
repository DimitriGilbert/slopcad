/**
 * The drawing workbench (Phase 53 — Drawings I; Phase 55 — Drawings III):
 * the sheet-and-view authoring page.
 *
 * Phase 55 extends the Phase 53 sheet/base-view workflow with the full
 * derived-view vocabulary — fold-line projected views (left/back/bottom of
 * a parent), an auxiliary view from the demo boss's inclined edge, a full
 * section through the demo plane (hatched), a detail crop at 2:1, and a
 * broken-out band — plus BOM tables derived from the demo assembly's
 * occurrence structure (phantom rows dissolve, purchased rows keep their
 * flag, quantities group by name) and balloons keyed to those items.
 *
 * Every output path runs through cad-core's byte-deterministic exporters:
 * the canvas renders `serializeDrawingSvg`, and the download affordances
 * emit the same SVG plus the PDF and DXF writers' bytes — what is on
 * screen and what exports are one picture.
 *
 * Persistence rides the native envelope's additive-optional `drawing`
 * field through the documents tRPC router (the Phase 53 deferred wiring):
 * Save serializes the drawing into a minimal native document and appends a
 * version; Load restores the drawing from the latest version. The work
 * is client-authored; the server re-validates with the same parser.
 */

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  alignedViewPlacement,
  createBodyId,
  createDrawingViewId,
  createDocumentId,
  createOccurrenceId,
  createSheetId,
  type DrawingBalloon,
  type DrawingDocument,
  type DrawingProjectionAngle,
  type DrawingScale,
  type DrawingSheet,
  type DrawingSheetOrientation,
  type DrawingSheetSize,
  type DrawingView,
  type DrawingViewGeometry,
  type DrawingViewKind,
  DRAWING_SCALES,
  DRAWING_SHEET_SIZE_NAMES,
  DRAWING_VIEW_KINDS,
  type DrawingGeometryByView,
  edgesOverlayProjectionForKind,
  createDocument,
  createNativeCadDocument,
  numberBomItems,
  parseNativeCadDocumentFromString,
  serializeDrawingDxf,
  serializeDrawingPdf,
  serializeDrawingSvg,
  stringifyNativeCadDocument,
  serializeNativeCadDocument,
  drawingSummary,
  sheetDimensions,
  viewFitsSheet,
  viewFrameFromGeometry,
} from "@slopcad/cad-core";
import { Button } from "@slopcad/ui/components/button";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";

import {
  DEMO_AUX_EDGE,
  DEMO_BREAKOUT_BAND,
  DEMO_HATCH_SPACING_MM,
  DEMO_SECTION_PLANE,
  deriveSheetGeometry,
} from "./drawing-derive";
import {
  DEMO_ASSEMBLY_OCCURRENCES,
  DEMO_PLATE_MESH,
} from "./drawing-demo-body";

import { useTRPC } from "@/utils/trpc";

type SheetFormValues = {
  size: DrawingSheetSize;
  orientation: DrawingSheetOrientation;
  scaleIndex: string;
};

const SHEET_DEFAULTS: SheetFormValues = {
  size: "A3",
  orientation: "landscape",
  // Select option values are strings (Formedible serializes them) — the
  // default must match or the trigger renders blank on load.
  scaleIndex: "3",
};

/** Aligned-view gap between frames, sheet millimetres. */
const VIEW_GAP_MM = 15;

const DEMO_BODY_ID = createBodyId("body_drawing_plate");

const viewFrameOf = (
  view: DrawingView,
  sheet: DrawingSheet,
  geometry: DrawingViewGeometry | undefined,
): { readonly width: number; readonly height: number } | null => {
  if (geometry === undefined || geometry.bounds === null) return null;
  const frame = viewFrameFromGeometry(view, sheet, geometry.bounds);
  return frame === null ? null : { width: frame.width, height: frame.height };
};

/** Triggers a client download of a deterministic text artifact. */
function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Formats a sheet millimetre length for the @page rule: no exponent. */
const formatMm = (value: number): string => value.toFixed(2);

export function DrawingWorkbenchPage(): ReactElement {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [drawing, setDrawing] = useState<DrawingDocument>({ sheets: [] });
  const [angle, setAngle] = useState<DrawingProjectionAngle>("third");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [status, setStatus] = useState(
    "No sheets yet. Sheets, views, BOM tables, and balloons author here; Save persists the drawing into a document.",
  );

  const geometryByView = useMemo<DrawingGeometryByView>(() => {
    const sheet = drawing.sheets[0];
    if (sheet === undefined) return new Map();
    return deriveSheetGeometry(sheet, DEMO_PLATE_MESH);
  }, [drawing]);

  const svg = useMemo(
    () => serializeDrawingSvg(drawing, geometryByView),
    [drawing, geometryByView],
  );

  const createSheet = useCallback(
    (values: SheetFormValues) => {
      const scale: DrawingScale =
        DRAWING_SCALES[Number(values.scaleIndex)] ?? DRAWING_SCALES[3];
      if (scale === undefined) return;
      const id = createSheetId(`sht_sheet-${drawing.sheets.length + 1}`);
      setDrawing((previous) => ({
        sheets: [
          ...previous.sheets,
          {
            id,
            size: values.size,
            orientation: values.orientation,
            scale,
            views: [],
          },
        ],
      }));
      setStatus(
        `Sheet ${id} created (${values.size}, ${scale.numerator}:${scale.denominator}).`,
      );
    },
    [drawing.sheets.length],
  );

  const sheetFields = useMemo<
    readonly FormedibleFieldConfig<SheetFormValues>[]
  >(
    () => [
      {
        name: "size",
        type: "select",
        label: "Sheet size",
        required: true,
        options: DRAWING_SHEET_SIZE_NAMES.map((size) => ({
          value: size,
          label: size,
        })),
      },
      {
        name: "orientation",
        type: "select",
        label: "Orientation",
        required: true,
        options: [
          { value: "landscape", label: "Landscape" },
          { value: "portrait", label: "Portrait" },
        ],
      },
      {
        name: "scaleIndex",
        type: "select",
        label: "Scale",
        required: true,
        options: DRAWING_SCALES.map((scale, index) => ({
          value: String(index),
          label: `${scale.numerator}:${scale.denominator}`,
        })),
      },
    ],
    [],
  );

  const sheetForm = useFormedible<SheetFormValues>({
    fields: sheetFields,
    formOptions: {
      defaultValues: SHEET_DEFAULTS,
      onSubmit: ({ value }) => {
        createSheet({
          size: value.size,
          orientation: value.orientation,
          scaleIndex: String(value.scaleIndex),
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: "Create sheet",
  });

  const addBaseView = useCallback(
    (kind: DrawingViewKind) => {
      // Placement is computed inside the updater so batched clicks (a fast
      // keyboard user, scripted drives) still read the FRESH view list —
      // each view counts against the views that are actually on the sheet.
      setDrawing((previous) => {
        const sheet = previous.sheets[0];
        if (sheet === undefined) return previous;
        const id = createDrawingViewId(`dwv_${kind}`);
        const geometry = new Map<string, DrawingViewGeometry>([
          [id, edgesOverlayProjectionForKind(DEMO_PLATE_MESH, kind)],
        ]);
        const placeholder: DrawingView = {
          id,
          kind,
          bodyId: DEMO_BODY_ID,
          x: 0,
          y: 0,
          scale: null,
          alignedTo: null,
        };
        const size = viewFrameOf(placeholder, sheet, geometry.get(id));
        const front = sheet.views.find((view) => view.kind === "front") ?? null;
        const frontSize =
          front === null
            ? null
            : viewFrameOf(
                front,
                sheet,
                edgesOverlayProjectionForKind(DEMO_PLATE_MESH, "front"),
              );
        let placement: {
          x: number;
          y: number;
          alignedTo: DrawingView["id"] | null;
        };
        if (
          (kind === "top" || kind === "right") &&
          front !== null &&
          size !== null
        ) {
          const next = alignedViewPlacement(
            kind,
            front,
            angle,
            frontSize ?? size,
            size,
            VIEW_GAP_MM,
          );
          placement = { x: next.x, y: next.y, alignedTo: front.id };
        } else {
          const count = sheet.views.length;
          placement = {
            x: 90 + (count % 2) * 90,
            y: 140 + Math.floor(count / 2) * 80,
            alignedTo: null,
          };
        }
        const view: DrawingView = { ...placeholder, ...placement };
        setStatus(
          size !== null &&
            !viewFitsSheet(
              { x: view.x, y: view.y, width: size.width, height: size.height },
              sheet,
            )
            ? `View ${kind} placed, but its frame crosses the 10 mm sheet border.`
            : `View ${kind} placed.`,
        );
        return {
          sheets: previous.sheets.map((s) =>
            s.id === sheet.id ? { ...s, views: [...s.views, view] } : s,
          ),
        };
      });
    },
    [angle],
  );

  const addDerivedView = useCallback(
    (
      kind: DrawingViewKind,
      build: (parent: DrawingView) => {
        readonly label: string;
        readonly scale?: DrawingScale;
        readonly projection: DrawingView["projection"];
      },
      freeSlot: number,
      verb: string,
    ): void => {
      setDrawing((previous) => {
        const sheet = previous.sheets[0];
        if (sheet === undefined) {
          setStatus("Create a sheet first.");
          return previous;
        }
        const parent = sheet.views.find((view) => view.kind === "front");
        if (parent === undefined) {
          setStatus(
            `${verb} needs a Front view as its parent — add one first.`,
          );
          return previous;
        }
        const extra = build(parent);
        const view: DrawingView = {
          id: createDrawingViewId(
            `dwv_${extra.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
          ),
          kind,
          bodyId: DEMO_BODY_ID,
          // Derived views occupy a dedicated right-hand band of the sheet,
          // clear of the base-view cluster (front at ~(90, 140) plus its
          // aligned top/right neighbours).
          x: 210 + (freeSlot % 2) * 100,
          y: 60 + Math.floor(freeSlot / 2) * 90,
          scale: extra.scale ?? null,
          alignedTo: null,
          label: extra.label,
          ...(extra.projection === undefined
            ? {}
            : { projection: extra.projection }),
        };
        const geometry = deriveSheetGeometry(
          { ...sheet, views: [...sheet.views, view] },
          DEMO_PLATE_MESH,
        );
        const size = viewFrameOf(view, sheet, geometry.get(view.id));
        setStatus(
          size !== null &&
            !viewFitsSheet(
              { x: view.x, y: view.y, width: size.width, height: size.height },
              sheet,
            )
            ? `${verb} placed, but its frame crosses the 10 mm sheet border.`
            : `${verb} placed.`,
        );
        return {
          sheets: previous.sheets.map((s) =>
            s.id === sheet.id ? { ...s, views: [...s.views, view] } : s,
          ),
        };
      });
    },
    [],
  );

  const addBomTable = useCallback((): void => {
    // Status is set inside the updater (the addBaseView convention): the
    // updater is the only place the FRESH sheet list is readable, so a
    // success/failure message decided outside it can lie under batching.
    setDrawing((previous) => {
      const sheet = previous.sheets[0];
      if (sheet === undefined) {
        setStatus("Create a sheet first.");
        return previous;
      }
      setStatus(
        "BOM table added: items numbered from the demo assembly (phantom rows dissolve, quantities group).",
      );
      return {
        sheets: previous.sheets.map((s) =>
          s.id === sheet.id
            ? {
                ...s,
                bomTables: [
                  ...(s.bomTables ?? []),
                  {
                    x: 24,
                    y: 24,
                    title: "PARTS LIST",
                    rows: numberBomItems(DEMO_ASSEMBLY_OCCURRENCES),
                  },
                ],
              }
            : s,
        ),
      };
    });
  }, []);

  const addBalloon = useCallback((): void => {
    setDrawing((previous) => {
      const sheet = previous.sheets[0];
      if (sheet === undefined) {
        setStatus("Create a sheet first.");
        return previous;
      }
      const target = sheet.views[0];
      if (target === undefined) {
        setStatus("Add a view first — the balloon's leader needs a target.");
        return previous;
      }
      const balloon: DrawingBalloon = {
        occurrenceId: createOccurrenceId("occ_plate"),
        x: target.x + 24,
        y: target.y + 24,
        leaderX: target.x,
        leaderY: target.y,
        viewId: target.id,
      };
      setStatus(
        "Balloon added for the plate occurrence (item number resolves from the BOM table).",
      );
      return {
        sheets: previous.sheets.map((s) =>
          s.id === sheet.id
            ? { ...s, balloons: [...(s.balloons ?? []), balloon] }
            : s,
        ),
      };
    });
  }, []);

  // --- Persistence (the Phase 53 deferred per-document wiring) ----------

  const { mutate: saveMutate } = useMutation(
    trpc.documents.save.mutationOptions({
      onSuccess: (result) => {
        setStatus(`Drawing saved as version ${String(result.version)}.`);
        void queryClient.invalidateQueries({
          queryKey: trpc.documents.get.queryOptions({
            documentId: result.documentId,
          }).queryKey,
        });
      },
      onError: (error) => {
        setStatus(`Save refused: ${error.message}`);
      },
    }),
  );

  const createDocumentMutation = useMutation(
    trpc.documents.create.mutationOptions({
      onSuccess: (row) => {
        setDocumentId(row.id);
        saveNative(row.id);
      },
      onError: (error) => {
        setStatus(`Save refused: ${error.message}`);
      },
    }),
  );

  const createProjectMutation = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: (project) => {
        createDocumentMutation.mutate({
          projectId: project.id,
          name: "Drawings",
        });
      },
      onError: (error) => {
        setStatus(`Save refused: ${error.message}`);
      },
    }),
  );

  // Wrapped in useCallback so the save wiring downstream stays referentially
  // quiet between edits — `mutate` itself is stable, `drawing` is the payload.
  const saveNative = useCallback(
    (targetDocumentId: string): void => {
      const created = createNativeCadDocument(
        createDocument(createDocumentId("doc_drawings")),
      );
      if (!created.ok) {
        setStatus(`Save refused: ${created.error.message}`);
        return;
      }
      const native = { ...created.value, drawing };
      // `mutate` is TanStack Query's stable trigger — the only piece of the
      // mutation object the wiring needs.
      saveMutate({
        documentId: targetDocumentId,
        nativeContent: stringifyNativeCadDocument(
          serializeNativeCadDocument(native),
        ),
      });
    },
    [drawing, saveMutate],
  );

  const handleSave = useCallback((): void => {
    if (drawing.sheets.length === 0) {
      setStatus("Nothing to save — create a sheet first.");
      return;
    }
    setStatus("Persisting…");
    void (async () => {
      try {
        const projects = await queryClient.fetchQuery(
          trpc.projects.list.queryOptions(),
        );
        const project = projects[0];
        if (project === undefined) {
          createProjectMutation.mutate({ name: "Drawings" });
          return;
        }
        const documents = await queryClient.fetchQuery(
          trpc.documents.list.queryOptions({ projectId: project.id }),
        );
        const existing = documents.find(
          (document) => document.name === "Drawings",
        );
        if (existing === undefined) {
          createDocumentMutation.mutate({
            projectId: project.id,
            name: "Drawings",
          });
          return;
        }
        setDocumentId(existing.id);
        saveNative(existing.id);
      } catch (error) {
        setStatus(
          `Save needs a signed-in session: ${
            error instanceof Error ? error.message : "unauthorized"
          }`,
        );
      }
    })();
    // saveNative closes over the drawing, so it re-forms with each edit.
  }, [
    drawing,
    trpc,
    queryClient,
    saveNative,
    createProjectMutation,
    createDocumentMutation,
  ]);

  const handleLoad = useCallback((): void => {
    if (documentId === null) {
      setStatus(
        "Nothing loaded yet — Save first to create the drawing document.",
      );
      return;
    }
    setStatus("Loading…");
    void (async () => {
      try {
        const data = await queryClient.fetchQuery(
          trpc.documents.get.queryOptions({ documentId }),
        );
        if (data.latest === null) {
          setStatus("The document has no saved versions yet.");
          return;
        }
        const parsed = parseNativeCadDocumentFromString(
          data.latest.nativeContent,
        );
        if (!parsed.ok) {
          setStatus(
            `The saved document failed to load: ${parsed.error.message}`,
          );
          return;
        }
        if (parsed.value.drawing === null) {
          setStatus("The saved document carries no drawing.");
          return;
        }
        setDrawing(parsed.value.drawing);
        setStatus(
          `Drawing loaded from version ${String(data.latest.version)}.`,
        );
      } catch (error) {
        setStatus(
          `Load needs a signed-in session: ${
            error instanceof Error ? error.message : "unauthorized"
          }`,
        );
      }
    })();
  }, [documentId, trpc, queryClient]);

  // --- Deterministic downloads ------------------------------------------

  const exportSvg = useCallback((): void => {
    download("drawing.svg", svg, "image/svg+xml");
    setStatus("Drawing exported as SVG (deterministic bytes).");
  }, [svg]);

  const exportPdf = useCallback((): void => {
    download(
      "drawing.pdf",
      serializeDrawingPdf(drawing, geometryByView),
      "application/pdf",
    );
    setStatus("Drawing exported as PDF (deterministic vector bytes).");
  }, [drawing, geometryByView]);

  const exportDxf = useCallback((): void => {
    download(
      "drawing.dxf",
      serializeDrawingDxf(drawing, geometryByView),
      "application/dxf",
    );
    setStatus(
      "Drawing exported as DXF (LINE/CIRCLE/TEXT subset, round-trips).",
    );
  }, [drawing, geometryByView]);

  // Print layout: the @page box is the first sheet's exact ISO 216 size in
  // millimetres, so the browser prints the drawing 1:1 — sheet millimetres
  // are the SVG's user units, so no scaling decision is made here.
  const printPageStyle = useMemo(() => {
    const sheet = drawing.sheets[0];
    const { width, height } =
      sheet === undefined
        ? { width: 297, height: 210 }
        : sheetDimensions(sheet);
    return `@page { size: ${formatMm(width)}mm ${formatMm(height)}mm; margin: 0; }`;
  }, [drawing]);

  const handlePrint = useCallback((): void => {
    if (drawing.sheets.length === 0) {
      setStatus("Nothing to print — create a sheet first.");
      return;
    }
    setStatus("Printing: one sheet per page at its exact ISO 216 size.");
    window.print();
  }, [drawing]);

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8 print:max-w-none print:px-0 print:py-0">
      <style dangerouslySetInnerHTML={{ __html: printPageStyle }} />
      <header className="flex flex-col gap-1 print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">Drawings</h1>
        <p className="text-sm text-muted-foreground">
          Sheets, derived views, and callouts. Views of the demo plate project
          through the edges-overlay fallback — labelled as such, no hidden-line
          removal; sections hatch their cut faces, details crop at 2:1, and the
          BOM numbers itself deterministically from the demo assembly structure.
          Exports (SVG/PDF/DXF) are byte-deterministic.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr] print:block">
        <aside className="flex flex-col gap-6 print:hidden">
          <section
            aria-labelledby="dw-sheet-heading"
            className="rounded-lg border p-4"
          >
            <h2 id="dw-sheet-heading" className="mb-3 text-sm font-semibold">
              New sheet
            </h2>
            <sheetForm.Form
              aria-label="New sheet"
              className="space-y-3"
              noValidate
            />
          </section>
          <section
            aria-labelledby="dw-view-heading"
            className="rounded-lg border p-4"
          >
            <h2 id="dw-view-heading" className="mb-3 text-sm font-semibold">
              Add base view
            </h2>
            <fieldset className="mb-3">
              <legend className="mb-1 text-xs text-muted-foreground">
                Projection angle
              </legend>
              <div className="flex gap-2">
                {(["third", "first"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={angle === value ? "default" : "outline"}
                    size="sm"
                    aria-pressed={angle === value}
                    onClick={() => setAngle(value)}
                  >
                    {value === "third" ? "Third angle" : "First angle"}
                  </Button>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-2">
              {DRAWING_VIEW_KINDS.map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  onClick={() => addBaseView(kind)}
                >
                  {kind === "isometric"
                    ? "Isometric"
                    : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`}
                </Button>
              ))}
            </div>
          </section>
          <section
            aria-labelledby="dw-derived-heading"
            className="rounded-lg border p-4"
          >
            <h2 id="dw-derived-heading" className="mb-3 text-sm font-semibold">
              Derived views (from Front)
            </h2>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addDerivedView(
                    "front",
                    (parent) => ({
                      label: "Left",
                      projection: {
                        method: "projected" as const,
                        parentViewId: parent.id,
                        direction: "left" as const,
                      },
                    }),
                    0,
                    "Projected left view",
                  )
                }
              >
                Projected left
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addDerivedView(
                    "front",
                    (parent) => ({
                      label: "Back",
                      projection: {
                        method: "projected" as const,
                        parentViewId: parent.id,
                        direction: "back" as const,
                      },
                    }),
                    1,
                    "Projected back view",
                  )
                }
              >
                Projected back
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addDerivedView(
                    "front",
                    () => ({
                      label: "SECTION A-A",
                      projection: {
                        method: "section" as const,
                        planeOrigin: DEMO_SECTION_PLANE.origin,
                        planeNormal: DEMO_SECTION_PLANE.normal,
                        keepSide: 1 as const,
                        hatchSpacingMm: DEMO_HATCH_SPACING_MM,
                        hatchAngleRad: Math.PI / 4,
                      },
                    }),
                    2,
                    "Section view",
                  )
                }
              >
                Section A-A
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addDerivedView(
                    "front",
                    (parent) => ({
                      label: "DETAIL B (2:1)",
                      scale: { numerator: 2, denominator: 1 },
                      projection: {
                        method: "detail" as const,
                        parentViewId: parent.id,
                        centreU: 30,
                        centreV: 17,
                        radiusMm: 12,
                      },
                    }),
                    3,
                    "Detail view",
                  )
                }
              >
                Detail B
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addDerivedView(
                    "top",
                    (parent) => ({
                      label: "Broken-out C-C",
                      projection: {
                        method: "broken-out" as const,
                        parentViewId: parent.id,
                        bandMinU: DEMO_BREAKOUT_BAND.minU,
                        bandMaxU: DEMO_BREAKOUT_BAND.maxU,
                        planeOrigin: DEMO_SECTION_PLANE.origin,
                        planeNormal: DEMO_SECTION_PLANE.normal,
                        keepSide: 1 as const,
                        hatchSpacingMm: DEMO_HATCH_SPACING_MM,
                      },
                    }),
                    4,
                    "Broken-out section",
                  )
                }
              >
                Broken-out
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addDerivedView(
                    "front",
                    (parent) => ({
                      label: "AUX D",
                      projection: {
                        method: "auxiliary" as const,
                        parentViewId: parent.id,
                        edgeFrom: DEMO_AUX_EDGE.edgeFrom,
                        edgeTo: DEMO_AUX_EDGE.edgeTo,
                      },
                    }),
                    5,
                    "Auxiliary view",
                  )
                }
              >
                Auxiliary D
              </Button>
            </div>
          </section>
          <section
            aria-labelledby="dw-callout-heading"
            className="rounded-lg border p-4"
          >
            <h2 id="dw-callout-heading" className="mb-3 text-sm font-semibold">
              Callouts
            </h2>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addBomTable}
              >
                Add BOM table
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addBalloon}
              >
                Add balloon
              </Button>
            </div>
          </section>
          <section
            aria-labelledby="dw-persist-heading"
            className="rounded-lg border p-4"
          >
            <h2 id="dw-persist-heading" className="mb-3 text-sm font-semibold">
              Document
            </h2>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={handleSave}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleLoad}
              >
                Load
              </Button>
            </div>
          </section>
          <section
            aria-labelledby="dw-export-heading"
            className="rounded-lg border p-4"
          >
            <h2 id="dw-export-heading" className="mb-3 text-sm font-semibold">
              Export
            </h2>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={exportSvg}
              >
                SVG
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={exportPdf}
              >
                PDF
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={exportDxf}
              >
                DXF
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handlePrint}
              >
                Print
              </Button>
            </div>
          </section>
          <p role="status" className="min-h-5 text-xs text-muted-foreground">
            {status}
          </p>
        </aside>
        <section
          aria-labelledby="dw-canvas-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="dw-canvas-heading" className="text-sm font-semibold">
            Canvas
          </h2>
          {drawing.sheets.length === 0 ? (
            <div
              role="img"
              aria-label="Drawing canvas: no sheets yet"
              data-testid="drawing-canvas"
              className="flex h-[560px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
            >
              No sheets yet — create one to start the drawing.
            </div>
          ) : (
            <div
              role="img"
              aria-label={drawingSummary(drawing)}
              data-testid="drawing-canvas"
              className="h-[560px] overflow-auto rounded-lg border bg-background text-foreground print:h-auto print:overflow-visible print:rounded-none print:border-0 [&_svg]:h-auto [&_svg]:w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </section>
      </div>
    </main>
  );
}
