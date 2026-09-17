/**
 * `CadSketchCanvas` (Phase 25): the 2D sketch surface — a deterministic SVG
 * layer rendering a workplane (origin axes + grid), sketch geometry, pending
 * picks, an in-progress gesture preview, and constraint/dimension
 * annotations. It is a pure display and hit-tester: geometry arrives as a
 * plain view model (already styled: construction flags, selection, per-entity
 * diagnostic levels), pointer interactions leave as semantic events —
 * `onPick` carries the workplane-space point plus the topmost entity id
 * under the pointer, `onHover` carries the hovered entity id — and the host
 * decides what either means (the tool state machines live in the host, not
 * here).
 *
 * ## Canvas-surface decision
 *
 * The plan's sketching happens on workplanes inside 3D model space; this
 * component renders the workplane's own 2D space directly (y flipped to
 * screen: `screen = origin + (x·scale, −y·scale)`), NOT as an overlay on the
 * R3F canvas. A dedicated 2D surface is the honest scope for browser
 * sketching: picking and drawing are exact in workplane coordinates, SVG
 * pixels are deterministic under the render harness (no WebGL in the loop),
 * and every entity is a real DOM element a machine can address
 * (`data-sketch-entity-id`, `data-sketch-selected`, `data-sketch-construction`,
 * `data-sketch-diagnostic`). The workplane context stays visible: the badge
 * names it, and the axes render through the origin.
 *
 * ## Hit-testing
 *
 * `onPick`/`onHover` entity hits come from the component's own
 * screen-space distance tests (8 px tolerance) over the view model — lines
 * by segment distance, circles/arcs by rim distance (arcs restricted to
 * their sweep), points/centers by point distance. Overlapping geometry
 * resolves to the topmost hit in view-model order (later entities win, the
 * draw order). Empty canvas picks carry `entityId: null`.
 *
 * All user-facing strings live in {@link CAD_SKETCH_CANVAS_LABELS}
 * (overridable via the `labels` prop); annotation text is host data rendered
 * verbatim.
 */

import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { cn } from "cn";

/** A workplane-space point in mm. */
export interface CadSketchPoint {
  readonly x: number;
  readonly y: number;
}

/** Diagnostic level an entity renders with (badge styling per level). */
export type CadSketchDiagnosticLevel = "none" | "warning" | "error";

/** View model of one drawable sketch entity (workplane mm). */
export type CadSketchCanvasEntity =
  | {
      readonly id: string;
      readonly kind: "point";
      readonly x: number;
      readonly y: number;
      readonly construction: boolean;
      readonly selected: boolean;
      readonly diagnostic: CadSketchDiagnosticLevel;
    }
  | {
      readonly id: string;
      readonly kind: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly construction: boolean;
      readonly selected: boolean;
      readonly diagnostic: CadSketchDiagnosticLevel;
    }
  | {
      readonly id: string;
      readonly kind: "circle";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      readonly construction: boolean;
      readonly selected: boolean;
      readonly diagnostic: CadSketchDiagnosticLevel;
    }
  | {
      readonly id: string;
      readonly kind: "arc";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
      readonly construction: boolean;
      readonly selected: boolean;
      readonly diagnostic: CadSketchDiagnosticLevel;
    };

/** View model of a closed region (a rectangle's face), workplane mm. */
export interface CadSketchCanvasRegion {
  readonly id: string;
  readonly points: readonly [
    CadSketchPoint,
    CadSketchPoint,
    CadSketchPoint,
    CadSketchPoint,
  ];
  readonly selected: boolean;
  readonly diagnostic: CadSketchDiagnosticLevel;
}

/** One annotation: a dimension label or constraint badge at a workplane point. */
export interface CadSketchCanvasAnnotation {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly level: "info" | "warning" | "error";
  readonly kind: "dimension" | "constraint";
}

/** The in-progress gesture preview, workplane mm. */
export type CadSketchCanvasPreview =
  | { readonly kind: "line"; readonly from: CadSketchPoint; readonly to: CadSketchPoint }
  | {
      readonly kind: "rectangle";
      readonly from: CadSketchPoint;
      readonly to: CadSketchPoint;
    }
  | { readonly kind: "circle"; readonly center: CadSketchPoint; readonly radius: number }
  | { readonly kind: "none" };

