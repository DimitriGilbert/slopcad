/**
 * In-canvas dimension presentation (Phase 37): the deterministic geometry
 * of drawn dimensions — extension lines, dimension lines, leaders, the
 * angular arc — for the dimensional constraint kinds (`distance`,
 * `distanceX`, `distanceY`, `radius`, `diameter`, `angle`), as pure data in
 * workplane millimetres that the sketch canvas renders as its SVG overlay.
 *
 * ## Determinism
 *
 * Every presented shape is a closed-form function of the constraint and the
 * sketch's entity geometry: fixed offsets (`DIMENSION_*` constants below),
 * fixed anchor angles where a drawing has no natural one (π/4 on full
 * circles, a sweep bisector on arcs), fixed text-anchor fractions. No
 * layout state, no randomness, no clock — identical sketches present
 * identically, and {@link serializeDimensionPresentation} emits a
 * fixed-key-order record so machine surfaces and fixtures can assert the
 * exact presented geometry byte-for-byte.
 *
 * ## Fallback, not failure
 *
 * A constraint whose geometry cannot anchor a drawn dimension (an angle
 * between parallel lines has no vertex; a referenced entity is missing)
 * presents as a bare label at a deterministic fallback anchor (the first
 * referenced entity's midpoint region) rather than disappearing — the value
 * stays visible, honestly carried by a `label` presentation.
 */

import { valueIn } from "@slopcad/cad-core";
import type { PointTarget, SketchConstraint } from "./constraints";
import type { SketchEntity } from "./entities";
import type { Sketch } from "./sketch";

/** A workplane-space point in mm. */
export interface DimensionPoint {
  readonly x: number;
  readonly y: number;
}

/** Dimension-line offset from the measured geometry (mm). */
export const DIMENSION_LINE_OFFSET_MM = 8;

/** Extension-line overshoot past the dimension line (mm). */
export const DIMENSION_EXTENSION_OVERSHOOT_MM = 2;

/** Radius of the drawn angular arc (mm). */
export const DIMENSION_ANGULAR_ARC_RADIUS_MM = 12;

/** Text stand-off beyond the angular arc (mm). */
export const DIMENSION_ANGULAR_TEXT_STANDOFF_MM = 4;

/** Deterministic presentation angle for full circles (rad). */
export const DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD = Math.PI / 4;

/** Fraction along the leader/ray where radial text anchors. */
export const DIMENSION_TEXT_FRACTION = 0.6;

/**
 * Diametral-label stand-off beyond the rim along the across-line (mm): the
 * label anchors just past the rim instead of on the line at the center,
 * where it would sit on top of the across-line it names.
 */
export const DIAMETRAL_TEXT_STANDOFF_MM = 4;

/** The drawn dimension kinds the canvas renders. */
export type DimensionPresentation =
  | {
      /** Two measured points: extension lines, an offset dimension line. */
      readonly kind: "linear";
      readonly id: string;
      readonly text: string;
      readonly dimensionLine: {
        readonly from: DimensionPoint;
        readonly to: DimensionPoint;
      };
      readonly extensionLines: readonly (
        | { readonly from: DimensionPoint; readonly to: DimensionPoint }
        | undefined
      )[];
      readonly textAnchor: DimensionPoint;
    }
  | {
      /** A center→rim leader with the value at its midpoint fraction. */
      readonly kind: "radial";
      readonly id: string;
      readonly text: string;
      readonly leader: {
        readonly from: DimensionPoint;
        readonly to: DimensionPoint;
      };
      readonly textAnchor: DimensionPoint;
    }
  | {
      /** A full across-the-center line with arrows at both rim ends. */
      readonly kind: "diametral";
      readonly id: string;
      readonly text: string;
      readonly line: {
        readonly from: DimensionPoint;
        readonly to: DimensionPoint;
      };
      readonly textAnchor: DimensionPoint;
    }
  | {
      /** The angular arc between two directions from their vertex. */
      readonly kind: "angular";
      readonly id: string;
      readonly text: string;
      readonly arc: {
        readonly center: DimensionPoint;
        readonly radius: number;
        readonly startAngle: number;
        readonly endAngle: number;
      };
      readonly textAnchor: DimensionPoint;
    }
  | {
      /** The bare-label fallback (no drawable anchor). */
      readonly kind: "label";
      readonly id: string;
      readonly text: string;
      readonly textAnchor: DimensionPoint;
    };

