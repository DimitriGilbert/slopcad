/**
 * The drawing workbench (Phases 53–55, UNIFIED in Phase 55 round 2): the
 * ONE drawing surface. Every capability the previous two routes split —
 * model-dimension recovery, dimensions and annotations, title block,
 * revision table, template picker, sheet + view authoring, derived views,
 * BOM tables, balloons, save/load, exports, print — hosts on this route,
 * composed into ONE picture per sheet: Phase 54's furniture presentation
 * (frame, title block, revisions, dimensions, annotations) layered over
 * Phase 55's document presentation (views, BOM, balloons) from the same
 * cad-core walk. What the canvas shows is what the SVG export emits,
 * byte for byte.
 *
 * Every output path runs through cad-core's byte-deterministic exporters:
 * the canvas renders `serializeSheetPictureSvg` over the composed
 * picture, and the download affordances emit the same SVG plus the PDF
 * and DXF writers' bytes for the document content.
 *
 * Persistence rides the native envelope's additive-optional `drawing`
 * field through the documents tRPC router: Save serializes the drawing
 * into a minimal native document and appends a version; Load restores the
 * drawing from the latest version. Create/save success invalidates the
 * projects/documents list caches, so a rapid re-save cannot fork a
 * duplicate project or document off stale cached empties.
 */

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  alignedViewPlacement,
  createBodyId,
  createDrawingViewId,
  createOccurrenceId,
  createSheetId,
  type DrawingAnnotation,
  type DrawingBalloon,
  type DrawingDocument,
  type DrawingDimension,
  type DrawingPictureGroup,
  type DrawingProjectionAngle,
  type DrawingRevisionRow,
  type DrawingScale,
  type DrawingSheet,
  type DrawingSheetPicture,
  type DrawingSheetSetup,
  type DrawingSheetSize,
  type DrawingSheetOrientation,
  type DrawingSheetTemplate,
  type DrawingTitleBlock,
  type DrawingView,
  type DrawingViewGeometry,
  type DrawingViewKind,
  DRAWING_FRAME_MARGIN_MM,
  DRAWING_SCALES,
  DRAWING_SHEET_SIZE_NAMES,
  DRAWING_SHEET_TEMPLATES,
  DRAWING_VIEW_KINDS,
  type DrawingGeometryByView,
  composeSheetPresentation,
  drawingSheetTemplateById,
  drawingSummary,
  edgesOverlayProjectionForKind,
  numberBomItems,
  presentDrawingSheet,
  serializeDrawingDxf,
  serializeDrawingPdf,
  serializeSheetPictureSvg,
  sheetDimensions,
  sheetDimensionsMm,
  viewFitsSheet,
  viewFrameFromGeometry,
} from "@slopcad/cad-core";
import { Button } from "@slopcad/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@slopcad/ui/components/dialog";
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
import {
  parseDrawingSaveEnvelope,
  serializeDrawingSaveEnvelope,
} from "./drawing-persistence";
import {
  REFERENCE_DIMENSION_DEFAULTS,
  TITLE_BLOCK_DEFAULTS,
  referenceDimensionOf,
  seedDrawingDocument,
  validateReferenceDimensionSubmission,
  validateRevisionSubmission,
  validateTemplateSubmission,
  type ReferenceDimensionSubmission,
  type RevisionSubmission,
  type TemplateSubmission,
  type TitleBlockSubmission,
} from "./drawing-sheet-authoring";
import { recoverDrawingEntities } from "./drawing-sources";

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
  // default must match or the trigger renders blank on load. 1:2 (the
  // pinned `a3-landscape-1-2` template's scale) is the drawing default.
  scaleIndex: "2",
};

/** Aligned-view gap between frames, sheet millimetres. */
const VIEW_GAP_MM = 15;

const DEMO_BODY_ID = createBodyId("body_drawing_plate");

/** The template picker's pre-sheet default (the drawing starter). */
const SHEET_DEFAULTS_TEMPLATE_ID = "a3-landscape-1-2";

