/**
 * The drawing sheet workbench (Phase 54): the sheet surface where the
 * parametric model's dimensions are RECOVERED onto a drawing — never
 * re-typed — and where annotations, the title block, the revision table,
 * and the template are authored, with a byte-deterministic SVG export
 * preview.
 *
 * ## The sheet (one kernel up? none)
 *
 * Recovery reads document RECORDS (parameters, features, sketch
 * constraints) — no kernel session, no worker, no WebGL. The page boots
 * one deterministic seed document (see `./drawing-sheet-authoring`), the
 * recover action composes the parametric-source recoveries (see
 * `./drawing-sources`), and every presented primitive is closed-form data
 * from `composeSheetPresentation` — the same function the SVG exporter
 * consumes, so what the author sees is byte-for-byte what exports.
 *
 * ## The dialogs (the feature dialog's discipline)
 *
 * Each dialog mounts ONLY WHEN OPEN (the closed Base UI dialog renders
 * nothing, so the route's SSR stays clean) and its form is Formedible —
 * config objects, schema-driven fields, submit through the action-time
 * battery in `./drawing-sheet-authoring` before any state changes.
 *
 * ## Machine surface (`#drawing-root`)
 *
 * `data-template` (the applied template id), `data-dims-count`,
 * `data-annotations-count`, `data-drawing-values` (the presented dimension
 * texts in presentation order), `data-drawing-svg` (the last export's
 * exact bytes — byte-determinism asserts against THIS), `data-svg-length`,
 * `data-titleblock` (the JSON title block), `data-revisions` (count),
 * `data-authoring-error` (the last refused submission).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  arrowHeadPolygonPoints,
  composeSheetPresentation,
  drawingSheetTemplateById,
  serializeDrawingSheetSvg,
  sheetArcGeometry,
  sheetDimensionsMm,
  uprightTextTransform,
  type DrawingAnnotation,
  type DrawingDimension,
  type DrawingPrimitive,
  type DrawingRevisionRow,
  type DrawingSheetTemplate,
  type DrawingTitleBlock,
} from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import { Button } from "@slopcad/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@slopcad/ui/components/dialog";
import { DRAWING_SHEET_TEMPLATES } from "@slopcad/cad-core";

import {
  REFERENCE_DIMENSION_DEFAULTS,
  referenceDimensionOf,
  seedDrawingDocument,
  TITLE_BLOCK_DEFAULTS,
  validateReferenceDimensionSubmission,
  validateRevisionSubmission,
  validateTemplateSubmission,
  type ReferenceDimensionSubmission,
  type RevisionSubmission,
  type TemplateSubmission,
  type TitleBlockSubmission,
} from "./drawing-sheet-authoring";
import { recoverDrawingEntities } from "./drawing-sources";

/**
 * The view frame the recovery lays out: a 120 x 80 model-mm region whose
 * sheet placement derives from the sheet's own dimensions (left-centered,
 * lower half), so a bigger sheet centers the view instead of pinning it to
 * a corner.
 */
function viewFrameFor(template: DrawingSheetTemplate): {
  readonly viewId: string;
  readonly originXMm: number;
  readonly originYMm: number;
  readonly viewWidthMm: number;
  readonly viewHeightMm: number;
  readonly scale: number;
  readonly stackStepMm: number;
} {
  const { widthMm, heightMm } = sheetDimensionsMm(template.setup);
  const scale = template.setup.scale;
  return {
    viewId: "view_front",
    originXMm: Math.round(widthMm * 0.12),
    originYMm: Math.round((heightMm - 80 * scale) / 2),
    viewWidthMm: 120,
    viewHeightMm: 80,
    scale,
    stackStepMm: 26,
  };
}

interface SheetState {
  readonly template: DrawingSheetTemplate;
  readonly titleBlock: DrawingTitleBlock;
  readonly revisions: readonly DrawingRevisionRow[];
  readonly dimensions: readonly DrawingDimension[];
  readonly annotations: readonly DrawingAnnotation[];
}

const INITIAL_TEMPLATE_ID = "a3-landscape-1-2";

function initialTemplate(): DrawingSheetTemplate {
  const template = drawingSheetTemplateById(INITIAL_TEMPLATE_ID);
  if (template === undefined) {
    throw new Error("The pinned template table is missing its default.");
  }
  return template;
}

