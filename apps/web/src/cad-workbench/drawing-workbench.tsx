/**
 * The drawing workbench (Phase 53 — Drawings I): the sheet-and-view page.
 *
 * A lean, real workflow: create a sheet (size, orientation, scale — the
 * Formedible-driven sheet form), then place base views of the demo body —
 * front, top, right, isometric — aligned to the front view under the
 * first-angle/third-angle convention (the aligned axis stays registered
 * with the parent), or free when no parent exists. The sheet renders on the
 * SVG canvas through {@link serializeDrawingSvg}'s data path. Views project
 * through the deterministic edges-overlay fallback over the demo body's
 * tessellation and say so — the canvas section discloses the fidelity class
 * instead of passing an overlay picture off as exact HLR.
 *
 * The drawing document itself is kernel-free cad-core state that persists
 * through the native envelope's additive-optional `drawing` field; this
 * page owns the authoring interaction and the canvas.
 */

import { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  alignedViewPlacement,
  createBodyId,
  createDrawingViewId,
  createSheetId,
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
  edgesOverlayProjectionForKind,
  viewFitsSheet,
  viewFrameFromGeometry,
} from "@slopcad/cad-core";
import { Button } from "@slopcad/ui/components/button";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";

import { DEMO_PLATE_MESH } from "./drawing-demo-body";
import { drawingSummary, serializeDrawingSvg } from "./drawing-svg";

type SheetFormValues = {
  size: DrawingSheetSize;
  orientation: DrawingSheetOrientation;
  scaleIndex: number;
};

const SHEET_DEFAULTS: SheetFormValues = {
  size: "A3",
  orientation: "landscape",
  scaleIndex: 3,
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

export function DrawingWorkbenchPage(): ReactElement {
  const [drawing, setDrawing] = useState<DrawingDocument>({ sheets: [] });
  const [angle, setAngle] = useState<DrawingProjectionAngle>("third");
  const [status, setStatus] = useState("No sheets yet.");

  const createSheet = useCallback(
    (values: SheetFormValues) => {
      const scale: DrawingScale =
        DRAWING_SCALES[values.scaleIndex] ?? DRAWING_SCALES[3];
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
          scaleIndex: Number(value.scaleIndex),
        });
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel: "Create sheet",
  });

  const geometryByView = useMemo(() => {
    const map = new Map<string, DrawingViewGeometry>();
    for (const sheet of drawing.sheets) {
      for (const view of sheet.views) {
        map.set(
          view.id,
          edgesOverlayProjectionForKind(DEMO_PLATE_MESH, view.kind),
        );
      }
    }
    return map;
  }, [drawing]);

  const addView = useCallback(
    (kind: DrawingViewKind) => {
      // Placement is computed inside the updater so batched clicks (a fast
      // keyboard user, scripted drives) still read the FRESH view list —
      // each view counts against the views that are actually on the sheet.
      setDrawing((previous) => {
        const sheet = previous.sheets[0];
        if (sheet === undefined) return previous;
        const geometry = edgesOverlayProjectionForKind(DEMO_PLATE_MESH, kind);
        const id = createDrawingViewId(`dwv_${kind}`);
        const placeholder: DrawingView = {
          id,
          kind,
          bodyId: DEMO_BODY_ID,
          x: 0,
          y: 0,
          scale: null,
          alignedTo: null,
        };
        const size = viewFrameOf(placeholder, sheet, geometry);
        const front = sheet.views.find((view) => view.kind === "front") ?? null;
        const frontSize =
          front === null
            ? null
            : viewFrameOf(
                front,
                sheet,
                edgesOverlayProjectionForKind(DEMO_PLATE_MESH, front.kind),
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

  const svg = useMemo(
    () => serializeDrawingSvg(drawing, geometryByView),
    [drawing, geometryByView],
  );

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Drawings</h1>
        <p className="text-sm text-muted-foreground">
          Sheets and base views (Phase 53). Views of the demo plate project
          through the edges-overlay fallback — labelled as such, no hidden-line
          removal; the OCCT kernel answers exact HLR through the contract's{" "}
          <code>drawingView</code> operation.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="flex flex-col gap-6">
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
                  onClick={() => addView(kind)}
                >
                  {kind === "isometric"
                    ? "Isometric"
                    : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`}
                </Button>
              ))}
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
              className="h-[560px] overflow-auto rounded-lg border bg-background text-foreground"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </section>
      </div>
    </main>
  );
}