const viewFrameOf = (
  view: DrawingView,
  sheet: DrawingSheet,
  geometry: DrawingViewGeometry | undefined,
): { readonly width: number; readonly height: number } | null => {
  if (geometry === undefined || geometry.bounds === null) return null;
  const frame = viewFrameFromGeometry(view, sheet, geometry.bounds);
  return frame === null ? null : { width: frame.width, height: frame.height };
};

/** The document sheet's furniture setup (scale ratio → number). */
function sheetSetupOf(sheet: DrawingSheet): DrawingSheetSetup {
  return {
    size: sheet.size,
    orientation: sheet.orientation,
    scale: sheet.scale.numerator / sheet.scale.denominator,
  };
}

/** The pinned template matching a setup, when one exists. */
function pinnedTemplateFor(
  setup: DrawingSheetSetup,
): DrawingSheetTemplate | null {
  return (
    DRAWING_SHEET_TEMPLATES.find(
      (template) =>
        template.setup.size === setup.size &&
        template.setup.orientation === setup.orientation &&
        Math.abs(template.setup.scale - setup.scale) < 1e-9,
    ) ?? null
  );
}

/** The DrawingScale whose ratio equals the template's scale number. */
function scaleOfNumber(scale: number): DrawingScale | null {
  return (
    DRAWING_SCALES.find(
      (candidate) => candidate.numerator / candidate.denominator === scale,
    ) ?? null
  );
}

/**
 * The view frame the recovery lays out: a 120 x 80 model-mm region whose
 * sheet placement derives from the sheet's own dimensions (left-centered,
 * lower half), so a bigger sheet centers the view instead of pinning it
 * to a corner.
 */
function viewFrameFor(setup: DrawingSheetSetup): {
  readonly viewId: string;
  readonly originXMm: number;
  readonly originYMm: number;
  readonly viewWidthMm: number;
  readonly viewHeightMm: number;
  readonly scale: number;
} {
  const { widthMm, heightMm } = sheetDimensionsMm(setup);
  const scale = setup.scale;
  return {
    viewId: "view_front",
    originXMm: Math.round(widthMm * 0.12),
    originYMm: Math.round((heightMm - 80 * scale) / 2),
    viewWidthMm: 120,
    viewHeightMm: 80,
    scale,
  };
}

/** The dimension value texts in presentation order (the machine surface). */
function dimensionValueTexts(
  dimensions: readonly DrawingDimension[],
): readonly string[] {
  return [...dimensions]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((dimension) => {
      switch (dimension.kind) {
        case "linear":
          return `${dimension.valueMm}`;
        case "radial":
          return `R${dimension.valueMm}`;
        case "diameter":
          return `\u2300${dimension.valueMm}`;
        case "angular":
          return `${dimension.valueDeg}\u00B0`;
      }
    });
}

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

/** The furniture state recovered from the parametric seed (Phase 54). */
interface FurnitureState {
  readonly titleBlock: DrawingTitleBlock;
  readonly revisions: readonly DrawingRevisionRow[];
  readonly dimensions: readonly DrawingDimension[];
  readonly annotations: readonly DrawingAnnotation[];
  readonly referenceCount: number;
}

/** Runs the deterministic recovery for one sheet's frame. */
function recoverFurniture(sheet: DrawingSheet): FurnitureState {
  const setup = sheetSetupOf(sheet);
  const frame = viewFrameFor(setup);
  const recovered = recoverDrawingEntities(seedDrawingDocument(), {
    viewId: frame.viewId,
    originXMm: frame.originXMm,
    originYMm: frame.originYMm,
    viewWidthMm: frame.viewWidthMm,
    viewHeightMm: frame.viewHeightMm,
    scale: frame.scale,
    sketchOriginYMm: frame.originYMm + frame.viewHeightMm * frame.scale,
    stackStepMm: 22,
  });
  return {
    titleBlock: { ...TITLE_BLOCK_DEFAULTS },
    revisions: [],
    dimensions: recovered.dimensions,
    annotations: recovered.annotations,
    referenceCount: 0,
  };
}