function initialState(): SheetState {
  const template = initialTemplate();
  const frame = viewFrameFor(template);
  const seed = seedDrawingDocument();
  const recovered = recoverDrawingEntities(seed, {
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
    template,
    titleBlock: { ...TITLE_BLOCK_DEFAULTS },
    revisions: [],
    dimensions: recovered.dimensions,
    annotations: recovered.annotations,
  };
}

/**
 * The view frame placeholder (the Phase 53 seam): a dashed frame where the
 * real projected view will land, labeled with its view id and scale —
 * presentation data, so the export preview and the canvas show the SAME
 * frame (one builder, two consumers).
 */
function viewFramePrimitives(
  template: DrawingSheetTemplate,
): DrawingPrimitive[] {
  const frame = viewFrameFor(template);
  const scale = frame.scale;
  const x = frame.originXMm;
  const y = frame.originYMm;
  const w = frame.viewWidthMm * scale;
  const h = frame.viewHeightMm * scale;
  return [
    { kind: "rect", x, y, width: w, height: h, dashed: true },
    {
      kind: "text",
      x: x + 2,
      y: y + h + 4,
      text: `${frame.viewId} 1:${String(Math.round(1 / scale))}`,
      anchor: "start",
      sizeMm: 2.8,
    },
  ];
}

/** The sheet's full primitive list: furniture, view seam, dims, annotations. */
function sheetPrimitives(state: SheetState): readonly DrawingPrimitive[] {
  return [
    ...composeSheetPresentation(
      state.template.setup,
      state.titleBlock,
      state.revisions,
      state.dimensions,
      state.annotations,
      state.template.frameMarginMm,
    ),
    ...viewFramePrimitives(state.template),
  ];
}

/** The dimension value texts in presentation order (the machine surface). */
export function dimensionValueTexts(
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
  nextIndex,
  onAuthor,
  onClose,
}: {
  readonly nextIndex: number;
  readonly onAuthor: (
    submission: ReferenceDimensionSubmission,
    index: number,
  ) => void;
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
        onAuthor(value, nextIndex);
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

/**
 * Renders presented primitives as the live SVG canvas: one root y-flip
 * group turns sheet y-up coordinates into screen space, and the shared
 * y-flip discipline (arrowheads, arc flags, the text counter-flip) is
 * the same math the exporter serializes — canvas and export cannot
 * drift apart.
 */
function SheetCanvas({ state }: { readonly state: SheetState }): ReactElement {
  const { widthMm, heightMm } = sheetDimensionsMm(state.template.setup);
  const primitives = useMemo(() => sheetPrimitives(state), [state]);
  return (
    <svg
      data-testid="drawing-canvas"
      viewBox={`0 0 ${String(widthMm)} ${String(heightMm)}`}
      className="max-h-[70vh] w-full bg-white"
      role="img"
      aria-label="Drawing sheet preview"
    >
      <g transform={`translate(0 ${String(heightMm)}) scale(1 -1)`}>
        {primitives.map((primitive, index) => {
          const key = `p${String(index)}`;
          switch (primitive.kind) {
            case "line":
              return (
                <line
                  key={key}
                  x1={primitive.x1}
                  y1={primitive.y1}
                  x2={primitive.x2}
                  y2={primitive.y2}
                  stroke="black"
                  strokeWidth={0.35}
                  strokeDasharray={primitive.dashed ? "2 1.5" : undefined}
                />
              );
            case "rect":
              return (
                <rect
                  key={key}
                  x={primitive.x}
                  y={primitive.y}
                  width={primitive.width}
                  height={primitive.height}
                  fill="none"
                  stroke="black"
                  strokeWidth={0.5}
                  strokeDasharray={primitive.dashed ? "2 1.5" : undefined}
                />
              );
            case "arc": {
              // The shared y-flip discipline: raw sheet coordinates and
              // the corrected flags — the same geometry the export emits.
              const geometry = sheetArcGeometry(primitive);
              return (
                <path
                  key={key}
                  d={`M ${String(geometry.startX)} ${String(geometry.startY)} A ${String(primitive.radius)} ${String(primitive.radius)} 0 ${geometry.largeArc ? "1" : "0"} ${geometry.sweepFlag ? "1" : "0"} ${String(geometry.endX)} ${String(geometry.endY)}`}
                  fill="none"
                  stroke="black"
                  strokeWidth={0.35}
                />
              );
            }
            case "arrow":
              return (
                <polygon
                  key={key}
                  points={arrowHeadPolygonPoints(
                    primitive.x,
                    primitive.y,
                    primitive.angleRad,
                    String,
                  )}
                  fill="black"
                />
              );
            case "text":
              return (
                <text
                  key={key}
                  x={primitive.x}
                  y={primitive.y}
                  fontSize={primitive.sizeMm}
                  textAnchor={primitive.anchor}
                  fontFamily="monospace"
                  fill="black"
                  transform={uprightTextTransform(primitive.y, String)}
                >
                  {primitive.text}
                </text>
              );
          }
        })}
      </g>
    </svg>
  );
}

/** The drawing sheet workbench page. */
export function DrawingSheetWorkbench(): ReactElement {
  const [state, setState] = useState<SheetState>(initialState);
  const [mounted, setMounted] = useState(false);
  const [dialog, setDialog] = useState<
    "template" | "titleBlock" | "reference" | "revision" | null
  >(null);
  const [authoringError, setAuthoringError] = useState<string | null>(null);
  const [exportedSvg, setExportedSvg] = useState<string | null>(null);
  const [referenceCount, setReferenceCount] = useState(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  const applyTemplate = useCallback((submission: TemplateSubmission) => {
    const verdict = validateTemplateSubmission(submission);
    if (!verdict.ok) {
      setAuthoringError(verdict.message);
      return;
    }
    const template = DRAWING_SHEET_TEMPLATES.find(
      (candidate) => candidate.id === submission.templateId,
    );
    if (template === undefined) return;
    setAuthoringError(null);
    setState((previous) => ({ ...previous, template }));
  }, []);

  const applyTitleBlock = useCallback((submission: TitleBlockSubmission) => {
    setAuthoringError(null);
    setState((previous) => ({ ...previous, titleBlock: { ...submission } }));
  }, []);

  const authorReference = useCallback(
    (submission: ReferenceDimensionSubmission, index: number) => {
      const verdict = validateReferenceDimensionSubmission(submission);
      if (!verdict.ok) {
        setAuthoringError(verdict.message);
        return;
      }
      const dimension = referenceDimensionOf(submission, index);
      if (dimension === null) {
        setAuthoringError("The reference dimension could not be authored.");
        return;
      }
      setAuthoringError(null);
      setReferenceCount(index + 1);
      setState((previous) => ({
        ...previous,
        dimensions: [...previous.dimensions, dimension],
      }));
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
    setState((previous) => ({
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
    }));
  }, []);

  const exportSvg = useCallback(() => {
    const { widthMm, heightMm } = sheetDimensionsMm(state.template.setup);
    setExportedSvg(
      serializeDrawingSheetSvg(widthMm, heightMm, sheetPrimitives(state)),
    );
  }, [state]);

  const values = dimensionValueTexts(state.dimensions);
  const { widthMm, heightMm } = sheetDimensionsMm(state.template.setup);

  return (
    <div
      className="mx-auto flex max-w-6xl flex-col gap-4 p-6"
      id="drawing-root"
    >
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Drawing sheet</h1>
        <span className="text-muted-foreground text-sm">
          dimensions recovered from the parametric source
        </span>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="drawing-recover"
          onClick={() => setState(initialState())}
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
          onClick={exportSvg}
          size="sm"
          variant="default"
        >
          Export SVG preview
        </Button>
      </div>
      {authoringError !== null ? (
        <p
          className="text-destructive font-mono text-xs"
          data-testid="drawing-authoring-error"
        >
          {authoringError}
        </p>
      ) : null}
      {mounted ? <SheetCanvas state={state} /> : null}
      <div
        className="text-muted-foreground flex flex-wrap gap-4 font-mono text-xs"
        data-testid="drawing-status"
        data-template={state.template.id}
        data-dims-count={String(state.dimensions.length)}
        data-annotations-count={String(state.annotations.length)}
        data-drawing-values={JSON.stringify(values)}
        data-revisions={String(state.revisions.length)}
        data-titleblock={JSON.stringify(state.titleBlock)}
        data-drawing-svg={exportedSvg ?? ""}
        data-svg-length={exportedSvg === null ? "" : String(exportedSvg.length)}
        data-sheet={`${String(widthMm)}x${String(heightMm)}`}
      >
        <span>{state.template.name}</span>
        <span>{`${String(state.dimensions.length)} dimensions`}</span>
        <span>{`${String(state.annotations.length)} annotations`}</span>
        {exportedSvg !== null ? (
          <span data-testid="drawing-export-length">{`${String(exportedSvg.length)} bytes exported`}</span>
        ) : null}
      </div>
      {dialog === "template" ? (
        <TemplatePickerDialog
          currentId={state.template.id}
          onApply={applyTemplate}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "titleBlock" ? (
        <TitleBlockDialog
          titleBlock={state.titleBlock}
          onApply={applyTitleBlock}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "reference" ? (
        <ReferenceDimensionDialog
          nextIndex={referenceCount}
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
    </div>
  );
}