/** The user-facing strings of {@link CadSketchCanvas}. Overridable via props. */
export interface CadSketchCanvasLabels {
  /** Accessible name of the SVG surface. */
  readonly canvasLabel: string;
  /** The workplane badge text (the workplane context, verbatim). */
  readonly workplaneBadge: string;
}

/** Documented label defaults; every render-output string lives here. */
export const CAD_SKETCH_CANVAS_LABELS: CadSketchCanvasLabels = {
  canvasLabel: "Sketch canvas",
  workplaneBadge: "XY",
};

/** Props of {@link CadSketchCanvas}. */
export interface CadSketchCanvasProps {
  /** CSS pixel size of the surface (the SVG viewBox matches 1:1). */
  readonly width: number;
  readonly height: number;
  /** Screen position (CSS px) of the workplane origin. */
  readonly origin: CadSketchPoint;
  /** Screen pixels per millimeter. */
  readonly scale: number;
  /** Grid step in millimeters (minor lines). */
  readonly gridStep: number;
  /** The entities to render, in draw order (later entities hit-test on top). */
  readonly entities: readonly CadSketchCanvasEntity[];
  /** Closed regions (rectangle faces) rendered under the entities. */
  readonly regions?: readonly CadSketchCanvasRegion[];
  /** Dimension labels and constraint badges. */
  readonly annotations?: readonly CadSketchCanvasAnnotation[];
  /** Pending constraint picks, rendered as numbered markers. */
  readonly picks?: readonly CadSketchPoint[];
  /** The in-progress gesture preview, or `{ kind: "none" }`. */
  readonly preview?: CadSketchCanvasPreview;
  /** The hovered entity id (thicker stroke), or `null`. */
  readonly hoveredEntityId?: string | null;
  /** Semantic pick: workplane mm point + topmost entity id under it. */
  readonly onPick?: (pick: {
    readonly point: CadSketchPoint;
    readonly entityId: string | null;
  }) => void;
  /** Semantic hover: the entity id under the pointer, or `null`. */
  readonly onHover?: (entityId: string | null) => void;
  /** Pointer tracking: the workplane mm point under the pointer. */
  readonly onMove?: (point: CadSketchPoint) => void;
  /** Label token overrides, merged over {@link CAD_SKETCH_CANVAS_LABELS}. */
  readonly labels?: Partial<CadSketchCanvasLabels>;
  /** Extends the container classes. */
  readonly className?: string;
}

/** Pick/hover tolerance, screen pixels. */
const HIT_TOLERANCE_PX = 8;

function distanceToSegment(
  point: CadSketchPoint,
  a: CadSketchPoint,
  b: CadSketchPoint,
): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSquared),
        );
  const closest = { x: a.x + t * abx, y: a.y + t * aby };
  return Math.hypot(point.x - closest.x, point.y - closest.y);
}