/** Fixed-key-order wire form of a presentation (machine surfaces). */
export type SerializedDimensionPresentation =
  | {
      readonly kind: "linear";
      readonly id: string;
      readonly text: string;
      readonly dimensionLine: {
        readonly from: readonly [number, number];
        readonly to: readonly [number, number];
      };
      readonly extensionLines: readonly (readonly [
        number,
        number,
        number,
        number,
      ])[];
      readonly textAnchor: readonly [number, number];
    }
  | {
      readonly kind: "radial";
      readonly id: string;
      readonly text: string;
      readonly leader: readonly [number, number, number, number];
      readonly textAnchor: readonly [number, number];
    }
  | {
      readonly kind: "diametral";
      readonly id: string;
      readonly text: string;
      readonly line: readonly [number, number, number, number];
      readonly textAnchor: readonly [number, number];
    }
  | {
      readonly kind: "angular";
      readonly id: string;
      readonly text: string;
      readonly arc: {
        readonly center: readonly [number, number];
        readonly radius: number;
        readonly startAngle: number;
        readonly endAngle: number;
      };
      readonly textAnchor: readonly [number, number];
    }
  | {
      readonly kind: "label";
      readonly id: string;
      readonly text: string;
      readonly textAnchor: readonly [number, number];
    };

const point = (p: DimensionPoint): readonly [number, number] => [p.x, p.y];

const segment = (
  a: DimensionPoint,
  b: DimensionPoint,
): readonly [number, number, number, number] => [a.x, a.y, b.x, b.y];

/**
 * The workplane position of a constraint's point target — the shared
 * geometry readout the dimension presentation anchors on (moved here from
 * the editor so domain and surface share one source of truth).
 */
export function pointTargetPosition(
  entities: readonly SketchEntity[],
  target: PointTarget,
): DimensionPoint | null {
  const entity = entities.find((candidate) => candidate.id === target.entity);
  if (entity === undefined) return null;
  switch (entity.kind) {
    case "point":
      return { x: entity.x, y: entity.y };
    case "circle":
      return { x: entity.cx, y: entity.cy };
    case "line": {
      if (target.point === "start") return { x: entity.x1, y: entity.y1 };
      if (target.point === "end") return { x: entity.x2, y: entity.y2 };
      return {
        x: (entity.x1 + entity.x2) / 2,
        y: (entity.y1 + entity.y2) / 2,
      };
    }
    case "arc": {
      if (target.point === "start") {
        return {
          x: entity.cx + entity.radius * Math.cos(entity.startAngle),
          y: entity.cy + entity.radius * Math.sin(entity.startAngle),
        };
      }
      if (target.point === "end") {
        return {
          x: entity.cx + entity.radius * Math.cos(entity.endAngle),
          y: entity.cy + entity.radius * Math.sin(entity.endAngle),
        };
      }
      return { x: entity.cx, y: entity.cy };
    }
    case "ellipse":
    case "ellipticalArc": {
      const parametric = (t: number): DimensionPoint => {
        const u = entity.radiusX * Math.cos(t);
        const v = entity.radiusY * Math.sin(t);
        const c = Math.cos(entity.rotation);
        const s = Math.sin(entity.rotation);
        return {
          x: entity.cx + c * u - s * v,
          y: entity.cy + s * u + c * v,
        };
      };
      if (entity.kind === "ellipse") {
        if (target.point === "start") return parametric(0);
        if (target.point === "end") return parametric(Math.PI / 2);
        return { x: entity.cx, y: entity.cy };
      }
      if (target.point === "start") return parametric(entity.startAngle);
      if (target.point === "end") return parametric(entity.endAngle);
      return { x: entity.cx, y: entity.cy };
    }
    case "spline": {
      const first = entity.points[0];
      const last = entity.points[entity.points.length - 1];
      if (target.point === "start" && first !== undefined) return first;
      if (target.point === "end" && last !== undefined) return last;
      return null;
    }
    case "polygon": {
      if (target.point === "center") return { x: entity.cx, y: entity.cy };
      const effective =
        entity.fit === "inscribed"
          ? entity.radius
          : entity.radius / Math.cos(Math.PI / entity.sides);
      const k = target.point === "start" ? 0 : 1;
      const angle = entity.rotation + (Math.PI * 2 * k) / entity.sides;
      return {
        x: entity.cx + effective * Math.cos(angle),
        y: entity.cy + effective * Math.sin(angle),
      };
    }
    case "slot": {
      if (target.point === "start") return { x: entity.x1, y: entity.y1 };
      if (target.point === "end") {
        return entity.variant === "straight"
          ? { x: entity.x2, y: entity.y2 }
          : { x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 };
      }
      return entity.variant === "straight"
        ? { x: (entity.x1 + entity.x2) / 2, y: (entity.y1 + entity.y2) / 2 }
        : { x: entity.x2, y: entity.y2 };
    }
    case "rectangle":
      return null;
  }
}