export function DrawingWorkbenchPage(): ReactElement {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [drawing, setDrawing] = useState<DrawingDocument>({ sheets: [] });
  const [furniture, setFurniture] = useState<FurnitureState | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [angle, setAngle] = useState<DrawingProjectionAngle>("third");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [exportedSvg, setExportedSvg] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "template" | "titleBlock" | "reference" | "revision" | null
  >(null);
  const [authoringError, setAuthoringError] = useState<string | null>(null);
  const [status, setStatus] = useState(
    "No sheets yet. Sheets, views, BOM tables, and balloons author here; the model's dimensions recover onto the first sheet; Save persists the drawing into a document.",
  );

  const geometryByView = useMemo<DrawingGeometryByView>(() => {
    const sheet = drawing.sheets[0];
    if (sheet === undefined) return new Map();
    return deriveSheetGeometry(sheet, DEMO_PLATE_MESH);
  }, [drawing]);

  /**
   * The composed sheet picture (Phase 54 furniture over Phase 55 document
   * content — ONE presentation, ONE frame, one flip discipline).
   */
  const picture = useMemo<DrawingSheetPicture | null>(() => {
    const sheet = drawing.sheets[0];
    if (sheet === undefined || furniture === null) return null;
    const docPicture = presentDrawingSheet(sheet, geometryByView, {
      includeFrame: false,
    });
    const furniturePrimitives = composeSheetPresentation(
      sheetSetupOf(sheet),
      furniture.titleBlock,
      furniture.revisions,
      furniture.dimensions,
      furniture.annotations,
      DRAWING_FRAME_MARGIN_MM,
    );
    const groups: readonly DrawingPictureGroup[] = [
      { class: "dg-furniture", primitives: furniturePrimitives },
      ...docPicture.groups,
    ];
    return {
      widthMm: docPicture.widthMm,
      heightMm: docPicture.heightMm,
      groups,
    };
  }, [drawing, furniture, geometryByView]);

  const svg = useMemo(
    () => (picture === null ? null : serializeSheetPictureSvg(picture)),
    [picture],
  );

  const createSheet = useCallback(
    (values: SheetFormValues) => {
      const scale: DrawingScale =
        DRAWING_SCALES[Number(values.scaleIndex)] ?? DRAWING_SCALES[3];
      if (scale === undefined) return;
      const id = createSheetId(`sht_sheet-${drawing.sheets.length + 1}`);
      setDrawing((previous) => {
        const sheet: DrawingSheet = {
          id,
          size: values.size,
          orientation: values.orientation,
          scale,
          views: [],
        };
        const first = previous.sheets.length === 0;
        if (first) {
          // The Phase 54 boot: the first sheet recovers the seed model's
          // dimensions and annotations onto itself — never re-typed.
          setFurniture(recoverFurniture(sheet));
          setTemplateId(pinnedTemplateFor(sheetSetupOf(sheet))?.id ?? null);
        }
        setStatus(
          `Sheet ${id} created (${values.size}, ${scale.numerator}:${scale.denominator}).${first ? " Model dimensions recovered onto the sheet." : ""}`,
        );
        return { sheets: [...previous.sheets, sheet] };
      });
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
        if (sheet === undefined) {
          setStatus("Create a sheet first.");
          return previous;
        }
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

  // --- Furniture authoring (the Phase 54 dialogs) ------------------------

  const applyTemplate = useCallback(
    (submission: TemplateSubmission) => {
      const verdict = validateTemplateSubmission(submission);
      if (!verdict.ok) {
        setAuthoringError(verdict.message);
        return;
      }
      const sheet = drawing.sheets[0];
      if (sheet === undefined) {
        setAuthoringError(
          "Create a sheet first — the template sizes the sheet.",
        );
        return;
      }
      const template = drawingSheetTemplateById(submission.templateId);
      if (template === undefined) return;
      const scale = scaleOfNumber(template.setup.scale);
      setAuthoringError(null);
      setTemplateId(template.id);
      setFurniture((previous) =>
        previous === null
          ? previous
          : { ...previous, titleBlock: { ...template.titleBlock } },
      );
      setDrawing((previous) => ({
        sheets: previous.sheets.map((s, index) =>
          index === 0
            ? {
                ...s,
                size: template.setup.size,
                orientation: template.setup.orientation,
                ...(scale === null ? {} : { scale }),
              }
            : s,
        ),
      }));
    },
    [drawing.sheets],
  );

  const applyTitleBlock = useCallback((submission: TitleBlockSubmission) => {
    setAuthoringError(null);
    setFurniture((previous) =>
      previous === null
        ? previous
        : { ...previous, titleBlock: { ...submission } },
    );
  }, []);

  const authorReference = useCallback(
    (submission: ReferenceDimensionSubmission) => {
      const verdict = validateReferenceDimensionSubmission(submission);
      if (!verdict.ok) {
        setAuthoringError(verdict.message);
        return;
      }
      setFurniture((previous) => {
        if (previous === null) return previous;
        const dimension = referenceDimensionOf(
          submission,
          previous.referenceCount,
        );
        if (dimension === null) {
          setAuthoringError("The reference dimension could not be authored.");
          return previous;
        }
        setAuthoringError(null);
        return {
          ...previous,
          referenceCount: previous.referenceCount + 1,
          dimensions: [...previous.dimensions, dimension],
        };
      });
    },
    [],
  );

  const applyRevision = useCallback((submission: RevisionSubmission) => {
    const verdict = validateRevisionSubmission(submission);
    if (!verdict.ok) {
      setAuthoringError(verdict.message);
      return;
    }
    setAuthoringError(null);
    setFurniture((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            revisions: [
              ...previous.revisions,
              {
                revision: submission.revision,
                description: submission.description,
                author: submission.author,
                date: submission.date,
              },
            ],
          },
    );
  }, []);

  const recover = useCallback((): void => {
    const sheet = drawing.sheets[0];
    if (sheet === undefined) {
      setStatus("Create a sheet first — recovery needs the sheet frame.");
      return;
    }
    setFurniture(recoverFurniture(sheet));
    setStatus("Model dimensions recovered from the parametric source.");
  }, [drawing.sheets]);

  // --- Persistence (the document wiring, cache-coherent) -----------------

  const { mutate: saveMutate } = useMutation(
    trpc.documents.save.mutationOptions({
      onSuccess: (result) => {
        setStatus(`Drawing saved as version ${String(result.version)}.`);
        void queryClient.invalidateQueries({
          queryKey: trpc.documents.get.queryOptions({
            documentId: result.documentId,
          }).queryKey,
        });
        // The list caches go stale on every successful save: a rapid
        // re-save refetches instead of reading cached empties and
        // forking a duplicate document.
        void queryClient.invalidateQueries({
          queryKey: trpc.documents.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.projects.list.queryKey(),
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
        void queryClient.invalidateQueries({
          queryKey: trpc.documents.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.projects.list.queryKey(),
        });
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
        void queryClient.invalidateQueries({
          queryKey: trpc.projects.list.queryKey(),
        });
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
      const envelope = serializeDrawingSaveEnvelope(drawing);
      if (!envelope.ok) {
        setStatus(`Save refused: ${envelope.message}`);
        return;
      }
      // `mutate` is TanStack Query's stable trigger — the only piece of the
      // mutation object the wiring needs.
      saveMutate({
        documentId: targetDocumentId,
        nativeContent: envelope.nativeContent,
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
        const parsed = parseDrawingSaveEnvelope(data.latest.nativeContent);
        if (!parsed.ok) {
          setStatus(`The saved document failed to load: ${parsed.message}`);
          return;
        }
        if (parsed.drawing === null) {
          setStatus("The saved document carries no drawing.");
          return;
        }
        setDrawing(parsed.drawing);
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
    if (svg === null) {
      setStatus("Nothing to export — create a sheet first.");
      return;
    }
    download("drawing.svg", svg, "image/svg+xml");
    setStatus(
      "Sheet exported as SVG (furniture + drawing, deterministic bytes).",
    );
  }, [svg]);

  const exportPdf = useCallback((): void => {
    if (drawing.sheets.length === 0) {
      setStatus("Nothing to export — create a sheet first.");
      return;
    }
    download(
      "drawing.pdf",
      serializeDrawingPdf(drawing, geometryByView),
      "application/pdf",
    );
    setStatus(
      "Drawing document exported as PDF (deterministic vector bytes — dimensions/title block not yet exported).",
    );
  }, [drawing, geometryByView]);

  const exportDxf = useCallback((): void => {
    if (drawing.sheets.length === 0) {
      setStatus("Nothing to export — create a sheet first.");
      return;
    }
    download(
      "drawing.dxf",
      serializeDrawingDxf(drawing, geometryByView),
      "application/dxf",
    );
    setStatus(
      "Drawing document exported as DXF (LINE/CIRCLE/TEXT subset, round-trips — dimensions/title block not yet exported).",
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

  const values = useMemo(
    () => (furniture === null ? [] : dimensionValueTexts(furniture.dimensions)),
    [furniture],
  );

  const sheet = drawing.sheets[0];
  const { width, height } =
    sheet === undefined ? { width: 0, height: 0 } : sheetDimensions(sheet);

  return (
    <main
      id="drawing-root"
      className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8 print:max-w-none print:px-0 print:py-0"
    >
      <style dangerouslySetInnerHTML={{ __html: printPageStyle }} />
      <header className="flex flex-col gap-1 print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">Drawings</h1>
        <p className="text-sm text-muted-foreground">
          One drawing surface: dimensions recovered from the parametric source,
          title block and revisions, derived views, BOM tables and balloons.
          Views of the demo plate project through the edges-overlay fallback —
          labelled as such, no hidden-line removal; sections hatch their cut
          faces, details crop at 2:1, and the BOM numbers itself
          deterministically from the demo assembly structure. Exports
          (SVG/PDF/DXF) are byte-deterministic.
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
            aria-labelledby="dw-furniture-heading"
            className="rounded-lg border p-4"
          >
            <h2
              id="dw-furniture-heading"
              className="mb-3 text-sm font-semibold"
            >
              Sheet furniture
            </h2>
            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="drawing-recover"
                onClick={recover}
                size="sm"
                variant="outline"
              >
                Recover model dimensions
              </Button>
              <Button
                data-testid="drawing-template-open"
                onClick={() => setDialog("template")}
                size="sm"
                variant="outline"
              >
                Template
              </Button>
              <Button
                data-testid="drawing-title-open"
                onClick={() => setDialog("titleBlock")}
                size="sm"
                variant="outline"
              >
                Title block
              </Button>
              <Button
                data-testid="drawing-reference-open"
                onClick={() => setDialog("reference")}
                size="sm"
                variant="outline"
              >
                Reference dimension
              </Button>
              <Button
                data-testid="drawing-revision-open"
                onClick={() => setDialog("revision")}
                size="sm"
                variant="outline"
              >
                Revision row
              </Button>
              <Button
                data-testid="drawing-export"
                onClick={() => setExportedSvg(svg)}
                size="sm"
                variant="default"
              >
                Export SVG preview
              </Button>
            </div>
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
          {authoringError !== null ? (
            <p
              aria-label="Authoring error"
              className="text-destructive font-mono text-xs"
              data-testid="drawing-authoring-error"
            >
              {authoringError}
            </p>
          ) : null}
          <p role="status" className="min-h-5 text-xs text-muted-foreground">
            {status}
          </p>
        </aside>
        <section
          aria-labelledby="dw-canvas-heading"
          className="flex flex-col gap-3"
        >
          <h2
            id="dw-canvas-heading"
            className="text-sm font-semibold print:hidden"
          >
            Canvas
          </h2>
          {drawing.sheets.length === 0 || svg === null ? (
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
              className="h-[560px] overflow-auto rounded-lg border bg-white text-black print:h-auto print:overflow-visible print:rounded-none print:border-0 [&_svg]:h-auto [&_svg]:w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </section>
      </div>
      <div
        className="text-muted-foreground flex flex-wrap gap-4 font-mono text-xs print:hidden"
        data-testid="drawing-status"
        data-template={templateId ?? ""}
        data-dims-count={String(furniture?.dimensions.length ?? 0)}
        data-annotations-count={String(furniture?.annotations.length ?? 0)}
        data-drawing-values={JSON.stringify(values)}
        data-revisions={String(furniture?.revisions.length ?? 0)}
        data-titleblock={JSON.stringify(
          furniture?.titleBlock ?? {
            title: "",
            author: "",
            material: "",
            mass: "",
            scale: "",
            date: "",
          },
        )}
        data-drawing-svg={exportedSvg ?? ""}
        data-svg-length={exportedSvg === null ? "" : String(exportedSvg.length)}
        data-sheet={
          sheet === undefined ? "" : `${String(width)}x${String(height)}`
        }
      >
        <span>
          {furniture === null
            ? "no sheet furniture yet"
            : (DRAWING_SHEET_TEMPLATES.find(
                (template) => template.id === (templateId ?? ""),
              )?.name ?? "custom sheet")}
        </span>
        <span>{`${String(furniture?.dimensions.length ?? 0)} dimensions`}</span>
        <span>{`${String(furniture?.annotations.length ?? 0)} annotations`}</span>
        {exportedSvg !== null ? (
          <span data-testid="drawing-export-length">{`${String(exportedSvg.length)} bytes exported`}</span>
        ) : null}
      </div>
      {dialog === "template" ? (
        <TemplatePickerDialog
          currentId={templateId ?? SHEET_DEFAULTS_TEMPLATE_ID}
          onApply={applyTemplate}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "titleBlock" && furniture !== null ? (
        <TitleBlockDialog
          titleBlock={furniture.titleBlock}
          onApply={applyTitleBlock}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "reference" ? (
        <ReferenceDimensionDialog
          onAuthor={authorReference}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "revision" ? (
        <RevisionDialog
          onApply={applyRevision}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </main>
  );
}

function TemplatePickerDialog({
  currentId,
  onApply,
  onClose,
}: {
  readonly currentId: string;
  readonly onApply: (submission: TemplateSubmission) => void;
  readonly onClose: () => void;
}): ReactElement {
  type Values = { templateId: string } & Record<string, unknown>;
  const fields: readonly FormedibleFieldConfig<Values>[] = [
    {
      name: "templateId",
      type: "select",
      label: "Template",
      required: true,
      defaultValue: currentId,
      options: DRAWING_SHEET_TEMPLATES.map((template) => ({
        value: template.id,
        label: template.name,
      })),
    },
  ];
  const form = useFormedible<Values>({
    fields,
    formOptions: {
      defaultValues: { templateId: currentId },
      onSubmit: ({ value }) => {
        onApply({ templateId: value.templateId });
        onClose();
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: "Apply template",
  });
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="sm:max-w-sm"
        data-testid="drawing-template-dialog"
      >
        <DialogHeader>
          <DialogTitle>Sheet template</DialogTitle>
        </DialogHeader>
        <form.Form aria-label="Sheet template picker" className="space-y-3" />
      </DialogContent>
    </Dialog>
  );
}

function TitleBlockDialog({
  titleBlock,
  onApply,
  onClose,
}: {
  readonly titleBlock: DrawingTitleBlock;
  readonly onApply: (submission: TitleBlockSubmission) => void;
  readonly onClose: () => void;
}): ReactElement {
  type Values = TitleBlockSubmission & Record<string, unknown>;
  const field = (name: keyof TitleBlockSubmission, label: string) => ({
    name,
    type: "text" as const,
    label,
  });
  const fields: readonly FormedibleFieldConfig<Values>[] = [
    field("title", "Title"),
    field("author", "Author"),
    field("material", "Material"),
    field("mass", "Mass"),
    field("scale", "Scale"),
    field("date", "Date"),
  ];
  const form = useFormedible<Values>({
    fields,
    formOptions: {
      defaultValues: { ...titleBlock },
      onSubmit: ({ value }) => {
        onApply(value);
        onClose();
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: "Save title block",
  });
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="sm:max-w-sm"
        data-testid="drawing-titleblock-dialog"
      >
        <DialogHeader>
          <DialogTitle>Title block</DialogTitle>
        </DialogHeader>
        <form.Form aria-label="Title block form" className="space-y-3" />
      </DialogContent>
    </Dialog>
  );
}

function ReferenceDimensionDialog({
  onAuthor,
  onClose,
}: {
  readonly onAuthor: (submission: ReferenceDimensionSubmission) => void;
  readonly onClose: () => void;
}): ReactElement {
  type Values = ReferenceDimensionSubmission & Record<string, unknown>;
  const fields: readonly FormedibleFieldConfig<Values>[] = [
    {
      name: "kind",
      type: "select",
      label: "Kind",
      options: [
        { value: "linear", label: "Linear" },
        { value: "radial", label: "Radial" },
        { value: "diameter", label: "Diameter" },
        { value: "angular", label: "Angular" },
      ],
      required: true,
    },
    {
      name: "orientation",
      type: "select",
      label: "Linear orientation",
      options: [
        { value: "aligned", label: "Aligned" },
        { value: "horizontal", label: "Horizontal" },
        { value: "vertical", label: "Vertical" },
      ],
    },
    {
      name: "value",
      type: "number",
      label: "Value (mm or deg)",
      required: true,
    },
  ];
  const form = useFormedible<Values>({
    fields,
    formOptions: {
      defaultValues: { ...REFERENCE_DIMENSION_DEFAULTS },
      onSubmit: ({ value }) => {
        onAuthor(value);
        onClose();
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: "Place reference dimension",
  });
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="sm:max-w-sm"
        data-testid="drawing-reference-dialog"
      >
        <DialogHeader>
          <DialogTitle>Reference dimension</DialogTitle>
        </DialogHeader>
        <form.Form
          aria-label="Reference dimension form"
          className="space-y-3"
          noValidate
        />
      </DialogContent>
    </Dialog>
  );
}

function RevisionDialog({
  onApply,
  onClose,
}: {
  readonly onApply: (submission: RevisionSubmission) => void;
  readonly onClose: () => void;
}): ReactElement {
  type Values = RevisionSubmission & Record<string, unknown>;
  const fields: readonly FormedibleFieldConfig<Values>[] = [
    { name: "revision", type: "text", label: "Revision", required: true },
    { name: "description", type: "text", label: "Description", required: true },
    { name: "author", type: "text", label: "Author" },
    { name: "date", type: "text", label: "Date" },
  ];
  const form = useFormedible<Values>({
    fields,
    formOptions: {
      defaultValues: { revision: "B", description: "", author: "", date: "" },
      onSubmit: ({ value }) => {
        onApply(value);
        onClose();
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: "Add revision row",
  });
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="sm:max-w-sm"
        data-testid="drawing-revision-dialog"
      >
        <DialogHeader>
          <DialogTitle>Revision table</DialogTitle>
        </DialogHeader>
        <form.Form
          aria-label="Revision form"
          className="space-y-3"
          noValidate
        />
      </DialogContent>
    </Dialog>
  );
}