/** Angle of `point` about `center`, normalized to [0, 2π). */
function angleAbout(point: CadSketchPoint, center: CadSketchPoint): number {
  const angle = Math.atan2(point.y - center.y, point.x - center.x);
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

/** Whether `angle` lies on the CCW arc from `start` to `end` (both [0, 2π)). */
function withinSweep(angle: number, start: number, end: number): boolean {
  const sweep = (end - start + Math.PI * 2) % (Math.PI * 2);
  const relative = (angle - start + Math.PI * 2) % (Math.PI * 2);
  return relative <= sweep;
}

/**
 * The sketch canvas: the workplane's own deterministic 2D surface — grid,
 * axes, geometry, picks, preview, annotations — emitting semantic picks.
 */
export function CadSketchCanvas({
  annotations = [],
  className,
  entities,
  gridStep,
  height,
  hoveredEntityId = null,
  labels: labelOverrides,
  onHover,
  onMove,
  onPick,
  origin,
  picks = [],
  preview = { kind: "none" },
  regions = [],
  scale,
  width,
}: CadSketchCanvasProps) {
  const labels: CadSketchCanvasLabels = {
    ...CAD_SKETCH_CANVAS_LABELS,
    ...labelOverrides,
  };
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Workplane mm → screen px (y flipped), and back for pointer events.
  const toScreen = useCallback(
    (point: CadSketchPoint): CadSketchPoint => ({
      x: origin.x + point.x * scale,
      y: origin.y - point.y * scale,
    }),
    [origin, scale],
  );

  const eventToWorkplane = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): CadSketchPoint | null => {
      const svg = svgRef.current;
      if (svg === null) return null;
      const bounds = svg.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      return { x: (x - origin.x) / scale, y: (origin.y - y) / scale };
    },
    [origin, scale],
  );

  /** The topmost (latest in view-model order) entity within tolerance. */
  const hitEntity = useCallback(
    (point: CadSketchPoint): string | null => {
      for (let index = entities.length - 1; index >= 0; index -= 1) {
        const entity = entities[index];
        if (entity === undefined) continue;
        let distance = Number.POSITIVE_INFINITY;
        if (entity.kind === "line") {
          distance = distanceToSegment(
            point,
            { x: entity.x1, y: entity.y1 },
            { x: entity.x2, y: entity.y2 },
          );
        } else if (entity.kind === "circle") {
          distance = Math.abs(
            Math.hypot(point.x - entity.cx, point.y - entity.cy) - entity.radius,
          );
        } else if (entity.kind === "arc") {
          const rim = Math.hypot(point.x - entity.cx, point.y - entity.cy);
          const onRim =
            Math.abs(rim - entity.radius) <= 0.5 &&
            withinSweep(
              angleAbout(point, { x: entity.cx, y: entity.cy }),
              entity.startAngle,
              entity.endAngle,
            );
          distance = onRim ? 0 : Number.POSITIVE_INFINITY;
        } else {
          distance = Math.hypot(point.x - entity.x, point.y - entity.y);
        }
        if (distance * scale <= HIT_TOLERANCE_PX) return entity.id;
      }
      return null;
    },
    [entities, scale],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): void => {
      const point = eventToWorkplane(event);
      if (point === null) return;
      onMove?.(point);
      if (onHover !== undefined) {
        onHover(hitEntity(point));
      }
    },
    [eventToWorkplane, hitEntity, onHover, onMove],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): void => {
      if (onPick === undefined) return;
      const point = eventToWorkplane(event);
      if (point === null) return;
      onPick({ entityId: hitEntity(point), point });
    },
    [eventToWorkplane, hitEntity, onPick],
  );

  // Colors: severity-driven, driven through fixed class tokens so the
  // surface stays on the design system (no raw hexes).
  const strokeFor = (entity: CadSketchCanvasEntity): string => {
    if (entity.diagnostic === "error") return "var(--color-destructive, #dc2626)";
    if (entity.diagnostic === "warning") return "var(--color-amber-500, #f59e0b)";
    if (entity.selected) return "var(--color-sky-400, #38bdf8)";
    if (entity.construction) return "var(--color-muted-foreground, #71717a)";
    return "var(--color-foreground, #0a0a0a)";
  };

  const strokeWidthFor = (entity: CadSketchCanvasEntity): number => {
    if (entity.selected) return 2.5;
    if (entity.id === hoveredEntityId) return 3;
    return 1.5;
  };

  const gridLines: ReactNode[] = [];
  const halfWidth = origin.x;
  const halfHeight = height - origin.y;
  const xExtent = Math.max(halfWidth, width - origin.x) / scale;
  const yExtent = Math.max(origin.y, halfHeight) / scale;
  for (let x = 0; x <= xExtent; x += gridStep) {
    for (const signed of [x, -x]) {
      const screen = toScreen({ x: signed, y: 0 });
      gridLines.push(
        signed === 0 ? null : (
          <line
            key={`grid-v-${String(signed)}`}
            stroke="var(--color-border, #e4e4e7)"
            strokeWidth={1}
            x1={screen.x}
            x2={screen.x}
            y1={0}
            y2={height}
          />
        ),
      );
    }
  }
  for (let y = 0; y <= yExtent; y += gridStep) {
    for (const signed of [y, -y]) {
      const screen = toScreen({ x: 0, y: signed });
      gridLines.push(
        signed === 0 ? null : (
          <line
            key={`grid-h-${String(signed)}`}
            stroke="var(--color-border, #e4e4e7)"
            strokeWidth={1}
            x1={0}
            x2={width}
            y1={screen.y}
            y2={screen.y}
          />
        ),
      );
    }
  }

  const axes = (() => {
    const originScreen = toScreen({ x: 0, y: 0 });
    return (
      <g aria-hidden="true">
        <line
          stroke="var(--color-muted-foreground, #71717a)"
          strokeWidth={1.25}
          x1={0}
          x2={width}
          y1={originScreen.y}
          y2={originScreen.y}
        />
        <line
          stroke="var(--color-muted-foreground, #71717a)"
          strokeWidth={1.25}
          x1={originScreen.x}
          x2={originScreen.x}
          y1={0}
          y2={height}
        />
        <text
          className="fill-muted-foreground font-mono"
          fontSize={10}
          x={width - 14}
          y={originScreen.y - 6}
        >
          X
        </text>
        <text
          className="fill-muted-foreground font-mono"
          fontSize={10}
          x={originScreen.x + 6}
          y={14}
        >
          Y
        </text>
      </g>
    );
  })();

  const entityNodes = entities.map((entity) => {
    const common = {
      "data-sketch-construction": entity.construction || undefined,
      "data-sketch-diagnostic": entity.diagnostic,
      "data-sketch-entity-id": entity.id,
      "data-sketch-selected": entity.selected || undefined,
      stroke: strokeFor(entity),
      strokeLinecap: "round" as const,
      strokeWidth: strokeWidthFor(entity),
      strokeDasharray:
        entity.construction && !entity.selected ? "5 4" : undefined,
      fill: "none",
    };
    switch (entity.kind) {
      case "point": {
        const screen = toScreen({ x: entity.x, y: entity.y });
        return (
          <rect
            key={entity.id}
            {...common}
            height={8}
            width={8}
            x={screen.x - 4}
            y={screen.y - 4}
          />
        );
      }
      case "line": {
        const from = toScreen({ x: entity.x1, y: entity.y1 });
        const to = toScreen({ x: entity.x2, y: entity.y2 });
        return (
          <line
            key={entity.id}
            {...common}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        );
      }
      case "circle": {
        const center = toScreen({ x: entity.cx, y: entity.cy });
        return (
          <circle
            key={entity.id}
            {...common}
            cx={center.x}
            cy={center.y}
            r={entity.radius * scale}
          />
        );
      }
      case "arc": {
        const start = toScreen({
          x: entity.cx + entity.radius * Math.cos(entity.startAngle),
          y: entity.cy + entity.radius * Math.sin(entity.startAngle),
        });
        const end = toScreen({
          x: entity.cx + entity.radius * Math.cos(entity.endAngle),
          y: entity.cy + entity.radius * Math.sin(entity.endAngle),
        });
        const sweepDegrees =
          (((entity.endAngle - entity.startAngle) % (Math.PI * 2)) +
            Math.PI * 2) %
          (Math.PI * 2);
        // Screen y is flipped, so the workplane's CCW sweep becomes SVG's
        // clockwise sweep flag (0).
        return (
          <path
            key={entity.id}
            {...common}
            d={`M ${start.x} ${start.y} A ${entity.radius * scale} ${entity.radius * scale} 0 ${sweepDegrees > Math.PI ? 1 : 0} 0 ${end.x} ${end.y}`}
          />
        );
      }
    }
  });

  const regionNodes = regions.map((region) => {
    const screenPoints = region.points.map(toScreen);
    const fill =
      region.diagnostic === "error"
        ? "var(--color-destructive, #dc2626)"
        : region.selected
          ? "var(--color-sky-400, #38bdf8)"
          : "var(--color-foreground, #0a0a0a)";
    return (
      <polygon
        key={region.id}
        data-sketch-region-id={region.id}
        data-sketch-selected={region.selected || undefined}
        fill={fill}
        fillOpacity={0.06}
        points={screenPoints
          .map((point) => `${point.x},${point.y}`)
          .join(" ")}
        stroke="none"
      />
    );
  });

  const annotationNodes = annotations.map((annotation) => {
    const screen = toScreen({ x: annotation.x, y: annotation.y });
    const color =
      annotation.level === "error"
        ? "var(--color-destructive, #dc2626)"
        : annotation.level === "warning"
          ? "var(--color-amber-600, #d97706)"
          : "var(--color-sky-600, #0284c7)";
    const textWidth = annotation.text.length * 6.2 + 8;
    return (
      <g key={annotation.id} data-sketch-annotation-id={annotation.id}>
        <rect
          fill="var(--color-background, #ffffff)"
          fillOpacity={0.85}
          height={15}
          rx={2}
          stroke={color}
          strokeWidth={0.75}
          width={textWidth}
          x={screen.x}
          y={screen.y - 14}
        />
        <text
          fill={color}
          fontSize={10}
          fontFamily="ui-monospace, monospace"
          x={screen.x + 4}
          y={screen.y - 3}
        >
          {annotation.text}
        </text>
      </g>
    );
  });

  const pickNodes = picks.map((pick, index) => {
    const screen = toScreen(pick);
    return (
      <g key={`pick-${String(index)}`}>
        <circle
          cy={screen.y}
          fill="var(--color-sky-400, #38bdf8)"
          r={4}
          stroke="var(--color-background, #ffffff)"
          strokeWidth={1.5}
          cx={screen.x}
        />
        <text
          fill="var(--color-sky-400, #38bdf8)"
          fontSize={9}
          fontFamily="ui-monospace, monospace"
          x={screen.x + 6}
          y={screen.y - 6}
        >
          {String(index + 1)}
        </text>
      </g>
    );
  });

  const previewNode = (() => {
    if (preview.kind === "line") {
      const from = toScreen(preview.from);
      const to = toScreen(preview.to);
      return (
        <line
          aria-hidden="true"
          stroke="var(--color-sky-400, #38bdf8)"
          strokeDasharray="4 3"
          strokeWidth={1.5}
          x1={from.x}
          x2={to.x}
          y1={from.y}
          y2={to.y}
        />
      );
    }
    if (preview.kind === "rectangle") {
      const from = toScreen(preview.from);
      const to = toScreen(preview.to);
      return (
        <rect
          aria-hidden="true"
          fill="var(--color-sky-400, #38bdf8)"
          fillOpacity={0.05}
          height={Math.abs(to.y - from.y)}
          stroke="var(--color-sky-400, #38bdf8)"
          strokeDasharray="4 3"
          strokeWidth={1.5}
          width={Math.abs(to.x - from.x)}
          x={Math.min(from.x, to.x)}
          y={Math.min(from.y, to.y)}
        />
      );
    }
    if (preview.kind === "circle") {
      const center = toScreen(preview.center);
      return (
        <circle
          aria-hidden="true"
          cx={center.x}
          cy={center.y}
          fill="none"
          r={Math.max(preview.radius * scale, 0.01)}
          stroke="var(--color-sky-400, #38bdf8)"
          strokeDasharray="4 3"
          strokeWidth={1.5}
        />
      );
    }
    return null;
  })();

  return (
    <div
      className={cn("border-border bg-background relative border", className)}
      data-hover-entity={hoveredEntityId ?? ""}
      data-slot="cad-sketch-canvas"
    >
      <span
        className="border-border bg-background text-muted-foreground absolute top-1.5 right-1.5 z-10 border px-1.5 py-0.5 font-mono text-[10px] tracking-wider"
        data-slot="cad-sketch-workplane-badge"
      >
        {labels.workplaneBadge}
      </span>
      <svg
        aria-label={labels.canvasLabel}
        data-sketch-surface=""
        height={height}
        onPointerDown={handlePointerDown}
        onPointerLeave={() => {
          // Leaving the surface is the deterministic end of hover feedback.
          onHover?.(null);
        }}
        onPointerMove={handlePointerMove}
        ref={svgRef}
        role="img"
        width={width}
      >
        {gridLines}
        {axes}
        {regionNodes}
        {entityNodes}
        {previewNode}
        {annotationNodes}
        {pickNodes}
      </svg>
    </div>
  );
}