/** The constraint's value text (`R 4 mm`, `60°`, …) or `null` when non-dimensional. */
export function dimensionText(constraint: SketchConstraint): string | null {
  switch (constraint.kind) {
    case "distance":
      return `${formatMagnitude(valueIn(constraint.value, "mm"))} mm`;
    case "distanceX":
      return `Δx ${formatMagnitude(valueIn(constraint.value, "mm"))} mm`;
    case "distanceY":
      return `Δy ${formatMagnitude(valueIn(constraint.value, "mm"))} mm`;
    case "radius":
      return `R ${formatMagnitude(valueIn(constraint.value, "mm"))}`;
    case "diameter":
      return `⌀ ${formatMagnitude(valueIn(constraint.value, "mm"))}`;
    case "angle":
      return `${formatMagnitude(valueIn(constraint.value, "deg"))}°`;
    default:
      return null;
  }
}

/**
 * Magnitudes render rounded to three decimals — a measured angle commits
 * its full double precision, but a dimension label carries 59.534°, not
 * fifteen digits of solver noise. Deterministic (round-half-away-from-zero
 * on exact halves of 1e-3), and integral values render without a decimal
 * point.
 */
function formatMagnitude(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The anchor angle for a circle/polygon rim presentation (deterministic). */
function rimPresentationAngle(entity: SketchEntity): number {
  if (entity.kind === "arc") {
    const sweep =
      (entity.endAngle - entity.startAngle + Math.PI * 2) % (Math.PI * 2);
    return (entity.startAngle + sweep / 2) % (Math.PI * 2);
  }
  return DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD;
}

/** Serializes a presentation to its fixed-key-order wire form. */
export function serializeDimensionPresentation(
  presentation: DimensionPresentation,
): SerializedDimensionPresentation {
  switch (presentation.kind) {
    case "linear":
      return {
        kind: "linear",
        id: presentation.id,
        text: presentation.text,
        dimensionLine: {
          from: point(presentation.dimensionLine.from),
          to: point(presentation.dimensionLine.to),
        },
        extensionLines: presentation.extensionLines
          .filter((line) => line !== undefined)
          .map((line) => segment(line.from, line.to)),
        textAnchor: point(presentation.textAnchor),
      };
    case "radial":
      return {
        kind: "radial",
        id: presentation.id,
        text: presentation.text,
        leader: segment(presentation.leader.from, presentation.leader.to),
        textAnchor: point(presentation.textAnchor),
      };
    case "diametral":
      return {
        kind: "diametral",
        id: presentation.id,
        text: presentation.text,
        line: segment(presentation.line.from, presentation.line.to),
        textAnchor: point(presentation.textAnchor),
      };
    case "angular":
      return {
        kind: "angular",
        id: presentation.id,
        text: presentation.text,
        arc: {
          center: point(presentation.arc.center),
          radius: presentation.arc.radius,
          startAngle: presentation.arc.startAngle,
          endAngle: presentation.arc.endAngle,
        },
        textAnchor: point(presentation.textAnchor),
      };
    case "label":
      return {
        kind: "label",
        id: presentation.id,
        text: presentation.text,
        textAnchor: point(presentation.textAnchor),
      };
  }
}

/** Intersection of two infinite lines a→b and c→d, or `null` when parallel. */
function infiniteIntersection(
  a: DimensionPoint,
  b: DimensionPoint,
  c: DimensionPoint,
  d: DimensionPoint,
): DimensionPoint | null {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c.x - a.x) * sY - (c.y - a.y) * sX) / denom;
  return { x: a.x + t * rX, y: a.y + t * rY };
}

/** The direction of the entity the angle constraint addresses (unit length). */
function angleDirectionOf(
  entities: readonly SketchEntity[],
  entityId: string,
  at: "start" | "end" | undefined,
): DimensionPoint | null {
  const entity = entities.find((candidate) => candidate.id === entityId);
  if (entity === undefined) return null;
  if (entity.kind === "line") {
    const dx = entity.x2 - entity.x1;
    const dy = entity.y2 - entity.y1;
    const length = Math.hypot(dx, dy);
    return length === 0 ? null : { x: dx / length, y: dy / length };
  }
  if (entity.kind === "spline" && entity.points.length >= 2) {
    const index = at === "start" ? 0 : entity.points.length - 2;
    const a = entity.points[index];
    const b = entity.points[index + 1];
    if (a === undefined || b === undefined) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    return length === 0 ? null : { x: dx / length, y: dy / length };
  }
  return null;
}

/**
 * Presents `constraint`'s drawn dimension against `sketch`'s entity
 * geometry, or the bare-label fallback when no drawable anchor exists.
 */
export function dimensionPresentation(
  sketch: Sketch,
  constraint: SketchConstraint,
): DimensionPresentation | null {
  const text = dimensionText(constraint);
  if (text === null) return null;
  switch (constraint.kind) {
    case "distance":
    case "distanceX":
    case "distanceY": {
      const a = pointTargetPosition(sketch.entities, constraint.first);
      const b = pointTargetPosition(sketch.entities, constraint.second);
      if (a === null || b === null) return null;
      if (constraint.kind === "distanceX") {
        // The measured separation is along x, so the dimension line runs
        // HORIZONTALLY between the points' x positions (parallel to the
        // measured axis), at the mid y; the extension lines drop each
        // point vertically onto it.
        const y = (a.y + b.y) / 2;
        const x0 = Math.min(a.x, b.x);
        const x1 = Math.max(a.x, b.x);
        const from = { x: x0, y };
        const to = { x: x1, y };
        return {
          kind: "linear",
          id: constraint.id,
          text,
          dimensionLine: { from, to },
          extensionLines: [
            { from: a, to: { x: a.x, y } },
            { from: b, to: { x: b.x, y } },
          ],
          textAnchor: { x: (x0 + x1) / 2, y },
        };
      }
      if (constraint.kind === "distanceY") {
        // The measured separation is along y: a VERTICAL dimension line
        // between the points' y positions, at the mid x; the extension
        // lines run each point horizontally onto it.
        const x = (a.x + b.x) / 2;
        const y0 = Math.min(a.y, b.y);
        const y1 = Math.max(a.y, b.y);
        const from = { x, y: y0 };
        const to = { x, y: y1 };
        return {
          kind: "linear",
          id: constraint.id,
          text,
          dimensionLine: { from, to },
          extensionLines: [
            { from: a, to: { x, y: a.y } },
            { from: b, to: { x, y: b.y } },
          ],
          textAnchor: { x, y: (y0 + y1) / 2 },
        };
      }
      // Aligned distance: the dimension line parallels a→b, offset along
      // the left normal; the extension lines run each point to it.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) return null;
      const nx = -dy / length;
      const ny = dx / length;
      const offset = DIMENSION_LINE_OFFSET_MM;
      const from = { x: a.x + nx * offset, y: a.y + ny * offset };
      const to = { x: b.x + nx * offset, y: b.y + ny * offset };
      const overshoot = DIMENSION_EXTENSION_OVERSHOOT_MM;
      return {
        kind: "linear",
        id: constraint.id,
        text,
        dimensionLine: { from, to },
        extensionLines: [
          {
            from: a,
            to: {
              x: a.x + nx * (offset + overshoot),
              y: a.y + ny * (offset + overshoot),
            },
          },
          {
            from: b,
            to: {
              x: b.x + nx * (offset + overshoot),
              y: b.y + ny * (offset + overshoot),
            },
          },
        ],
        textAnchor: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      };
    }
    case "radius": {
      const entity = sketch.entities.find(
        (candidate) => candidate.id === constraint.entity,
      );
      if (
        entity === undefined ||
        !(
          entity.kind === "circle" ||
          entity.kind === "arc" ||
          entity.kind === "polygon" ||
          entity.kind === "slot"
        )
      ) {
        return null;
      }
      if (entity.kind === "circle" || entity.kind === "arc") {
        const angle = rimPresentationAngle(entity);
        const center = { x: entity.cx, y: entity.cy };
        const rim = {
          x: center.x + entity.radius * Math.cos(angle),
          y: center.y + entity.radius * Math.sin(angle),
        };
        return {
          kind: "radial",
          id: constraint.id,
          text,
          leader: { from: center, to: rim },
          textAnchor: {
            x: center.x + (rim.x - center.x) * DIMENSION_TEXT_FRACTION,
            y: center.y + (rim.y - center.y) * DIMENSION_TEXT_FRACTION,
          },
        };
      }
      if (entity.kind === "polygon") {
        const center = { x: entity.cx, y: entity.cy };
        const rim = {
          x: center.x + entity.radius * Math.cos(entity.rotation),
          y: center.y + entity.radius * Math.sin(entity.rotation),
        };
        return {
          kind: "radial",
          id: constraint.id,
          text,
          leader: { from: center, to: rim },
          textAnchor: {
            x: center.x + (rim.x - center.x) * DIMENSION_TEXT_FRACTION,
            y: center.y + (rim.y - center.y) * DIMENSION_TEXT_FRACTION,
          },
        };
      }
      // Straight slot: the leader runs from the first cap center out along
      // the centerline's perpendicular to the stadium boundary.
      const cap = { x: entity.x1, y: entity.y1 };
      const other =
        entity.variant === "straight"
          ? { x: entity.x2, y: entity.y2 }
          : { x: entity.x2, y: entity.y2 };
      const dx = other.x - cap.x;
      const dy = other.y - cap.y;
      const length = Math.hypot(dx, dy);
      const angle =
        length === 0
          ? DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD
          : Math.atan2(dy, dx) + Math.PI / 2;
      const rim = {
        x: cap.x + entity.radius * Math.cos(angle),
        y: cap.y + entity.radius * Math.sin(angle),
      };
      return {
        kind: "radial",
        id: constraint.id,
        text,
        leader: { from: cap, to: rim },
        textAnchor: {
          x: cap.x + (rim.x - cap.x) * DIMENSION_TEXT_FRACTION,
          y: cap.y + (rim.y - cap.y) * DIMENSION_TEXT_FRACTION,
        },
      };
    }
    case "diameter": {
      const entity = sketch.entities.find(
        (candidate) => candidate.id === constraint.entity,
      );
      if (
        entity === undefined ||
        !(
          entity.kind === "circle" ||
          entity.kind === "arc" ||
          entity.kind === "polygon" ||
          entity.kind === "slot"
        )
      ) {
        return null;
      }
      if (entity.kind === "circle" || entity.kind === "arc") {
        const angle = rimPresentationAngle(entity);
        const center = { x: entity.cx, y: entity.cy };
        // The label anchors just beyond the rim on the across-line's +angle
        // end — clear of the line it names (an on-center anchor sits on the
        // across-line itself).
        const reach = entity.radius + DIAMETRAL_TEXT_STANDOFF_MM;
        return {
          kind: "diametral",
          id: constraint.id,
          text,
          line: {
            from: {
              x: center.x + entity.radius * Math.cos(angle),
              y: center.y + entity.radius * Math.sin(angle),
            },
            to: {
              x: center.x - entity.radius * Math.cos(angle),
              y: center.y - entity.radius * Math.sin(angle),
            },
          },
          textAnchor: {
            x: center.x + reach * Math.cos(angle),
            y: center.y + reach * Math.sin(angle),
          },
        };
      }
      if (entity.kind === "polygon") {
        const center = { x: entity.cx, y: entity.cy };
        const reach = entity.radius + DIAMETRAL_TEXT_STANDOFF_MM;
        return {
          kind: "diametral",
          id: constraint.id,
          text,
          line: {
            from: {
              x: center.x + entity.radius * Math.cos(entity.rotation),
              y: center.y + entity.radius * Math.sin(entity.rotation),
            },
            to: {
              x: center.x - entity.radius * Math.cos(entity.rotation),
              y: center.y - entity.radius * Math.sin(entity.rotation),
            },
          },
          textAnchor: {
            x: center.x + reach * Math.cos(entity.rotation),
            y: center.y + reach * Math.sin(entity.rotation),
          },
        };
      }
      const cap = { x: entity.x1, y: entity.y1 };
      const other = { x: entity.x2, y: entity.y2 };
      const dx = other.x - cap.x;
      const dy = other.y - cap.y;
      const length = Math.hypot(dx, dy);
      const angle =
        length === 0
          ? DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD
          : Math.atan2(dy, dx) + Math.PI / 2;
      const reach = entity.radius + DIAMETRAL_TEXT_STANDOFF_MM;
      return {
        kind: "diametral",
        id: constraint.id,
        text,
        line: {
          from: {
            x: cap.x + entity.radius * Math.cos(angle),
            y: cap.y + entity.radius * Math.sin(angle),
          },
          to: {
            x: cap.x - entity.radius * Math.cos(angle),
            y: cap.y - entity.radius * Math.sin(angle),
          },
        },
        textAnchor: {
          x: cap.x + reach * Math.cos(angle),
          y: cap.y + reach * Math.sin(angle),
        },
      };
    }
    case "angle": {
      const u = angleDirectionOf(
        sketch.entities,
        constraint.first,
        constraint.at,
      );
      const v = angleDirectionOf(
        sketch.entities,
        constraint.second,
        constraint.at,
      );
      if (u === null || v === null) return null;
      const firstLine = sketch.entities.find(
        (candidate) => candidate.id === constraint.first,
      );
      const secondLine = sketch.entities.find(
        (candidate) => candidate.id === constraint.second,
      );
      if (
        firstLine === undefined ||
        secondLine === undefined ||
        firstLine.kind !== "line" ||
        secondLine.kind !== "line"
      ) {
        return null;
      }
      const vertex = infiniteIntersection(
        { x: firstLine.x1, y: firstLine.y1 },
        { x: firstLine.x2, y: firstLine.y2 },
        { x: secondLine.x1, y: secondLine.y1 },
        { x: secondLine.x2, y: secondLine.y2 },
      );
      if (vertex === null) {
        // Parallel operands: no vertex to draw the arc at — bare label at
        // the first operand's midpoint.
        return {
          kind: "label",
          id: constraint.id,
          text,
          textAnchor: {
            x: (firstLine.x1 + firstLine.x2) / 2,
            y: (firstLine.y1 + firstLine.y2) / 2,
          },
        };
      }
      const startAngle = Math.atan2(u.y, u.x);
      const valueRad = valueIn(constraint.value, "deg") * (Math.PI / 180);
      const endAngle = startAngle + valueRad;
      const bisector = startAngle + valueRad / 2;
      const standOff =
        DIMENSION_ANGULAR_ARC_RADIUS_MM + DIMENSION_ANGULAR_TEXT_STANDOFF_MM;
      return {
        kind: "angular",
        id: constraint.id,
        text,
        arc: {
          center: vertex,
          radius: DIMENSION_ANGULAR_ARC_RADIUS_MM,
          startAngle,
          endAngle,
        },
        textAnchor: {
          x: vertex.x + standOff * Math.cos(bisector),
          y: vertex.y + standOff * Math.sin(bisector),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Presents every dimensional constraint of the sketch, in constraint
 * order, skipping constraints that cannot present (non-dimensional or
 * fully unanchorable).
 */
export function sketchDimensionPresentations(
  sketch: Sketch,
): readonly DimensionPresentation[] {
  const presentations: DimensionPresentation[] = [];
  for (const constraint of sketch.constraints) {
    const presentation = dimensionPresentation(sketch, constraint);
    if (presentation !== null) presentations.push(presentation);
  }
  return presentations;
}
