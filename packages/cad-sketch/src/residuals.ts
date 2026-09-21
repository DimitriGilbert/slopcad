/**
 * Constraint-system compilation: entities + constraints → residual rows with
 * analytic gradients, and the parameter layout that packs entities into the
 * solver's unknown vector.
 *
 * The parameter vector packs entities in array order — point (x, y); line
 * (x1, y1, x2, y2); circle (cx, cy, r); arc (cx, cy, r, a0, a1); rectangle
 * contributes nothing — so slot indices are a pure function of the entity
 * list and identical inputs compile identically.
 *
 * Every residual is compiled with its exact analytic gradient (no numeric
 * differencing): the residuals are polynomials, trig, and square roots of
 * small expressions, so the derivatives are cheap and exact, which is what
 * makes Gauss-Newton converge in a handful of iterations. Residual scales
 * are documented per constraint kind in `constraints.ts`; gradients are
 * sparse maps of slot → ∂r/∂slot.
 *
 * Rectangle entities compile to implicit residual rows (the integrity rule):
 * four coincidences chaining each edge's end to the next edge's start
 * (cyclically), `e0 ∥ e2`, `e1 ∥ e3`, and `e0 ⊥ e1`.
 */

import { valueIn } from "@slopcad/cad-core";
import type { SketchDiagnostic } from "./diagnostics";
import type { SketchEntity } from "./entities";
import type { SketchConstraintId, SketchEntityId } from "./sketch-ids";
import type { SolvedEntityParameters, SolvedSketchParameters } from "./solver";

import {
  type SplineChain,
  bezierChainOfSpline,
  cubicStationaryParameters,
  evaluateSplinePoint,
  projectOntoSpline,
  splinePointGradient,
  splineTangent,
  splineTangentGradient,
} from "./spline-math";
import {
  type PointTarget,
  type SketchConstraint,
  type SplineEndSelection,
  validateConstraintReferences,
} from "./constraints";

/** Slot offsets of one entity inside the parameter vector. */
interface EntitySlots {
  readonly kind: SketchEntity["kind"];
  readonly offsets: readonly number[];
}

/**
 * Maps entities to parameter slots. `offsets` follows the entity's documented
 * parameter order: point (x, y); line (x1, y1, x2, y2); circle (cx, cy, r);
 * arc (cx, cy, r, a0, a1); ellipse (cx, cy, a, b, ρ); ellipticalArc
 * (cx, cy, a, b, ρ, a0, a1); spline (x, y per stored point, in point order);
 * polygon (cx, cy, r, ρ — the side count and fit are discrete parameters);
 * slot straight (x1, y1, x2, y2, r); slot arc3 (x1, y1, x2, y2, x3, y3, r).
 * Rectangles carry no slots.
 */
export class ParameterLayout {
  private readonly slotsByEntity: ReadonlyMap<SketchEntityId, EntitySlots>;
  readonly parameterCount: number;

  constructor(entities: readonly SketchEntity[]) {
    const slotsByEntity = new Map<SketchEntityId, EntitySlots>();
    let next = 0;
    const take = (count: number): number[] => {
      const offsets = Array.from({ length: count }, (_, i) => next + i);
      next += count;
      return offsets;
    };
    for (const entity of entities) {
      switch (entity.kind) {
        case "point":
          slotsByEntity.set(entity.id, { kind: "point", offsets: take(2) });
          break;
        case "line":
          slotsByEntity.set(entity.id, { kind: "line", offsets: take(4) });
          break;
        case "circle":
          slotsByEntity.set(entity.id, { kind: "circle", offsets: take(3) });
          break;
        case "arc":
          slotsByEntity.set(entity.id, { kind: "arc", offsets: take(5) });
          break;
        case "ellipse":
          slotsByEntity.set(entity.id, { kind: "ellipse", offsets: take(5) });
          break;
        case "ellipticalArc":
          slotsByEntity.set(entity.id, {
            kind: "ellipticalArc",
            offsets: take(7),
          });
          break;
        case "spline":
          slotsByEntity.set(entity.id, {
            kind: "spline",
            offsets: take(2 * entity.points.length),
          });
          break;
        case "polygon":
          slotsByEntity.set(entity.id, { kind: "polygon", offsets: take(4) });
          break;
        case "slot":
          slotsByEntity.set(entity.id, {
            kind: "slot",
            offsets: take(entity.variant === "arc3" ? 7 : 5),
          });
          break;
        case "rectangle":
          slotsByEntity.set(entity.id, { kind: "rectangle", offsets: [] });
          break;
      }
    }
    this.slotsByEntity = slotsByEntity;
    this.parameterCount = next;
  }

  slotsOf(id: SketchEntityId): EntitySlots | undefined {
    return this.slotsByEntity.get(id);
  }
}

/** Packs the entities' current parameters into the initial vector. */
export function packInitialParameters(
  entities: readonly SketchEntity[],
): number[] {
  const values: number[] = [];
  for (const entity of entities) {
    switch (entity.kind) {
      case "point":
        values.push(entity.x, entity.y);
        break;
      case "line":
        values.push(entity.x1, entity.y1, entity.x2, entity.y2);
        break;
      case "circle":
        values.push(entity.cx, entity.cy, entity.radius);
        break;
      case "arc":
        values.push(
          entity.cx,
          entity.cy,
          entity.radius,
          entity.startAngle,
          entity.endAngle,
        );
        break;
      case "ellipse":
        values.push(
          entity.cx,
          entity.cy,
          entity.radiusX,
          entity.radiusY,
          entity.rotation,
        );
        break;
      case "ellipticalArc":
        values.push(
          entity.cx,
          entity.cy,
          entity.radiusX,
          entity.radiusY,
          entity.rotation,
          entity.startAngle,
          entity.endAngle,
        );
        break;
      case "spline":
        for (const point of entity.points) values.push(point.x, point.y);
        break;
      case "polygon":
        values.push(entity.cx, entity.cy, entity.radius, entity.rotation);
        break;
      case "slot":
        values.push(entity.x1, entity.y1, entity.x2, entity.y2);
        if (entity.variant === "arc3") {
          values.push(arc3EndOf(entity).x, arc3EndOf(entity).y);
        }
        values.push(entity.radius);
        break;
      case "rectangle":
        break;
    }
  }
  return values;
}

/**
 * The arc3 slot's end point — always present on validated entities; a
 * missing field is a structural corruption that must fail loudly.
 */
function arc3EndOf(entity: {
  readonly id: SketchEntityId;
  readonly variant: string;
  readonly x3?: number;
  readonly y3?: number;
}): { readonly x: number; readonly y: number } {
  if (entity.x3 === undefined || entity.y3 === undefined) {
    throw new RangeError(
      `Arc3 slot ${entity.id} is missing its x3/y3 fields; arc3 slots always carry x1..y3.`,
    );
  }
  return { x: entity.x3, y: entity.y3 };
}

/** Unpacks a solved vector back into per-entity parameters. */
export function unpackSolvedParameters(
  entities: readonly SketchEntity[],
  parameters: readonly number[],
  layout: ParameterLayout,
): SolvedSketchParameters {
  const solved: SolvedEntityParameters[] = entities.map((entity) => {
    const slots = layout.slotsOf(entity.id);
    const offset = (localIndex: number): number => {
      const global = slots?.offsets[localIndex];
      if (global === undefined) {
        throw new RangeError(`Missing parameter slot for entity ${entity.id}.`);
      }
      const value = parameters[global];
      if (value === undefined) {
        throw new RangeError(
          `Missing parameter value for entity ${entity.id}.`,
        );
      }
      return value;
    };
    switch (entity.kind) {
      case "point":
        return { id: entity.id, kind: "point", x: offset(0), y: offset(1) };
      case "line":
        return {
          id: entity.id,
          kind: "line",
          x1: offset(0),
          y1: offset(1),
          x2: offset(2),
          y2: offset(3),
        };
      case "circle":
        return {
          id: entity.id,
          kind: "circle",
          cx: offset(0),
          cy: offset(1),
          radius: offset(2),
        };
      case "arc": {
        const startAngle = offset(3);
        const endAngle = offset(4);
        // Guard the independent canonicalization: a tiny negative raw sweep
        // would wrap endAngle forward into a near-full circle (2π − ε)
        // while the arc's own invariant demands a non-degenerate sweep.
        if (solvedArcSweepIsDegenerate(startAngle, endAngle)) {
          throw new RangeError(
            `Solved arc parameters for entity ${entity.id} are degenerate: the sweep from ${String(startAngle)} to ${String(endAngle)} collapses or wraps to a near-full circle; an arc must sweep a positive angle away from 0 and 2π.`,
          );
        }
        return {
          id: entity.id,
          kind: "arc",
          cx: offset(0),
          cy: offset(1),
          radius: offset(2),
          startAngle: canonicalAngle(startAngle),
          endAngle: canonicalAngle(endAngle),
        };
      }
      case "rectangle":
        return { id: entity.id, kind: "rectangle" };
      case "ellipse":
        return {
          id: entity.id,
          kind: "ellipse",
          cx: offset(0),
          cy: offset(1),
          radiusX: offset(2),
          radiusY: offset(3),
          rotation: canonicalAngle(offset(4)),
        };
      case "ellipticalArc": {
        const startAngle = offset(5);
        const endAngle = offset(6);
        // The same degenerate-sweep guard arcs carry: a collapsed or
        // wrapped-near-full parametric sweep is not a physical arc.
        if (solvedArcSweepIsDegenerate(startAngle, endAngle)) {
          throw new RangeError(
            `Solved elliptical arc parameters for entity ${entity.id} are degenerate: the parametric sweep from ${String(startAngle)} to ${String(endAngle)} collapses or wraps to a near-full ellipse.`,
          );
        }
        return {
          id: entity.id,
          kind: "ellipticalArc",
          cx: offset(0),
          cy: offset(1),
          radiusX: offset(2),
          radiusY: offset(3),
          rotation: canonicalAngle(offset(4)),
          startAngle: canonicalAngle(startAngle),
          endAngle: canonicalAngle(endAngle),
        };
      }
      case "spline": {
        const points = entity.points.map((_, index) => ({
          x: offset(2 * index),
          y: offset(2 * index + 1),
        }));
        return { id: entity.id, kind: "spline", points };
      }
      case "polygon":
        return {
          id: entity.id,
          kind: "polygon",
          cx: offset(0),
          cy: offset(1),
          radius: offset(2),
          rotation: canonicalAngle(offset(3)),
        };
      case "slot":
        if (entity.variant === "straight") {
          return {
            id: entity.id,
            kind: "slot",
            variant: entity.variant,
            x1: offset(0),
            y1: offset(1),
            x2: offset(2),
            y2: offset(3),
            radius: offset(4),
          };
        }
        return {
          id: entity.id,
          kind: "slot",
          variant: entity.variant,
          x1: offset(0),
          y1: offset(1),
          x2: offset(2),
          y2: offset(3),
          x3: offset(4),
          y3: offset(5),
          radius: offset(6),
        };
    }
  });
  return { entities: solved };
}

function canonicalAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = angle % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
}

/**
 * How far (rad) a solved arc's forward sweep must stay from 0 and 2π: a
 * sweep within this of either end is numerically degenerate — it either
 * collapses the arc to (near) zero sweep or, for a tiny negative raw
 * remainder, wraps the independent canonicalization into a near-full
 * circle. Matches the convergence-tolerance scale the solver judges
 * residuals at.
 */
const SOLVED_ARC_DEGENERATE_SWEEP_EPSILON = 1e-9;

/**
 * Whether raw solved arc angles carry a degenerate forward sweep: the
 * canonicalized `endAngle − startAngle` lies within
 * {@link SOLVED_ARC_DEGENERATE_SWEEP_EPSILON} of 0 (a collapsed arc) or of
 * 2π (a tiny negative raw remainder that canonicalization would wrap into a
 * near-full circle).
 */
export function solvedArcSweepIsDegenerate(
  startAngle: number,
  endAngle: number,
): boolean {
  const sweep = canonicalAngle(endAngle - startAngle);
  const twoPi = Math.PI * 2;
  return (
    sweep < SOLVED_ARC_DEGENERATE_SWEEP_EPSILON ||
    sweep > twoPi - SOLVED_ARC_DEGENERATE_SWEEP_EPSILON
  );
}

/** A residual value plus its sparse analytic gradient. */
export interface ResidualEvaluation {
  readonly value: number;
  readonly grad: ReadonlyMap<number, number>;
}

/** Which sketch object a residual row came from. */
export type ResidualOrigin =
  | { readonly type: "explicit"; readonly id: SketchConstraintId }
  | { readonly type: "implicit"; readonly id: SketchEntityId };

/** One scalar equation of the compiled constraint system. */
export interface ResidualRow {
  readonly label: string;
  readonly origin: ResidualOrigin;
  evaluate(parameters: readonly number[]): ResidualEvaluation;
}

/** Either the compiled rows, or the diagnostics that blocked compilation. */
export type CompiledSystem =
  | { readonly rows: readonly ResidualRow[] }
  | { readonly diagnostics: readonly SketchDiagnostic[] };

/** A first-order expression in the parameters (value + gradient). */
interface LinExpr {
  readonly value: number;
  readonly grad: ReadonlyMap<number, number>;
}

/** `sA·a + sB·b` for first-order expressions. */
function combineExpr(a: LinExpr, b: LinExpr, sA: number, sB: number): LinExpr {
  const grad = new Map<number, number>();
  for (const [slot, coeff] of a.grad) grad.set(slot, sA * coeff);
  for (const [slot, coeff] of b.grad) {
    grad.set(slot, (grad.get(slot) ?? 0) + sB * coeff);
  }
  return { value: sA * a.value + sB * b.value, grad };
}

function subtractExpr(a: LinExpr, b: LinExpr): LinExpr {
  return combineExpr(a, b, 1, -1);
}

/**
 * A line's direction geometry with gradients: direction `(dx, dy)`, length
 * `L`, and their derivatives w.r.t. the line's four slots.
 */
interface LineGeom {
  readonly dx: number;
  readonly dy: number;
  readonly length: number;
  readonly ddx: ReadonlyMap<number, number>;
  readonly ddy: ReadonlyMap<number, number>;
  readonly dLength: ReadonlyMap<number, number>;
}

function lineGeom(parameters: readonly number[], slots: EntitySlots): LineGeom {
  const [x1s, y1s, x2s, y2s] = slots.offsets;
  if (
    x1s === undefined ||
    y1s === undefined ||
    x2s === undefined ||
    y2s === undefined
  ) {
    throw new RangeError("Line entity is missing parameter slots.");
  }
  const x1 = parameters[x1s];
  const y1 = parameters[y1s];
  const x2 = parameters[x2s];
  const y2 = parameters[y2s];
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined
  ) {
    throw new RangeError("Line entity is missing parameter values.");
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const ddx = new Map<number, number>([
    [x1s, -1],
    [x2s, 1],
  ]);
  const ddy = new Map<number, number>([
    [y1s, -1],
    [y2s, 1],
  ]);
  const dLength = new Map<number, number>();
  if (length > 0) {
    for (const [slot, coeff] of ddx) dLength.set(slot, (dx / length) * coeff);
    for (const [slot, coeff] of ddy)
      dLength.set(slot, (dLength.get(slot) ?? 0) + (dy / length) * coeff);
  }
  return { dx, dy, length, ddx, ddy, dLength };
}

/** Chain rule: `a·∂f/∂u + b·∂f/∂v` where f depends on slot-gradients du, dv. */
function chain(
  a: number,
  du: ReadonlyMap<number, number>,
  b: number,
  dv: ReadonlyMap<number, number>,
): Map<number, number> {
  const grad = new Map<number, number>();
  for (const [slot, coeff] of du)
    grad.set(slot, (grad.get(slot) ?? 0) + a * coeff);
  for (const [slot, coeff] of dv)
    grad.set(slot, (grad.get(slot) ?? 0) + b * coeff);
  return grad;
}

function addInto(
  target: Map<number, number>,
  source: ReadonlyMap<number, number>,
  scale: number,
): void {
  for (const [slot, coeff] of source) {
    target.set(slot, (target.get(slot) ?? 0) + scale * coeff);
  }
}

interface CompiledContext {
  readonly layout: ParameterLayout;
  readonly entitiesById: ReadonlyMap<SketchEntityId, SketchEntity>;
}

/**
 * Resolves a point target to its x (or y) expression. Arc endpoints are
 * `center + radius·(cos a, sin a)`; a line's `center` is its midpoint; a
 * point/circle entity only offers `center`.
 */
function pointExpr(
  target: PointTarget,
  context: CompiledContext,
  parameters: readonly number[],
  axis: "x" | "y",
): LinExpr {
  const slots = context.layout.slotsOf(target.entity);
  if (slots === undefined) {
    throw new RangeError(
      `Point target references unknown entity ${target.entity}.`,
    );
  }
  const value = (localIndex: number): number => {
    const global = slots.offsets[localIndex];
    if (global === undefined) {
      throw new RangeError(
        `Entity ${target.entity} is missing a parameter slot.`,
      );
    }
    const v = parameters[global];
    if (v === undefined) {
      throw new RangeError(
        `Entity ${target.entity} is missing a parameter value.`,
      );
    }
    return v;
  };
  const slot = (localIndex: number): number => {
    const global = slots.offsets[localIndex];
    if (global === undefined) {
      throw new RangeError(
        `Entity ${target.entity} is missing a parameter slot.`,
      );
    }
    return global;
  };
  const slotGrad = (
    localIndex: number,
    coefficient: number,
  ): Map<number, number> => new Map([[slot(localIndex), coefficient]]);
  switch (slots.kind) {
    case "point": {
      const local = axis === "x" ? 0 : 1;
      return { value: value(local), grad: slotGrad(local, 1) };
    }
    case "line":
      switch (target.point) {
        case "start": {
          const local = axis === "x" ? 0 : 1;
          return { value: value(local), grad: slotGrad(local, 1) };
        }
        case "end": {
          const local = axis === "x" ? 2 : 3;
          return { value: value(local), grad: slotGrad(local, 1) };
        }
        case "center": {
          const a = axis === "x" ? 0 : 1;
          const b = axis === "x" ? 2 : 3;
          return combineExpr(
            { value: value(a), grad: slotGrad(a, 1) },
            { value: value(b), grad: slotGrad(b, 1) },
            0.5,
            0.5,
          );
        }
      }
      break;
    case "circle":
      return {
        value: value(axis === "x" ? 0 : 1),
        grad: slotGrad(axis === "x" ? 0 : 1, 1),
      };
    case "arc":
      switch (target.point) {
        case "center":
          return {
            value: value(axis === "x" ? 0 : 1),
            grad: slotGrad(axis === "x" ? 0 : 1, 1),
          };
        case "start":
        case "end": {
          const angleLocal = target.point === "start" ? 3 : 4;
          const angle = value(angleLocal);
          const radius = value(2);
          const trig = axis === "x" ? Math.cos(angle) : Math.sin(angle);
          const dTrig = axis === "x" ? -Math.sin(angle) : Math.cos(angle);
          const grad = new Map<number, number>();
          grad.set(slot(axis === "x" ? 0 : 1), 1);
          grad.set(slot(2), trig);
          grad.set(slot(angleLocal), radius * dTrig);
          return { value: value(axis === "x" ? 0 : 1) + radius * trig, grad };
        }
      }
      break;
    case "rectangle":
      throw new RangeError(
        `Point target references rectangle ${target.entity}; rectangles have no point targets.`,
      );
    case "ellipse":
      switch (target.point) {
        case "center":
          return {
            value: value(axis === "x" ? 0 : 1),
            grad: slotGrad(axis === "x" ? 0 : 1, 1),
          };
        case "start":
        case "end": {
          // `start` is the major-axis end: center + R(ρ)·(a, 0); `end` is
          // the minor-axis end: center + R(ρ)·(0, b).
          const major = target.point === "start";
          const cosRho = Math.cos(value(4));
          const sinRho = Math.sin(value(4));
          const length = value(major ? 2 : 3);
          const grad = new Map<number, number>();
          const centerLocal = axis === "x" ? 0 : 1;
          grad.set(slot(centerLocal), 1);
          if (major) {
            grad.set(slot(2), axis === "x" ? cosRho : sinRho);
            grad.set(
              slot(4),
              axis === "x" ? -sinRho * length : cosRho * length,
            );
          } else {
            grad.set(slot(3), axis === "x" ? -sinRho : cosRho);
            grad.set(
              slot(4),
              axis === "x" ? -cosRho * length : -sinRho * length,
            );
          }
          return {
            value:
              value(centerLocal) +
              (major
                ? axis === "x"
                  ? cosRho * length
                  : sinRho * length
                : axis === "x"
                  ? -sinRho * length
                  : cosRho * length),
            grad,
          };
        }
      }
      break;
    case "ellipticalArc":
      switch (target.point) {
        case "center":
          return {
            value: value(axis === "x" ? 0 : 1),
            grad: slotGrad(axis === "x" ? 0 : 1, 1),
          };
        case "start":
        case "end": {
          // The parametric point at t: center + R(ρ)·(a·cos t, b·sin t),
          // with its exact gradient over (cx, cy, a, b, ρ, t).
          const angleLocal = target.point === "start" ? 5 : 6;
          const t = value(angleLocal);
          const a = value(2);
          const b = value(3);
          const rho = value(4);
          const cosRho = Math.cos(rho);
          const sinRho = Math.sin(rho);
          const cosT = Math.cos(t);
          const sinT = Math.sin(t);
          const u = a * cosT;
          const v = b * sinT;
          const grad = new Map<number, number>();
          const centerLocal = axis === "x" ? 0 : 1;
          grad.set(slot(centerLocal), 1);
          grad.set(slot(2), axis === "x" ? cosRho * cosT : sinRho * cosT);
          grad.set(slot(3), axis === "x" ? -sinRho * sinT : cosRho * sinT);
          grad.set(
            slot(4),
            axis === "x" ? -sinRho * u - cosRho * v : cosRho * u - sinRho * v,
          );
          grad.set(
            slot(angleLocal),
            axis === "x"
              ? cosRho * -a * sinT - sinRho * b * cosT
              : sinRho * -a * sinT + cosRho * b * cosT,
          );
          return {
            value:
              value(centerLocal) +
              (axis === "x"
                ? cosRho * u - sinRho * v
                : sinRho * u + cosRho * v),
            grad,
          };
        }
      }
      break;
    case "spline": {
      // Start = the first stored point (slots 0, 1); end = the last.
      const pointCount = slots.offsets.length / 2;
      const local =
        target.point === "start"
          ? axis === "x"
            ? 0
            : 1
          : axis === "x"
            ? 2 * (pointCount - 1)
            : 2 * (pointCount - 1) + 1;
      return { value: value(local), grad: slotGrad(local, 1) };
    }
    case "polygon": {
      // Layout (cx, cy, r, ρ). `start` is vertex 0 (at the rotation), `end`
      // vertex 1; the effective circumradius scales the authored radius by
      // 1/cos(π/n) for the circumscribed fit.
      const entity = context.entitiesById.get(target.entity);
      if (
        entity === undefined ||
        entity.kind !== "polygon" ||
        slots.offsets.length !== 4
      ) {
        throw new RangeError(
          `Point target references unknown polygon ${target.entity}.`,
        );
      }
      const centerLocal = axis === "x" ? 0 : 1;
      if (target.point === "center") {
        return {
          value: value(centerLocal),
          grad: slotGrad(centerLocal, 1),
        };
      }
      const k = target.point === "start" ? 0 : 1;
      const theta = value(3) + (Math.PI * 2 * k) / entity.sides;
      const scale =
        entity.fit === "inscribed" ? 1 : 1 / Math.cos(Math.PI / entity.sides);
      const effective = scale * value(2);
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const grad = new Map<number, number>();
      grad.set(slot(centerLocal), 1);
      grad.set(slot(2), scale * (axis === "x" ? cosT : sinT));
      grad.set(slot(3), axis === "x" ? -effective * sinT : effective * cosT);
      return {
        value:
          value(centerLocal) +
          (axis === "x" ? effective * cosT : effective * sinT),
        grad,
      };
    }
    case "slot": {
      // Straight layout (x1, y1, x2, y2, r): start = (x1, y1), end =
      // (x2, y2), center = the cap-center midpoint. Arc3 layout adds
      // (x3, y3) before r: start = (x1, y1), end = (x3, y3), center =
      // the through point (x2, y2).
      const straight = slots.offsets.length === 5;
      switch (target.point) {
        case "start":
          return {
            value: value(axis === "x" ? 0 : 1),
            grad: slotGrad(axis === "x" ? 0 : 1, 1),
          };
        case "end": {
          const endX = straight ? 2 : 4;
          const local = axis === "x" ? endX : endX + 1;
          return { value: value(local), grad: slotGrad(local, 1) };
        }
        case "center": {
          if (straight) {
            const a = axis === "x" ? 0 : 1;
            const b = axis === "x" ? 2 : 3;
            return combineExpr(
              { value: value(a), grad: slotGrad(a, 1) },
              { value: value(b), grad: slotGrad(b, 1) },
              0.5,
              0.5,
            );
          }
          const local = axis === "x" ? 2 : 3;
          return { value: value(local), grad: slotGrad(local, 1) };
        }
      }
      break;
    }
  }
}

function lineSlotsOf(
  id: SketchEntityId,
  context: CompiledContext,
): EntitySlots {
  const entity = context.entitiesById.get(id);
  const slots = context.layout.slotsOf(id);
  if (entity === undefined || entity.kind !== "line" || slots === undefined) {
    throw new RangeError(`Constraint references unknown line ${id}.`);
  }
  return slots;
}

function circularSlotsOf(
  id: SketchEntityId,
  context: CompiledContext,
): EntitySlots {
  const entity = context.entitiesById.get(id);
  const slots = context.layout.slotsOf(id);
  if (
    entity === undefined ||
    (entity.kind !== "circle" && entity.kind !== "arc") ||
    slots === undefined
  ) {
    throw new RangeError(`Constraint references unknown circle/arc ${id}.`);
  }
  return slots;
}

/**
 * Point-on-line: the signed distance from the point target to the line's
 * INFINITE line (the tangency convention — segment clipping is the
 * profile domain's business).
 */
function pointOnLineRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  lineId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const line = lineGeom(parameters, lineSlotsOf(lineId, context));
      const px = pointExpr(target, context, parameters, "x");
      const py = pointExpr(target, context, parameters, "y");
      const [x1Slot, y1Slot] = lineSlotsOf(lineId, context).offsets;
      if (x1Slot === undefined || y1Slot === undefined) {
        throw new RangeError("Point-on-line line operand is missing slots.");
      }
      const x1 = parameters[x1Slot];
      const y1 = parameters[y1Slot];
      if (x1 === undefined || y1 === undefined) {
        throw new RangeError("Point-on-line line operand is missing values.");
      }
      const wx = px.value - x1;
      const wy = py.value - y1;
      // cross = dx·wy − dy·wx (mm²); distance = cross / L (mm).
      const cross = line.dx * wy - line.dy * wx;
      const distance = cross / line.length;
      const dCross = new Map<number, number>();
      addInto(dCross, line.ddx, wy);
      addInto(dCross, line.ddy, -wx);
      addInto(dCross, px.grad, -line.dy);
      addInto(dCross, py.grad, line.dx);
      // w = P − p1: the line's own start slots flow through w as well —
      // ∂wx/∂x1 = −1 and ∂wy/∂y1 = −1 through cross (the §1.3 convention
      // note: these two columns were missing from the original construction,
      // a latent gradient gap verified against finite differences; the row
      // converged anyway whenever a correct column elsewhere spanned the
      // step, which is why it went unnoticed).
      dCross.set(x1Slot, (dCross.get(x1Slot) ?? 0) + line.dy);
      dCross.set(y1Slot, (dCross.get(y1Slot) ?? 0) - line.dx);
      const grad = chain(
        1 / line.length,
        dCross,
        -cross / (line.length * line.length),
        line.dLength,
      );
      return { value: distance, grad };
    },
  };
}

/** Point-on-circle/arc: radial distance to the (full) circle (mm). */
function pointOnCircularRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  circularId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const slots = circularSlotsOf(circularId, context);
      const [cxSlot, cySlot, rSlot] = slots.offsets;
      if (cxSlot === undefined || cySlot === undefined || rSlot === undefined) {
        throw new RangeError("Point-on-circle operand is missing slots.");
      }
      const cx = parameters[cxSlot];
      const cy = parameters[cySlot];
      const radius = parameters[rSlot];
      if (cx === undefined || cy === undefined || radius === undefined) {
        throw new RangeError("Point-on-circle operand is missing values.");
      }
      const px = pointExpr(target, context, parameters, "x");
      const py = pointExpr(target, context, parameters, "y");
      const wx = px.value - cx;
      const wy = py.value - cy;
      const distance = Math.hypot(wx, wy);
      // At the center the direction is undefined; the zero subgradient
      // delegates to the other constraints of the system.
      if (distance === 0) {
        return { value: -radius, grad: new Map() };
      }
      const ux = wx / distance;
      const uy = wy / distance;
      const grad = new Map<number, number>();
      addInto(grad, px.grad, ux);
      addInto(grad, py.grad, uy);
      grad.set(cxSlot, (grad.get(cxSlot) ?? 0) - ux);
      grad.set(cySlot, (grad.get(cySlot) ?? 0) - uy);
      grad.set(rSlot, -1);
      return { value: distance - radius, grad };
    },
  };
}

/**
 * Point-on-ellipse (arcs as their full ellipse): the EXACT implicit
 * residual `(ex/a)² + (ey/b)² − 1` over the point's ellipse-local frame
 * offset — dimensionless, smooth, and its zero set is exactly the ellipse.
 */
function pointOnEllipseRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  ellipseId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const entity = context.entitiesById.get(ellipseId);
      const slots = context.layout.slotsOf(ellipseId);
      if (
        entity === undefined ||
        (entity.kind !== "ellipse" && entity.kind !== "ellipticalArc") ||
        slots === undefined
      ) {
        throw new RangeError(
          `Constraint references unknown ellipse ${ellipseId}.`,
        );
      }
      const [cxSlot, cySlot, aSlot, bSlot, rhoSlot] = slots.offsets;
      if (
        cxSlot === undefined ||
        cySlot === undefined ||
        aSlot === undefined ||
        bSlot === undefined ||
        rhoSlot === undefined
      ) {
        throw new RangeError("Point-on-ellipse operand is missing slots.");
      }
      const cx = parameters[cxSlot];
      const cy = parameters[cySlot];
      const a = parameters[aSlot];
      const b = parameters[bSlot];
      const rho = parameters[rhoSlot];
      if (
        cx === undefined ||
        cy === undefined ||
        a === undefined ||
        b === undefined ||
        rho === undefined
      ) {
        throw new RangeError("Point-on-ellipse operand is missing values.");
      }
      const px = pointExpr(target, context, parameters, "x");
      const py = pointExpr(target, context, parameters, "y");
      const wx = px.value - cx;
      const wy = py.value - cy;
      const cosRho = Math.cos(rho);
      const sinRho = Math.sin(rho);
      // Local-frame offset: rotate the world offset by −ρ.
      const ex = cosRho * wx + sinRho * wy;
      const ey = -sinRho * wx + cosRho * wy;
      const value = (ex * ex) / (a * a) + (ey * ey) / (b * b) - 1;
      // ∂r/∂ex = 2ex/a², ∂r/∂ey = 2ey/b²; then the frame chain:
      // (∂ex, ∂ey) = R(−ρ)·(∂wx, ∂wy) + (∂R)·(wx, wy) with
      // ∂(R(−ρ))/∂ρ·(wx, wy) = (ey, −ex).
      const drdx = (2 * ex) / (a * a);
      const drdy = (2 * ey) / (b * b);
      const grad = new Map<number, number>();
      const into = (map: ReadonlyMap<number, number>, dx: number, dy: number) =>
        addInto(
          grad,
          map,
          drdx * (cosRho * dx + sinRho * dy) +
            drdy * (-sinRho * dx + cosRho * dy),
        );
      into(px.grad, 1, 0);
      into(py.grad, 0, 1);
      grad.set(
        cxSlot,
        (grad.get(cxSlot) ?? 0) - (drdx * cosRho - drdy * sinRho),
      );
      grad.set(
        cySlot,
        (grad.get(cySlot) ?? 0) - (drdx * sinRho + drdy * cosRho),
      );
      grad.set(aSlot, (grad.get(aSlot) ?? 0) - (2 * ex * ex) / (a * a * a));
      grad.set(bSlot, (grad.get(bSlot) ?? 0) - (2 * ey * ey) / (b * b * b));
      grad.set(rhoSlot, (grad.get(rhoSlot) ?? 0) + drdx * ey - drdy * ex);
      return { value, grad };
    },
  };
}

/**
 * Point-on-spline: the distance from the point target to the curve's
 * tessellated chord form, with the gradient FROZEN at the projection's
 * curve parameter — the pinned honesty (see `spline-math.ts`): the
 * projection parameter's own derivative is dropped, so each Gauss-Newton
 * step is exact for the current parameter and converges linearly in it;
 * the chord form keeps every evaluated point within the documented
 * deflection of the true curve.
 */
function pointOnSplineRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  splineId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const entity = context.entitiesById.get(splineId);
      const slots = context.layout.slotsOf(splineId);
      if (
        entity === undefined ||
        entity.kind !== "spline" ||
        slots === undefined
      ) {
        throw new RangeError(
          `Constraint references unknown spline ${splineId}.`,
        );
      }
      const points = slots.offsets
        .filter((_, index) => index % 2 === 0)
        .map((xSlot) => {
          const x = parameters[xSlot];
          const y = parameters[xSlot + 1];
          if (x === undefined || y === undefined) {
            throw new RangeError("Point-on-spline spline is missing values.");
          }
          return { x, y };
        });
      const px = pointExpr(target, context, parameters, "x");
      const py = pointExpr(target, context, parameters, "y");
      const projection = projectOntoSpline(
        { flavor: entity.flavor, points },
        { x: px.value, y: py.value },
      );
      if (projection === null || projection.distance === 0) {
        return { value: 0, grad: new Map() };
      }
      const ux = (projection.point.x - px.value) / projection.distance;
      const uy = (projection.point.y - py.value) / projection.distance;
      const grad = new Map<number, number>();
      addInto(grad, px.grad, -ux);
      addInto(grad, py.grad, -uy);
      const chain = bezierChainOfSpline({ flavor: entity.flavor, points });
      const pointGrad = splinePointGradient(
        chain,
        projection.segment,
        projection.t,
      );
      for (const [pointIndex, weight] of pointGrad) {
        const xSlot = slots.offsets[2 * pointIndex];
        const ySlot = slots.offsets[2 * pointIndex + 1];
        if (xSlot === undefined || ySlot === undefined) {
          // In-range by construction (the gradient's point indices are the
          // chain's stored points); out-of-range is a gradient-mapping bug.
          throw new RangeError(
            `Point-on-spline gradient touches point ${String(pointIndex)}, which has no parameter slots.`,
          );
        }
        grad.set(xSlot, (grad.get(xSlot) ?? 0) + ux * weight);
        grad.set(ySlot, (grad.get(ySlot) ?? 0) + uy * weight);
      }
      return { value: projection.distance, grad };
    },
  };
}

// ---------------------------------------------------------------------------
// Spline residual machinery (the Phase 37 constraint-math closure): curve
// point/tangent expressions, the anywhere line↔spline tangency anchor, the
// end-tangent direction rows, the G1 joint, endpoint chords, and the
// end-tangent-line row. Derivations: docs/design/spline-constraint-math.md.
// ---------------------------------------------------------------------------

/** The spline entity and slots of a spline operand (fails loudly if absent). */
function splineOperandOf(
  splineId: SketchEntityId,
  context: CompiledContext,
): {
  readonly entity: Extract<SketchEntity, { kind: "spline" }>;
  readonly slots: EntitySlots;
} {
  const entity = context.entitiesById.get(splineId);
  const slots = context.layout.slotsOf(splineId);
  if (entity === undefined || entity.kind !== "spline" || slots === undefined) {
    throw new RangeError(`Constraint references unknown spline ${splineId}.`);
  }
  return { entity, slots };
}

/** Reads a spline's stored points out of the parameter vector. */
function splinePointsFrom(
  parameters: readonly number[],
  slots: EntitySlots,
): { x: number; y: number }[] {
  return slots.offsets
    .filter((_, index) => index % 2 === 0)
    .map((xSlot) => {
      const x = parameters[xSlot];
      const y = parameters[xSlot + 1];
      if (x === undefined || y === undefined) {
        throw new RangeError("Spline operand is missing parameter values.");
      }
      return { x, y };
    });
}

/** The spline's Bézier chain as a pure function of the current parameters. */
function splineChainFrom(
  parameters: readonly number[],
  splineId: SketchEntityId,
  context: CompiledContext,
): SplineChain {
  const { entity, slots } = splineOperandOf(splineId, context);
  return bezierChainOfSpline({
    flavor: entity.flavor,
    points: splinePointsFrom(parameters, slots),
  });
}

/**
 * The curve point at (segment, t) as a first-order expression over the
 * spline's slots — the value evaluated on the TRUE curve, the gradient the
 * exact `splinePointGradient` weights distributed onto each point's x/y
 * slots (stage 2 of the design doc; the same scalar weight applies to both
 * axes because the flavor conversion maps x and y identically).
 */
function curvePointExpr(
  chain: SplineChain,
  slots: EntitySlots,
  segment: number,
  t: number,
  axis: "x" | "y",
): LinExpr {
  const point = evaluateSplinePoint(chain, segment, t);
  const weights = splinePointGradient(chain, segment, t);
  const grad = new Map<number, number>();
  for (const [pointIndex, weight] of weights) {
    const slot = slots.offsets[2 * pointIndex + (axis === "x" ? 0 : 1)];
    // Every gradient point index is a stored point of the chain by
    // construction; an out-of-range index is a gradient-mapping bug (the
    // §37 control-flavor mis-indexing hid here silently) — fail loudly.
    if (slot === undefined) {
      throw new RangeError(
        `Spline gradient touches point ${String(pointIndex)}, which has no parameter slot.`,
      );
    }
    grad.set(slot, weight);
  }
  return {
    value: axis === "x" ? point.x : point.y,
    grad,
  };
}

/**
 * The curve tangent component at (segment, t) as a first-order expression —
 * the mirror of {@link curvePointExpr} over `splineTangentGradient`.
 */
function curveTangentExpr(
  chain: SplineChain,
  slots: EntitySlots,
  segment: number,
  t: number,
  axis: "x" | "y",
): LinExpr {
  const tangent = splineTangent(chain, segment, t);
  const weights = splineTangentGradient(chain, segment, t);
  const grad = new Map<number, number>();
  for (const [pointIndex, weight] of weights) {
    const slot = slots.offsets[2 * pointIndex + (axis === "x" ? 0 : 1)];
    if (slot === undefined) {
      throw new RangeError(
        `Spline tangent gradient touches point ${String(pointIndex)}, which has no parameter slot.`,
      );
    }
    grad.set(slot, weight);
  }
  return {
    value: axis === "x" ? tangent.vx : tangent.vy,
    grad,
  };
}

/** The (segment, t) anchor of a spline end. */
function splineEndAnchor(
  chain: SplineChain,
  at: SplineEndSelection,
): { readonly segment: number; readonly t: number } {
  if (chain.segments.length === 0) {
    throw new RangeError("Spline operand has no Bézier segments.");
  }
  return at === "start"
    ? { segment: 0, t: 0 }
    : { segment: chain.segments.length - 1, t: 1 };
}

/** Below this tangent magnitude a curve point has no defined tangency. */
const SPLINE_CUSP_TANGENT_EPSILON = 1e-9;

/** One candidate tangency contact: a curve anchor. */
interface TangencyCandidate {
  readonly segment: number;
  readonly t: number;
}

/**
 * The per-segment stationary candidates of the signed line distance —
 * `s` restricted to one Bézier segment is a scalar cubic with control
 * values `g_j = s(b_j)` (affine composition preserves Bézier form exactly),
 * so its stationary parameters are the derivative-quadratic roots.
 */
function stationaryCandidates(
  chain: SplineChain,
  signedDistanceOfControl: (index: number) => number,
): TangencyCandidate[] {
  const candidates: TangencyCandidate[] = [];
  for (let segment = 0; segment < chain.segments.length; segment += 1) {
    const base = 4 * segment;
    const roots = cubicStationaryParameters(
      signedDistanceOfControl(base),
      signedDistanceOfControl(base + 1),
      signedDistanceOfControl(base + 2),
      signedDistanceOfControl(base + 3),
    );
    for (const t of roots) candidates.push({ segment, t });
  }
  return candidates;
}

/**
 * The anywhere-tangency anchor (§1.3 Option C): candidates are the
 * per-segment stationary parameters of the signed distance plus the two
 * chain ends; the anchor is the |s|-minimizer, evaluated EXACTLY on the true
 * curve, ties to the earlier candidate (the `projectOntoSpline` strict-`<`
 * convention). Stationary candidates at a cusp (`‖C'‖ < ε`) are skipped —
 * the tangent is undefined there, so they are not tangency contacts.
 */
function tangencyAnchor(
  chain: SplineChain,
  line: LineGeom,
  x1: number,
  y1: number,
): TangencyCandidate {
  const signedDistanceAt = (point: { x: number; y: number }): number =>
    (line.dx * (point.y - y1) - line.dy * (point.x - x1)) / line.length;
  const signedDistanceOfControl = (index: number): number => {
    const segment = Math.floor(index / 4);
    const which = index % 4;
    const seg = chain.segments[segment];
    if (seg === undefined) return 0;
    const control = [seg.b0, seg.b1, seg.b2, seg.b3][which];
    return control === undefined
      ? 0
      : line.dx * (control.y - y1) - line.dy * (control.x - x1);
  };
  const candidates: TangencyCandidate[] = stationaryCandidates(
    chain,
    signedDistanceOfControl,
  );
  candidates.push({ segment: 0, t: 0 });
  candidates.push({ segment: chain.segments.length - 1, t: 1 });
  let best: TangencyCandidate | null = null;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const tangent = splineTangent(chain, candidate.segment, candidate.t);
    const magnitude = Math.hypot(tangent.vx, tangent.vy);
    if (magnitude < SPLINE_CUSP_TANGENT_EPSILON) continue;
    const value = Math.abs(
      signedDistanceAt(
        evaluateSplinePoint(chain, candidate.segment, candidate.t),
      ),
    );
    if (value < bestValue) {
      best = candidate;
      bestValue = value;
    }
  }
  // The candidate set always contains the two chain ends, and the cusp guard
  // can only exclude interior stationary points — an anchor exists whenever
  // the chain does.
  if (best === null) {
    throw new RangeError("Tangency anchor search found no candidates.");
  }
  return best;
}

/**
 * Tangency(line, spline), ANYWHERE on the curve: the eliminated
 * stationary-anchor row (§1.3) — one row, codimension 1, matching the
 * line↔circle precedent. The zero set is exactly tangency: an interior
 * stationary anchor carries `s' = 0` built in, the chain ends are the
 * legitimate endpoint contacts, and the frozen gradient is Danskin-exact in
 * both anchor classes (§0.4). Scale: mm, `pointOnLineRow`'s convention.
 */
function tangentLineSplineRow(
  label: string,
  origin: ResidualOrigin,
  lineId: SketchEntityId,
  splineId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const lineSlots = lineSlotsOf(lineId, context);
      const line = lineGeom(parameters, lineSlots);
      const [x1Slot, y1Slot] = lineSlots.offsets;
      if (x1Slot === undefined || y1Slot === undefined) {
        throw new RangeError("Tangent line operand is missing slots.");
      }
      const x1 = parameters[x1Slot];
      const y1 = parameters[y1Slot];
      if (x1 === undefined || y1 === undefined) {
        throw new RangeError("Tangent line operand is missing values.");
      }
      const { slots: splineSlots } = splineOperandOf(splineId, context);
      const curve = splineChainFrom(parameters, splineId, context);
      const anchor = tangencyAnchor(curve, line, x1, y1);
      const px = curvePointExpr(
        curve,
        splineSlots,
        anchor.segment,
        anchor.t,
        "x",
      );
      const py = curvePointExpr(
        curve,
        splineSlots,
        anchor.segment,
        anchor.t,
        "y",
      );
      const wx = px.value - x1;
      const wy = py.value - y1;
      const cross = line.dx * wy - line.dy * wx;
      const distance = cross / line.length;
      const dCross = new Map<number, number>();
      addInto(dCross, line.ddx, wy);
      addInto(dCross, line.ddy, -wx);
      addInto(dCross, px.grad, -line.dy);
      addInto(dCross, py.grad, line.dx);
      // w = C(t) − p1: the line's own start slots flow through w as well
      // (the §1.3 convention-note columns — REQUIRED for a correct
      // gradient, and the same fix pointOnLineRow now carries).
      dCross.set(x1Slot, (dCross.get(x1Slot) ?? 0) + line.dy);
      dCross.set(y1Slot, (dCross.get(y1Slot) ?? 0) - line.dx);
      const grad = chain(
        1 / line.length,
        dCross,
        -cross / (line.length * line.length),
        line.dLength,
      );
      return { value: distance, grad };
    },
  };
}

/** Parallel(line, spline end tangent): `cross(d, T) = 0` (mm², §3). */
function parallelLineSplineRow(
  label: string,
  origin: ResidualOrigin,
  lineId: SketchEntityId,
  splineId: SketchEntityId,
  at: SplineEndSelection,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const line = lineGeom(parameters, lineSlotsOf(lineId, context));
      const { slots } = splineOperandOf(splineId, context);
      const spline = splineChainFrom(parameters, splineId, context);
      const anchor = splineEndAnchor(spline, at);
      const tx = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "x");
      const ty = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "y");
      const cross = line.dx * ty.value - line.dy * tx.value;
      const grad = new Map<number, number>();
      addInto(grad, line.ddx, ty.value);
      addInto(grad, line.ddy, -tx.value);
      addInto(grad, tx.grad, -line.dy);
      addInto(grad, ty.grad, line.dx);
      return { value: cross, grad };
    },
  };
}

/** Perpendicular(line, spline end tangent): `dot(d, T) = 0` (mm², §2). */
function perpendicularLineSplineRow(
  label: string,
  origin: ResidualOrigin,
  lineId: SketchEntityId,
  splineId: SketchEntityId,
  at: SplineEndSelection,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const line = lineGeom(parameters, lineSlotsOf(lineId, context));
      const { slots } = splineOperandOf(splineId, context);
      const spline = splineChainFrom(parameters, splineId, context);
      const anchor = splineEndAnchor(spline, at);
      const tx = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "x");
      const ty = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "y");
      const dot = line.dx * tx.value + line.dy * ty.value;
      const grad = new Map<number, number>();
      addInto(grad, line.ddx, tx.value);
      addInto(grad, line.ddy, ty.value);
      addInto(grad, tx.grad, line.dx);
      addInto(grad, ty.grad, line.dy);
      return { value: dot, grad };
    },
  };
}

/**
 * Angle(line, spline end tangent): `dot(d,T)/(L·‖T‖) − cosθ` — dimensionless,
 * the unsigned `[0, π]` convention `angleRow` pins (the supplementary angle
 * is never a false zero). Guard `‖T‖ = 0` delegates with a zero subgradient.
 */
function angleLineSplineRow(
  label: string,
  origin: ResidualOrigin,
  lineId: SketchEntityId,
  splineId: SketchEntityId,
  at: SplineEndSelection,
  context: CompiledContext,
  target: number,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const line = lineGeom(parameters, lineSlotsOf(lineId, context));
      const { slots } = splineOperandOf(splineId, context);
      const spline = splineChainFrom(parameters, splineId, context);
      const anchor = splineEndAnchor(spline, at);
      const tx = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "x");
      const ty = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "y");
      const tangentNorm = Math.hypot(tx.value, ty.value);
      const cos = Math.cos(target);
      if (tangentNorm === 0) {
        return { value: -cos, grad: new Map() };
      }
      const dot = line.dx * tx.value + line.dy * ty.value;
      const denom = line.length * tangentNorm;
      const value = dot / denom - cos;
      const dDot = new Map<number, number>();
      addInto(dDot, line.ddx, tx.value);
      addInto(dDot, line.ddy, ty.value);
      addInto(dDot, tx.grad, line.dx);
      addInto(dDot, ty.grad, line.dy);
      const dDenom = new Map<number, number>();
      addInto(dDenom, line.dLength, tangentNorm);
      addInto(dDenom, tx.grad, (line.length * tx.value) / tangentNorm);
      addInto(dDenom, ty.grad, (line.length * ty.value) / tangentNorm);
      const grad = new Map<number, number>();
      for (const slot of new Set([...dDot.keys(), ...dDenom.keys()])) {
        const dd = dDot.get(slot) ?? 0;
        const dn = dDenom.get(slot) ?? 0;
        grad.set(slot, (dd * denom - dot * dn) / (denom * denom));
      }
      return { value, grad };
    },
  };
}

/**
 * The G1 tangent-direction row of a spline↔spline joint (§1.5):
 * `cross(T_A_end, T_B_start) = 0` (mm²). Named ends — no anchors, exact
 * gradients. Pairs with the two coincident rows on the same ends.
 */
function splineJointTangentRow(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const a = splineOperandOf(first, context);
      const b = splineOperandOf(second, context);
      const chainA = splineChainFrom(parameters, first, context);
      const chainB = splineChainFrom(parameters, second, context);
      const endA = splineEndAnchor(chainA, "end");
      const startB = splineEndAnchor(chainB, "start");
      const tax = curveTangentExpr(chainA, a.slots, endA.segment, endA.t, "x");
      const tay = curveTangentExpr(chainA, a.slots, endA.segment, endA.t, "y");
      const tbx = curveTangentExpr(
        chainB,
        b.slots,
        startB.segment,
        startB.t,
        "x",
      );
      const tby = curveTangentExpr(
        chainB,
        b.slots,
        startB.segment,
        startB.t,
        "y",
      );
      const cross = tax.value * tby.value - tay.value * tbx.value;
      const grad = new Map<number, number>();
      addInto(grad, tax.grad, tby.value);
      addInto(grad, tay.grad, -tbx.value);
      addInto(grad, tbx.grad, -tay.value);
      addInto(grad, tby.grad, tax.value);
      return { value: cross, grad };
    },
  };
}

/**
 * The endpoint-chord expression of a spline: `‖P_end − P_start‖` with the
 * `distanceRow` gradient chain over the four end slots. Zero chord (P_0 =
 * P_{N−1}) is constructible on control splines; the caller delegates.
 */
function splineChordExpr(
  parameters: readonly number[],
  slots: EntitySlots,
): LinExpr {
  const firstX = slots.offsets[0];
  const firstY = slots.offsets[1];
  const lastX = slots.offsets[slots.offsets.length - 2];
  const lastY = slots.offsets[slots.offsets.length - 1];
  if (
    firstX === undefined ||
    firstY === undefined ||
    lastX === undefined ||
    lastY === undefined
  ) {
    throw new RangeError("Equal spline operand is missing end slots.");
  }
  const dxExpr = subtractExpr(
    { value: parameters[lastX] ?? 0, grad: new Map([[lastX, 1]]) },
    { value: parameters[firstX] ?? 0, grad: new Map([[firstX, 1]]) },
  );
  const dyExpr = subtractExpr(
    { value: parameters[lastY] ?? 0, grad: new Map([[lastY, 1]]) },
    { value: parameters[firstY] ?? 0, grad: new Map([[firstY, 1]]) },
  );
  const distance = Math.hypot(dxExpr.value, dyExpr.value);
  const grad =
    distance === 0
      ? new Map<number, number>()
      : chain(
          dxExpr.value / distance,
          dxExpr.grad,
          dyExpr.value / distance,
          dyExpr.grad,
        );
  return { value: distance, grad };
}

/**
 * Point-on-end-tangent-line (§6(b)): the signed distance from the point
 * target to the line through the spline's end along its end tangent — mm,
 * the `pointOnLineRow` scale, with every channel explicit (the end point's
 * two slots and the tangent's stored-point weights), so the §1.3 omission
 * class cannot recur. Guard `‖T‖ = 0`: the "line" degenerates to its end
 * point; return the distance to it with a zero subgradient (delegation).
 */
function pointOnTangentRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  splineId: SketchEntityId,
  at: SplineEndSelection,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const { slots } = splineOperandOf(splineId, context);
      const spline = splineChainFrom(parameters, splineId, context);
      const anchor = splineEndAnchor(spline, at);
      const ex = curvePointExpr(spline, slots, anchor.segment, anchor.t, "x");
      const ey = curvePointExpr(spline, slots, anchor.segment, anchor.t, "y");
      const tx = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "x");
      const ty = curveTangentExpr(spline, slots, anchor.segment, anchor.t, "y");
      const px = pointExpr(target, context, parameters, "x");
      const py = pointExpr(target, context, parameters, "y");
      const wx = px.value - ex.value;
      const wy = py.value - ey.value;
      const tangentNorm = Math.hypot(tx.value, ty.value);
      if (tangentNorm === 0) {
        return {
          value: Math.hypot(wx, wy),
          grad: new Map(),
        };
      }
      const cross = tx.value * wy - ty.value * wx;
      const dCross = new Map<number, number>();
      addInto(dCross, px.grad, -ty.value);
      addInto(dCross, py.grad, tx.value);
      addInto(dCross, ex.grad, ty.value);
      addInto(dCross, ey.grad, -tx.value);
      addInto(dCross, tx.grad, wy);
      addInto(dCross, ty.grad, -wx);
      const dNorm = new Map<number, number>();
      addInto(dNorm, tx.grad, tx.value / tangentNorm);
      addInto(dNorm, ty.grad, ty.value / tangentNorm);
      // Quotient rule (the pointOnLineRow shape): ∂(cross/n) =
      // ∂cross/n − cross·∂n/n², with ∂n = (T_x·∂T_x + T_y·∂T_y)/n.
      const grad = chain(
        1 / tangentNorm,
        dCross,
        -cross / (tangentNorm * tangentNorm),
        dNorm,
      );
      return { value: cross / tangentNorm, grad };
    },
  };
}

// ---------------------------------------------------------------------------
// Composite-entity pointOnEntity (§7): the stateless per-evaluation Danskin
// argmin — r(x) = min over constituents of the exact constituent distance,
// gradient = the active constituent's. NOT N simultaneous rows (that
// intersects the constituents) and NOT stateful hysteresis (rows must stay
// pure functions of the parameters; the backtracking line search is the
// switch-hysteresis this architecture can honestly offer). Tie-break:
// strict `<`, lowest constituent index wins (the `projectOntoSpline`
// convention). One row of rank 1 — 1 degree of freedom removed, matching
// pointOnEntity on every other kind.
// ---------------------------------------------------------------------------

/** A 2D first-order expression (the point/tangent rows' shared pair). */
interface PointExpr2 {
  readonly x: LinExpr;
  readonly y: LinExpr;
}

/**
 * The distance from point `p` to the SEGMENT a→b with the projection foot
 * FROZEN at its current parameter: envelope-exact for interior feet
 * (`∂/∂u = 0` at the projection), a valid subgradient at clamped feet
 * (endpoint contact). `d = 0` delegates to the containing segment's
 * infinite-line distance gradient (the `pointOnLineRow` construction over
 * the same expressions).
 */
function segmentDistanceWithFrozenFoot(
  p: PointExpr2,
  a: PointExpr2,
  b: PointExpr2,
): ResidualEvaluation {
  const dxExpr = subtractExpr(b.x, a.x);
  const dyExpr = subtractExpr(b.y, a.y);
  const wxExpr = subtractExpr(p.x, a.x);
  const wyExpr = subtractExpr(p.y, a.y);
  const lengthSquared =
    dxExpr.value * dxExpr.value + dyExpr.value * dyExpr.value;
  const u =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            (wxExpr.value * dxExpr.value + wyExpr.value * dyExpr.value) /
              lengthSquared,
          ),
        );
  const qxExpr = combineExpr(wxExpr, dxExpr, 1, -u);
  const qyExpr = combineExpr(wyExpr, dyExpr, 1, -u);
  const distance = Math.hypot(qxExpr.value, qyExpr.value);
  if (distance === 0) {
    // The point sits ON the segment: zero residual with the containing
    // segment's infinite-line gradient (signed distance cross/L and its
    // exact chain — the same channels pointOnLineRow accumulates).
    const cross = dxExpr.value * wyExpr.value - dyExpr.value * wxExpr.value;
    const length = Math.sqrt(lengthSquared);
    if (length === 0) return { value: 0, grad: new Map() };
    const dCross = new Map<number, number>();
    addInto(dCross, dxExpr.grad, wyExpr.value);
    addInto(dCross, dyExpr.grad, -wxExpr.value);
    addInto(dCross, wxExpr.grad, -dyExpr.value);
    addInto(dCross, wyExpr.grad, dxExpr.value);
    const dLength = new Map<number, number>();
    addInto(dLength, dxExpr.grad, dxExpr.value / length);
    addInto(dLength, dyExpr.grad, dyExpr.value / length);
    return {
      value: 0,
      grad: chain(1 / length, dCross, -cross / (length * length), dLength),
    };
  }
  const ux = qxExpr.value / distance;
  const uy = qyExpr.value / distance;
  // d = ‖q‖ with q = P − foot: ∂d = ûᵀ·∂q (û from foot to P — moving P
  // outward along û increases the distance; moving the segment's points
  // with the foot decreases it).
  const grad = new Map<number, number>();
  addInto(grad, qxExpr.grad, ux);
  addInto(grad, qyExpr.grad, uy);
  return { value: distance, grad };
}

/** The polygon entity and slots of a polygon operand. */
function polygonOperandOf(
  polygonId: SketchEntityId,
  context: CompiledContext,
): {
  readonly entity: Extract<SketchEntity, { kind: "polygon" }>;
  readonly slots: EntitySlots;
} {
  const entity = context.entitiesById.get(polygonId);
  const slots = context.layout.slotsOf(polygonId);
  if (
    entity === undefined ||
    entity.kind !== "polygon" ||
    slots === undefined
  ) {
    throw new RangeError(
      `pointOnEntity references unknown polygon ${polygonId}.`,
    );
  }
  return { entity, slots };
}

/**
 * The polygon's vertex expressions (§7.2): `θ_k = ρ + 2πk/n`,
 * `R_eff = r·σ` (σ = 1 inscribed, 1/cos(π/n) circumscribed), with the exact
 * per-slot gradients. `sides` and `fit` are discrete parameters, not
 * unknowns — the layout rule.
 */
function polygonVertexExprs(
  entity: Extract<SketchEntity, { kind: "polygon" }>,
  slots: EntitySlots,
  parameters: readonly number[],
): readonly PointExpr2[] {
  const [cxSlot, cySlot, rSlot, rhoSlot] = slots.offsets;
  if (
    cxSlot === undefined ||
    cySlot === undefined ||
    rSlot === undefined ||
    rhoSlot === undefined
  ) {
    throw new RangeError("Polygon operand is missing slots.");
  }
  const cx = parameters[cxSlot];
  const cy = parameters[cySlot];
  const radius = parameters[rSlot];
  const rho = parameters[rhoSlot];
  if (
    cx === undefined ||
    cy === undefined ||
    radius === undefined ||
    rho === undefined
  ) {
    throw new RangeError("Polygon operand is missing values.");
  }
  const sigma =
    entity.fit === "inscribed" ? 1 : 1 / Math.cos(Math.PI / entity.sides);
  const effective = sigma * radius;
  return Array.from({ length: entity.sides }, (_, k) => {
    const theta = rho + (Math.PI * 2 * k) / entity.sides;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    return {
      x: {
        value: cx + effective * cosT,
        grad: new Map<number, number>([
          [cxSlot, 1],
          [rSlot, sigma * cosT],
          [rhoSlot, -effective * sinT],
        ]),
      },
      y: {
        value: cy + effective * sinT,
        grad: new Map<number, number>([
          [cySlot, 1],
          [rSlot, sigma * sinT],
          [rhoSlot, effective * cosT],
        ]),
      },
    };
  });
}

/**
 * pointOnEntity on a polygon (§7.2): the min over the n BOUNDARY segments
 * `V_k → V_{k+1 mod n}` (the perimeter, not the infinite lines — a closed
 * boundary's "on the entity" means on the perimeter). A regular polygon's
 * edges have equal positive length (the entity invariants), so the segment
 * distance never divides by zero.
 */
function pointOnPolygonRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  polygonId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const { entity, slots } = polygonOperandOf(polygonId, context);
      const p = {
        x: pointExpr(target, context, parameters, "x"),
        y: pointExpr(target, context, parameters, "y"),
      };
      const vertices = polygonVertexExprs(entity, slots, parameters);
      let best: ResidualEvaluation | null = null;
      for (let k = 0; k < vertices.length; k += 1) {
        const a = vertices[k];
        const b = vertices[(k + 1) % vertices.length];
        if (a === undefined || b === undefined) continue;
        const evaluation = segmentDistanceWithFrozenFoot(p, a, b);
        if (best === null || evaluation.value < best.value) best = evaluation;
      }
      if (best === null) {
        throw new RangeError("Polygon operand has no boundary constituents.");
      }
      return best;
    },
  };
}

/**
 * pointOnEntity on a STRAIGHT slot (§7.3): the min over the four gated
 * boundary constituents — two edge segments (offset endpoints with the
 * exact `∂n̂/∂` chain) and two semicircular caps (the `pointOnCircularRow`
 * body gated by the half-plane the cap's nearest circle point needs). The
 * min over the gated constituents is the true distance to the slot boundary
 * (each constituent exact on its active domain). The arc3 variant stays
 * declined at validation — its boundary arcs are offsets of the centerline
 * circumcircle and ship after the straight-slot row has fixture coverage.
 */
function pointOnStraightSlotRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  slotId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const slots = context.layout.slotsOf(slotId);
      if (slots === undefined || slots.offsets.length !== 5) {
        throw new RangeError(
          `pointOnEntity references unknown straight slot ${slotId}.`,
        );
      }
      const [x1Slot, y1Slot, x2Slot, y2Slot, rSlot] = slots.offsets;
      if (
        x1Slot === undefined ||
        y1Slot === undefined ||
        x2Slot === undefined ||
        y2Slot === undefined ||
        rSlot === undefined
      ) {
        throw new RangeError("Slot operand is missing slots.");
      }
      const x1 = parameters[x1Slot];
      const y1 = parameters[y1Slot];
      const x2 = parameters[x2Slot];
      const y2 = parameters[y2Slot];
      const radius = parameters[rSlot];
      if (
        x1 === undefined ||
        y1 === undefined ||
        x2 === undefined ||
        y2 === undefined ||
        radius === undefined
      ) {
        throw new RangeError("Slot operand is missing values.");
      }
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (length === 0) {
        throw new RangeError("Slot operand has a degenerate centerline.");
      }
      const ax = dx / length;
      const ay = dy / length;
      const nx = -dy / length;
      const ny = dx / length;
      // ∂n̂/∂ over the four centerline slots (n̂ = (−dy, dx)/L).
      const dnxDx1 = (-dx * dy) / (length * length * length);
      const dnxDx2 = (dx * dy) / (length * length * length);
      const dnxDy1 = (dx * dx) / (length * length * length);
      const dnxDy2 = -(dx * dx) / (length * length * length);
      const dnyDx1 = (-dy * dy) / (length * length * length);
      const dnyDx2 = (dy * dy) / (length * length * length);
      const dnyDy1 = (dx * dy) / (length * length * length);
      const dnyDy2 = (-dx * dy) / (length * length * length);
      // Edge endpoint expressions E = c_i ± r·n̂ over the slot's slots.
      const edgeEndpoint = (
        which: 1 | 2,
        sign: number,
        axis: "x" | "y",
      ): LinExpr => {
        const centerSlot =
          which === 1
            ? axis === "x"
              ? x1Slot
              : y1Slot
            : axis === "x"
              ? x2Slot
              : y2Slot;
        const centerValue =
          which === 1 ? (axis === "x" ? x1 : y1) : axis === "x" ? x2 : y2;
        const normalComponent = axis === "x" ? nx : ny;
        const grad = new Map<number, number>();
        grad.set(centerSlot, 1);
        const scale = sign * radius;
        if (axis === "x") {
          grad.set(x1Slot, (grad.get(x1Slot) ?? 0) + scale * dnxDx1);
          grad.set(y1Slot, (grad.get(y1Slot) ?? 0) + scale * dnxDy1);
          grad.set(x2Slot, (grad.get(x2Slot) ?? 0) + scale * dnxDx2);
          grad.set(y2Slot, (grad.get(y2Slot) ?? 0) + scale * dnxDy2);
        } else {
          grad.set(x1Slot, (grad.get(x1Slot) ?? 0) + scale * dnyDx1);
          grad.set(y1Slot, (grad.get(y1Slot) ?? 0) + scale * dnyDy1);
          grad.set(x2Slot, (grad.get(x2Slot) ?? 0) + scale * dnyDx2);
          grad.set(y2Slot, (grad.get(y2Slot) ?? 0) + scale * dnyDy2);
        }
        grad.set(rSlot, sign * normalComponent);
        return {
          value: centerValue + sign * radius * normalComponent,
          grad,
        };
      };
      const edge = (sign: number): { a: PointExpr2; b: PointExpr2 } => ({
        a: {
          x: edgeEndpoint(1, sign, "x"),
          y: edgeEndpoint(1, sign, "y"),
        },
        b: {
          x: edgeEndpoint(2, sign, "x"),
          y: edgeEndpoint(2, sign, "y"),
        },
      });
      const p = {
        x: pointExpr(target, context, parameters, "x"),
        y: pointExpr(target, context, parameters, "y"),
      };
      // Cap: the pointOnCircularRow body at a cap center (|‖P − c‖ − r|,
      // unsigned so the min is the true distance to the boundary set),
      // gated by the half-plane condition that the full circle's nearest
      // point lies on the semicircle (right cap: dot(P − c_2, â) ≥ 0; left:
      // ≤ 0 at c_1). Outside the gate the cap is not a candidate (its
      // nearest points belong to the edges, which are in the min).
      const cap = (
        which: 1 | 2,
        cx: number,
        cy: number,
      ): ResidualEvaluation | null => {
        const cxSlot = which === 1 ? x1Slot : x2Slot;
        const cySlot = which === 1 ? y1Slot : y2Slot;
        const gate = (p.x.value - cx) * ax + (p.y.value - cy) * ay;
        const insideGate = which === 1 ? gate <= 0 : gate >= 0;
        if (!insideGate) return null;
        const wx = p.x.value - cx;
        const wy = p.y.value - cy;
        const distance = Math.hypot(wx, wy);
        if (distance === 0) {
          // At the cap center the direction is undefined; the unsigned
          // residual is the radius itself, gradient delegating.
          return { value: radius, grad: new Map() };
        }
        const ux = wx / distance;
        const uy = wy / distance;
        const grad = new Map<number, number>();
        // Inside the circle the unsigned value |d − r| = r − d negates the
        // signed row's gradient; exactly on it either sign is a valid
        // subgradient (the + side's is used).
        const sign = distance - radius >= 0 ? 1 : -1;
        addInto(grad, p.x.grad, sign * ux);
        addInto(grad, p.y.grad, sign * uy);
        grad.set(cxSlot, (grad.get(cxSlot) ?? 0) - sign * ux);
        grad.set(cySlot, (grad.get(cySlot) ?? 0) - sign * uy);
        grad.set(rSlot, -sign);
        return { value: Math.abs(distance - radius), grad };
      };
      const constituents: ResidualEvaluation[] = [];
      const top = edge(1);
      constituents.push(segmentDistanceWithFrozenFoot(p, top.a, top.b));
      const bottom = edge(-1);
      constituents.push(segmentDistanceWithFrozenFoot(p, bottom.a, bottom.b));
      const rightCap = cap(2, x2, y2);
      if (rightCap !== null) constituents.push(rightCap);
      const leftCap = cap(1, x1, y1);
      if (leftCap !== null) constituents.push(leftCap);
      let best: ResidualEvaluation | null = null;
      for (const constituent of constituents) {
        if (best === null || constituent.value < best.value) {
          best = constituent;
        }
      }
      if (best === null) {
        throw new RangeError("Slot operand has no boundary constituents.");
      }
      return best;
    },
  };
}

/** Point-on-entity, dispatched over the supported operand kinds. */
function pointOnEntityRow(
  label: string,
  origin: ResidualOrigin,
  target: PointTarget,
  entityId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  const entity = context.entitiesById.get(entityId);
  switch (entity?.kind) {
    case "line":
      return pointOnLineRow(label, origin, target, entityId, context);
    case "circle":
    case "arc":
      return pointOnCircularRow(label, origin, target, entityId, context);
    case "ellipse":
    case "ellipticalArc":
      return pointOnEllipseRow(label, origin, target, entityId, context);
    case "spline":
      return pointOnSplineRow(label, origin, target, entityId, context);
    case "polygon":
      return pointOnPolygonRow(label, origin, target, entityId, context);
    case "slot":
      return pointOnStraightSlotRow(label, origin, target, entityId, context);
    default:
      throw new RangeError(
        `pointOnEntity references entity ${entityId} of unsupported kind.`,
      );
  }
}

/**
 * Collinear: both endpoints of `second` sit on `first`'s infinite line —
 * two signed-distance rows, removing exactly the two degrees of freedom a
 * line-on-line coincidence has.
 */
function collinearRows(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  context: CompiledContext,
): ResidualRow[] {
  // The second line's endpoint expressions read its own slots through the
  // generic point machinery pointOnLineRow evaluates from the vector.
  return [
    pointOnLineRow(
      `${label}/start`,
      origin,
      { entity: second, point: "start" },
      first,
      context,
    ),
    pointOnLineRow(
      `${label}/end`,
      origin,
      { entity: second, point: "end" },
      first,
      context,
    ),
  ];
}

/** Point-pair axis alignment: the two point targets share one coordinate. */
function pointPairAxisRow(
  label: string,
  origin: ResidualOrigin,
  first: PointTarget,
  second: PointTarget,
  context: CompiledContext,
  axis: "x" | "y",
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const a = pointExpr(first, context, parameters, axis);
      const b = pointExpr(second, context, parameters, axis);
      return {
        value: a.value - b.value,
        grad: combineExpr(a, b, 1, -1).grad,
      };
    },
  };
}

/** Signed axis separation with a target value (`distanceX`/`distanceY`). */
function signedAxisDistanceRow(
  label: string,
  origin: ResidualOrigin,
  first: PointTarget,
  second: PointTarget,
  context: CompiledContext,
  axis: "x" | "y",
  target: number,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const a = pointExpr(first, context, parameters, axis);
      const b = pointExpr(second, context, parameters, axis);
      return {
        value: b.value - a.value - target,
        grad: combineExpr(b, a, 1, -1).grad,
      };
    },
  };
}

function distanceRow(
  label: string,
  origin: ResidualOrigin,
  first: PointTarget,
  second: PointTarget,
  context: CompiledContext,
  target: number,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const dxExpr = subtractExpr(
        pointExpr(second, context, parameters, "x"),
        pointExpr(first, context, parameters, "x"),
      );
      const dyExpr = subtractExpr(
        pointExpr(second, context, parameters, "y"),
        pointExpr(first, context, parameters, "y"),
      );
      const distance = Math.hypot(dxExpr.value, dyExpr.value);
      // At zero distance the gradient is undefined; the zero subgradient
      // delegates to the other constraints of the system.
      if (distance === 0) {
        return { value: -target, grad: new Map() };
      }
      const grad = chain(
        dxExpr.value / distance,
        dxExpr.grad,
        dyExpr.value / distance,
        dyExpr.grad,
      );
      return { value: distance - target, grad };
    },
  };
}

function coincidentRows(
  prefix: string,
  origin: ResidualOrigin,
  first: PointTarget,
  second: PointTarget,
  context: CompiledContext,
): ResidualRow[] {
  const axisRow = (axis: "x" | "y"): ResidualRow => ({
    label: `${prefix}/${axis}`,
    origin,
    evaluate: (parameters) => {
      const a = pointExpr(first, context, parameters, axis);
      const b = pointExpr(second, context, parameters, axis);
      return {
        value: a.value - b.value,
        grad: combineExpr(a, b, 1, -1).grad,
      };
    },
  });
  return [axisRow("x"), axisRow("y")];
}

function parallelRow(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const g1 = lineGeom(parameters, lineSlotsOf(first, context));
      const g2 = lineGeom(parameters, lineSlotsOf(second, context));
      // cross = dx1·dy2 − dy1·dx2 (mm²)
      const cross = g1.dx * g2.dy - g1.dy * g2.dx;
      const grad = new Map<number, number>();
      addInto(grad, g1.ddx, g2.dy);
      addInto(grad, g1.ddy, -g2.dx);
      addInto(grad, g2.ddy, g1.dx);
      addInto(grad, g2.ddx, -g1.dy);
      return { value: cross, grad };
    },
  };
}

function perpendicularRow(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const g1 = lineGeom(parameters, lineSlotsOf(first, context));
      const g2 = lineGeom(parameters, lineSlotsOf(second, context));
      // dot = dx1·dx2 + dy1·dy2 (mm²)
      const dot = g1.dx * g2.dx + g1.dy * g2.dy;
      const grad = new Map<number, number>();
      addInto(grad, g1.ddx, g2.dx);
      addInto(grad, g1.ddy, g2.dy);
      addInto(grad, g2.ddx, g1.dx);
      addInto(grad, g2.ddy, g1.dy);
      return { value: dot, grad };
    },
  };
}

function angleRow(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  context: CompiledContext,
  target: number,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const g1 = lineGeom(parameters, lineSlotsOf(first, context));
      const g2 = lineGeom(parameters, lineSlotsOf(second, context));
      const cos = Math.cos(target);
      // r = dot/(L1·L2) − cosθ = cos φ − cos θ, where φ is the unsigned
      // angle between the lines (either rotational sense) — smooth,
      // scale-free, and its zero set on the unsigned domain [0, π] is
      // exactly φ = θ: the supplementary angle (φ = π − θ) is never a
      // false zero the way sin(θ − φ)'s is.
      const dot = g1.dx * g2.dx + g1.dy * g2.dy;
      const lengthProduct = g1.length * g2.length;
      const value = dot / lengthProduct - cos;
      const grad = new Map<number, number>();
      // ∂value = (∂dot·L − dot·∂L) / L² with L = L1·L2.
      const dDot = new Map<number, number>();
      addInto(dDot, g1.ddx, g2.dx);
      addInto(dDot, g1.ddy, g2.dy);
      addInto(dDot, g2.ddx, g1.dx);
      addInto(dDot, g2.ddy, g1.dy);
      const dLengthProduct = chain(
        g2.length,
        g1.dLength,
        g1.length,
        g2.dLength,
      );
      for (const slot of new Set([...dDot.keys(), ...dLengthProduct.keys()])) {
        const dd = dDot.get(slot) ?? 0;
        const dl = dLengthProduct.get(slot) ?? 0;
        grad.set(
          slot,
          (dd * lengthProduct - dot * dl) / (lengthProduct * lengthProduct),
        );
      }
      return { value, grad };
    },
  };
}

/**
 * Resolves a (line, spline) pair from a direction constraint's operands,
 * either order; `null` when neither operand is a spline (the line↔line
 * rows apply). A spline paired with anything but a line is blocked at
 * validation.
 */
function lineSplinePairOf(
  first: SketchEntityId,
  second: SketchEntityId,
  context: CompiledContext,
): { readonly line: SketchEntityId; readonly spline: SketchEntityId } | null {
  const firstKind = context.entitiesById.get(first)?.kind;
  const secondKind = context.entitiesById.get(second)?.kind;
  if (firstKind === "spline" && secondKind === "line") {
    return { line: second, spline: first };
  }
  if (secondKind === "spline" && firstKind === "line") {
    return { line: first, spline: second };
  }
  return null;
}

/** Parallel dispatch: line↔spline end-tangent row or the line↔line row. */
function parallelRows(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  at: SplineEndSelection,
  context: CompiledContext,
): ResidualRow[] {
  const pair = lineSplinePairOf(first, second, context);
  if (pair !== null) {
    return [
      parallelLineSplineRow(label, origin, pair.line, pair.spline, at, context),
    ];
  }
  return [parallelRow(label, origin, first, second, context)];
}

/** Perpendicular dispatch: line↔spline end-tangent row or the line↔line row. */
function perpendicularRows(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  at: SplineEndSelection,
  context: CompiledContext,
): ResidualRow[] {
  const pair = lineSplinePairOf(first, second, context);
  if (pair !== null) {
    return [
      perpendicularLineSplineRow(
        label,
        origin,
        pair.line,
        pair.spline,
        at,
        context,
      ),
    ];
  }
  return [perpendicularRow(label, origin, first, second, context)];
}

/** Angle dispatch: line↔spline end-tangent row or the line↔line row. */
function angleRows(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  at: SplineEndSelection,
  context: CompiledContext,
  target: number,
): ResidualRow[] {
  const pair = lineSplinePairOf(first, second, context);
  if (pair !== null) {
    return [
      angleLineSplineRow(
        label,
        origin,
        pair.line,
        pair.spline,
        at,
        context,
        target,
      ),
    ];
  }
  return [angleRow(label, origin, first, second, context, target)];
}

/** The parameter slot of an entity's radial dimension, by kind. */
function radialRadiusSlotOf(
  id: SketchEntityId,
  context: CompiledContext,
): number {
  const entity = context.entitiesById.get(id);
  const slots = context.layout.slotsOf(id);
  if (slots === undefined || entity === undefined) {
    throw new RangeError(`Constraint references unknown radial entity ${id}.`);
  }
  const local =
    entity.kind === "circle" ||
    entity.kind === "arc" ||
    entity.kind === "polygon"
      ? 2
      : entity.kind === "slot"
        ? entity.variant === "arc3"
          ? 6
          : 4
        : -1;
  const slot = slots.offsets[local];
  if (slot === undefined) {
    throw new RangeError(`Entity ${id} is missing its radius slot.`);
  }
  return slot;
}

function radiusRow(
  label: string,
  origin: ResidualOrigin,
  entity: SketchEntityId,
  context: CompiledContext,
  target: number,
  factor: number,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const radiusSlot = radialRadiusSlotOf(entity, context);
      const radius = parameters[radiusSlot];
      if (radius === undefined) {
        throw new RangeError(`Entity ${entity} is missing its radius value.`);
      }
      return {
        value: factor * radius - target,
        grad: new Map([[radiusSlot, factor]]),
      };
    },
  };
}

function equalRow(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const firstKind = context.entitiesById.get(first)?.kind;
      const secondKind = context.entitiesById.get(second)?.kind;
      if (firstKind === "line" && secondKind === "line") {
        const g1 = lineGeom(parameters, lineSlotsOf(first, context));
        const g2 = lineGeom(parameters, lineSlotsOf(second, context));
        const grad = new Map<number, number>(g1.dLength);
        addInto(grad, g2.dLength, -1);
        return { value: g1.length - g2.length, grad };
      }
      if (firstKind === "spline" || secondKind === "spline") {
        // Equal endpoint chord (§5(a)): the distance between the spline's
        // first and last stored points — the same notion `equal` uses for
        // lines — with mixed line↔spline pairs comparing a line's length to
        // a spline's chord. A zero chord (or zero-length line) delegates
        // with an empty subgradient on that side (the distanceRow pattern).
        const lengthOf = (
          id: SketchEntityId,
          kind: string | undefined,
        ): LinExpr => {
          if (kind === "line") {
            const g = lineGeom(parameters, lineSlotsOf(id, context));
            return { value: g.length, grad: g.dLength };
          }
          const slots = context.layout.slotsOf(id);
          if (slots === undefined) {
            throw new RangeError(
              `Equal operand ${id} is missing parameter slots.`,
            );
          }
          return splineChordExpr(parameters, slots);
        };
        const a = lengthOf(first, firstKind);
        const b = lengthOf(second, secondKind);
        const grad = new Map<number, number>(a.grad);
        addInto(grad, b.grad, -1);
        return { value: a.value - b.value, grad };
      }
      const a = circularSlotsOf(first, context);
      const b = circularSlotsOf(second, context);
      const raSlot = a.offsets[2];
      const rbSlot = b.offsets[2];
      if (raSlot === undefined || rbSlot === undefined) {
        throw new RangeError("Equal operands are missing radius slots.");
      }
      const ra = parameters[raSlot];
      const rb = parameters[rbSlot];
      if (ra === undefined || rb === undefined) {
        throw new RangeError("Equal operands are missing radius values.");
      }
      return {
        value: ra - rb,
        grad: new Map([
          [raSlot, 1],
          [rbSlot, -1],
        ]),
      };
    },
  };
}

function tangentRows(
  label: string,
  origin: ResidualOrigin,
  first: SketchEntityId,
  second: SketchEntityId,
  variant: "external" | "internal",
  context: CompiledContext,
): ResidualRow[] {
  const firstKind = context.entitiesById.get(first)?.kind;
  const secondKind = context.entitiesById.get(second)?.kind;
  // Spline operands: line↔spline is the anywhere row (§1.3); spline↔spline
  // is the G1 joint at the named ends first.end ↔ second.start (§1.5) —
  // two coincident rows plus the tangent-direction cross row, codimension 3.
  // The anywhere spline↔spline form needs auxiliary solver unknowns and is
  // deliberately staged (§1.6).
  if (firstKind === "spline" || secondKind === "spline") {
    if (firstKind === "spline" && secondKind === "spline") {
      return [
        ...coincidentRows(
          `${label}/joint`,
          origin,
          { entity: first, point: "end" },
          { entity: second, point: "start" },
          context,
        ),
        splineJointTangentRow(
          `${label}/tangent`,
          origin,
          first,
          second,
          context,
        ),
      ];
    }
    const splineId = firstKind === "spline" ? first : second;
    const lineId = firstKind === "line" ? first : second;
    return [tangentLineSplineRow(label, origin, lineId, splineId, context)];
  }
  if (firstKind === "line" || secondKind === "line") {
    const lineId = firstKind === "line" ? first : second;
    const circularId = firstKind === "line" ? second : first;
    const row: ResidualRow = {
      label,
      origin,
      evaluate: (parameters) => {
        const line = lineGeom(parameters, lineSlotsOf(lineId, context));
        const circular = circularSlotsOf(circularId, context);
        const cXSlot = circular.offsets[0];
        const cYSlot = circular.offsets[1];
        const rSlot = circular.offsets[2];
        if (
          cXSlot === undefined ||
          cYSlot === undefined ||
          rSlot === undefined
        ) {
          throw new RangeError("Tangent circle operand is missing slots.");
        }
        const cx = parameters[cXSlot];
        const cy = parameters[cYSlot];
        const radius = parameters[rSlot];
        if (cx === undefined || cy === undefined || radius === undefined) {
          throw new RangeError("Tangent circle operand is missing values.");
        }
        const [x1Slot, y1Slot] = lineSlotsOf(lineId, context).offsets;
        if (x1Slot === undefined || y1Slot === undefined) {
          throw new RangeError("Tangent line operand is missing slots.");
        }
        const x1 = parameters[x1Slot];
        const y1 = parameters[y1Slot];
        if (x1 === undefined || y1 === undefined) {
          throw new RangeError("Tangent line operand is missing values.");
        }
        // Signed distance from the center to the infinite line:
        // cross(d, c − p1) / |d|, minus the radius.
        const wx = cx - x1;
        const wy = cy - y1;
        const cross = line.dx * wy - line.dy * wx;
        const distance = cross / line.length;
        const grad = new Map<number, number>();
        // ∂distance = (∂cross·L − cross·∂L) / L²
        const dCross = new Map<number, number>();
        addInto(dCross, line.ddx, wy);
        addInto(dCross, line.ddy, -wx);
        dCross.set(cXSlot, (dCross.get(cXSlot) ?? 0) - line.dy);
        dCross.set(cYSlot, (dCross.get(cYSlot) ?? 0) + line.dx);
        // The line's own start slots flow through w = c − p1 exactly as in
        // pointOnLineRow (the §1.3 convention-note fix — the analogous
        // ±(dx, dy) columns the circle center already carried).
        dCross.set(x1Slot, (dCross.get(x1Slot) ?? 0) + line.dy);
        dCross.set(y1Slot, (dCross.get(y1Slot) ?? 0) - line.dx);
        const dDistance = chain(
          1 / line.length,
          dCross,
          -cross / (line.length * line.length),
          line.dLength,
        );
        for (const [slot, coeff] of dDistance) grad.set(slot, coeff);
        grad.set(rSlot, (grad.get(rSlot) ?? 0) - 1);
        return { value: distance - radius, grad };
      },
    };
    return [row];
  }
  const row: ResidualRow = {
    label,
    origin,
    evaluate: (parameters) => {
      const a = circularSlotsOf(first, context);
      const b = circularSlotsOf(second, context);
      const slotsFor = (s: EntitySlots) => {
        const [cxA, cyA, rA] = s.offsets;
        if (cxA === undefined || cyA === undefined || rA === undefined) {
          throw new RangeError("Tangent circle operand is missing slots.");
        }
        return { cxA, cyA, rA };
      };
      const sa = slotsFor(a);
      const sb = slotsFor(b);
      const ax = parameters[sa.cxA];
      const ay = parameters[sa.cyA];
      const ar = parameters[sa.rA];
      const bx = parameters[sb.cxA];
      const by = parameters[sb.cyA];
      const br = parameters[sb.rA];
      if (
        ax === undefined ||
        ay === undefined ||
        ar === undefined ||
        bx === undefined ||
        by === undefined ||
        br === undefined
      ) {
        throw new RangeError("Tangent circle operands are missing values.");
      }
      const ux = ax - bx;
      const uy = ay - by;
      const distance = Math.hypot(ux, uy);
      const separation = variant === "external" ? ar + br : Math.abs(ar - br);
      if (distance === 0) {
        return { value: -separation, grad: new Map() };
      }
      const grad = new Map<number, number>();
      grad.set(sa.cxA, ux / distance);
      grad.set(sa.cyA, uy / distance);
      grad.set(sb.cxA, -ux / distance);
      grad.set(sb.cyA, -uy / distance);
      if (variant === "external") {
        grad.set(sa.rA, -1);
        grad.set(sb.rA, -1);
      } else {
        const sign = ar - br >= 0 ? 1 : -1;
        grad.set(sa.rA, -sign);
        grad.set(sb.rA, sign);
      }
      return { value: distance - separation, grad };
    },
  };
  return [row];
}

function midpointRows(
  label: string,
  origin: ResidualOrigin,
  point: PointTarget,
  line: SketchEntityId,
  context: CompiledContext,
): ResidualRow[] {
  const lineSlots = lineSlotsOf(line, context);
  const axisRow = (axis: "x" | "y"): ResidualRow => ({
    label: `${label}/${axis}`,
    origin,
    evaluate: (parameters) => {
      const pointExpression = pointExpr(point, context, parameters, axis);
      const a = axis === "x" ? 0 : 1;
      const b = axis === "x" ? 2 : 3;
      const slotA = lineSlots.offsets[a];
      const slotB = lineSlots.offsets[b];
      if (slotA === undefined || slotB === undefined) {
        throw new RangeError("Midpoint line is missing slots.");
      }
      const va = parameters[slotA];
      const vb = parameters[slotB];
      if (va === undefined || vb === undefined) {
        throw new RangeError("Midpoint line is missing values.");
      }
      const grad = new Map<number, number>(pointExpression.grad);
      grad.set(slotA, (grad.get(slotA) ?? 0) - 0.5);
      grad.set(slotB, (grad.get(slotB) ?? 0) - 0.5);
      return { value: pointExpression.value - (va + vb) / 2, grad };
    },
  });
  return [axisRow("x"), axisRow("y")];
}

function symmetryRows(
  label: string,
  origin: ResidualOrigin,
  first: PointTarget,
  second: PointTarget,
  about:
    | { readonly type: "point"; readonly point: PointTarget }
    | { readonly type: "line"; readonly entity: SketchEntityId },
  context: CompiledContext,
): ResidualRow[] {
  if (about.type === "point") {
    const axisRow = (axis: "x" | "y"): ResidualRow => ({
      label: `${label}/${axis}`,
      origin,
      evaluate: (parameters) => {
        const a = pointExpr(first, context, parameters, axis);
        const b = pointExpr(second, context, parameters, axis);
        const c = pointExpr(about.point, context, parameters, axis);
        // xa + xb − 2·xc = 0 — the midpoint form scaled by 2 (same zero set).
        const grad = new Map<number, number>();
        addInto(grad, a.grad, 1);
        addInto(grad, b.grad, 1);
        addInto(grad, c.grad, -2);
        return { value: a.value + b.value - 2 * c.value, grad };
      },
    });
    return [axisRow("x"), axisRow("y")];
  }
  const axisLineSlots = lineSlotsOf(about.entity, context);
  return [
    {
      label: `${label}/on-axis`,
      origin,
      evaluate: (parameters) => {
        // The midpoint of the pair lies on the axis line:
        // cross(d, mid − p1) = 0 (mm²).
        const ax = pointExpr(first, context, parameters, "x");
        const ay = pointExpr(first, context, parameters, "y");
        const bx = pointExpr(second, context, parameters, "x");
        const by = pointExpr(second, context, parameters, "y");
        const line = lineGeom(parameters, axisLineSlots);
        const [x1Slot, y1Slot] = axisLineSlots.offsets;
        if (x1Slot === undefined || y1Slot === undefined) {
          throw new RangeError("Symmetry axis line is missing slots.");
        }
        const x1 = parameters[x1Slot];
        const y1 = parameters[y1Slot];
        if (x1 === undefined || y1 === undefined) {
          throw new RangeError("Symmetry axis line is missing values.");
        }
        const midX = (ax.value + bx.value) / 2 - x1;
        const midY = (ay.value + by.value) / 2 - y1;
        const cross = line.dx * midY - line.dy * midX;
        // ∂cross = midY·∂dx − midX·∂dy − dy·∂midX + dx·∂midY, with
        // ∂midX = ½∂ax + ½∂bx − ∂x1 and ∂midY = ½∂ay + ½∂by − ∂y1.
        const grad = new Map<number, number>();
        addInto(grad, line.ddx, midY);
        addInto(grad, line.ddy, -midX);
        addInto(grad, ax.grad, -line.dy / 2);
        addInto(grad, bx.grad, -line.dy / 2);
        addInto(grad, ay.grad, line.dx / 2);
        addInto(grad, by.grad, line.dx / 2);
        grad.set(x1Slot, (grad.get(x1Slot) ?? 0) + line.dy);
        grad.set(y1Slot, (grad.get(y1Slot) ?? 0) - line.dx);
        return { value: cross, grad };
      },
    },
    {
      label: `${label}/perpendicular`,
      origin,
      evaluate: (parameters) => {
        // The connecting segment is perpendicular to the axis:
        // dot(b − a, d) = 0 (mm²).
        const ax = pointExpr(first, context, parameters, "x");
        const ay = pointExpr(first, context, parameters, "y");
        const bx = pointExpr(second, context, parameters, "x");
        const by = pointExpr(second, context, parameters, "y");
        const line = lineGeom(parameters, axisLineSlots);
        const ux = bx.value - ax.value;
        const uy = by.value - ay.value;
        const dot = ux * line.dx + uy * line.dy;
        const grad = new Map<number, number>();
        addInto(grad, bx.grad, line.dx);
        addInto(grad, ax.grad, -line.dx);
        addInto(grad, by.grad, line.dy);
        addInto(grad, ay.grad, -line.dy);
        addInto(grad, line.ddx, ux);
        addInto(grad, line.ddy, uy);
        return { value: dot, grad };
      },
    },
  ];
}

/**
 * Compiles entities and constraints into residual rows. Rectangle entities
 * contribute their implicit integrity rows (see module docs). Returns the
 * malformed-reference diagnostics of every constraint that does not resolve
 * against the entity list — those block compilation.
 */
export function compileConstraintSystem(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
): CompiledSystem {
  const diagnostics: SketchDiagnostic[] = [];
  for (const constraint of constraints) {
    const diagnostic = validateConstraintReferences(constraint, entities);
    if (diagnostic !== null) diagnostics.push(diagnostic);
  }
  if (diagnostics.length > 0) return { diagnostics };
  const context: CompiledContext = {
    layout: new ParameterLayout(entities),
    entitiesById: new Map(entities.map((entity) => [entity.id, entity])),
  };
  const rows: ResidualRow[] = [];
  for (const constraint of constraints) {
    const origin: ResidualOrigin = { type: "explicit", id: constraint.id };
    switch (constraint.kind) {
      case "coincident":
        rows.push(
          ...coincidentRows(
            "coincident",
            origin,
            constraint.first,
            constraint.second,
            context,
          ),
        );
        break;
      case "horizontal":
        rows.push(
          horizontalRow("horizontal", origin, constraint.entity, context),
        );
        break;
      case "vertical":
        rows.push(verticalRow("vertical", origin, constraint.entity, context));
        break;
      case "parallel":
        rows.push(
          ...parallelRows(
            "parallel",
            origin,
            constraint.first,
            constraint.second,
            constraint.at ?? "end",
            context,
          ),
        );
        break;
      case "perpendicular":
        rows.push(
          ...perpendicularRows(
            "perpendicular",
            origin,
            constraint.first,
            constraint.second,
            constraint.at ?? "end",
            context,
          ),
        );
        break;
      case "distance":
        rows.push(
          distanceRow(
            "distance",
            origin,
            constraint.first,
            constraint.second,
            context,
            valueIn(constraint.value, "mm"),
          ),
        );
        break;
      case "angle":
        rows.push(
          ...angleRows(
            "angle",
            origin,
            constraint.first,
            constraint.second,
            constraint.at ?? "end",
            context,
            valueIn(constraint.value, "rad"),
          ),
        );
        break;
      case "radius":
        rows.push(
          radiusRow(
            "radius",
            origin,
            constraint.entity,
            context,
            valueIn(constraint.value, "mm"),
            1,
          ),
        );
        break;
      case "diameter":
        rows.push(
          radiusRow(
            "diameter",
            origin,
            constraint.entity,
            context,
            valueIn(constraint.value, "mm"),
            2,
          ),
        );
        break;
      case "equal":
        rows.push(
          equalRow(
            "equal",
            origin,
            constraint.first,
            constraint.second,
            context,
          ),
        );
        break;
      case "tangent":
        rows.push(
          ...tangentRows(
            "tangent",
            origin,
            constraint.first,
            constraint.second,
            constraint.variant,
            context,
          ),
        );
        break;
      case "midpoint":
        rows.push(
          ...midpointRows(
            "midpoint",
            origin,
            constraint.point,
            constraint.line,
            context,
          ),
        );
        break;
      case "symmetry":
        rows.push(
          ...symmetryRows(
            "symmetry",
            origin,
            constraint.first,
            constraint.second,
            constraint.about,
            context,
          ),
        );
        break;
      case "pointOnEntity":
        rows.push(
          pointOnEntityRow(
            "pointOnEntity",
            origin,
            constraint.point,
            constraint.entity,
            context,
          ),
        );
        break;
      case "pointOnTangent":
        rows.push(
          pointOnTangentRow(
            "pointOnTangent",
            origin,
            constraint.point,
            constraint.spline,
            constraint.at,
            context,
          ),
        );
        break;
      case "collinear":
        rows.push(
          ...collinearRows(
            "collinear",
            origin,
            constraint.first,
            constraint.second,
            context,
          ),
        );
        break;
      case "horizontalPair":
        rows.push(
          pointPairAxisRow(
            "horizontalPair",
            origin,
            constraint.first,
            constraint.second,
            context,
            "y",
          ),
        );
        break;
      case "verticalPair":
        rows.push(
          pointPairAxisRow(
            "verticalPair",
            origin,
            constraint.first,
            constraint.second,
            context,
            "x",
          ),
        );
        break;
      case "distanceX":
        rows.push(
          signedAxisDistanceRow(
            "distanceX",
            origin,
            constraint.first,
            constraint.second,
            context,
            "x",
            valueIn(constraint.value, "mm"),
          ),
        );
        break;
      case "distanceY":
        rows.push(
          signedAxisDistanceRow(
            "distanceY",
            origin,
            constraint.first,
            constraint.second,
            context,
            "y",
            valueIn(constraint.value, "mm"),
          ),
        );
        break;
    }
  }
  for (const entity of entities) {
    if (entity.kind !== "rectangle") continue;
    const [e0, e1, e2, e3] = entity.edges;
    if (
      e0 === undefined ||
      e1 === undefined ||
      e2 === undefined ||
      e3 === undefined
    ) {
      continue;
    }
    const origin: ResidualOrigin = { type: "implicit", id: entity.id };
    rows.push(
      ...coincidentRows(
        "rectangle/chain-0",
        origin,
        { entity: e0, point: "end" },
        { entity: e1, point: "start" },
        context,
      ),
      ...coincidentRows(
        "rectangle/chain-1",
        origin,
        { entity: e1, point: "end" },
        { entity: e2, point: "start" },
        context,
      ),
      ...coincidentRows(
        "rectangle/chain-2",
        origin,
        { entity: e2, point: "end" },
        { entity: e3, point: "start" },
        context,
      ),
      ...coincidentRows(
        "rectangle/chain-3",
        origin,
        { entity: e3, point: "end" },
        { entity: e0, point: "start" },
        context,
      ),
      parallelRow("rectangle/parallel-0-2", origin, e0, e2, context),
      parallelRow("rectangle/parallel-1-3", origin, e1, e3, context),
      perpendicularRow("rectangle/perpendicular-0-1", origin, e0, e1, context),
    );
  }
  return { rows };
}

function horizontalRow(
  label: string,
  origin: ResidualOrigin,
  entity: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  const slots = lineSlotsOf(entity, context);
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const y1Slot = slots.offsets[1];
      const y2Slot = slots.offsets[3];
      if (y1Slot === undefined || y2Slot === undefined) {
        throw new RangeError("Horizontal line is missing slots.");
      }
      const y1 = parameters[y1Slot];
      const y2 = parameters[y2Slot];
      if (y1 === undefined || y2 === undefined) {
        throw new RangeError("Horizontal line is missing values.");
      }
      return {
        value: y1 - y2,
        grad: new Map([
          [y1Slot, 1],
          [y2Slot, -1],
        ]),
      };
    },
  };
}

function verticalRow(
  label: string,
  origin: ResidualOrigin,
  entity: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  const slots = lineSlotsOf(entity, context);
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const x1Slot = slots.offsets[0];
      const x2Slot = slots.offsets[2];
      if (x1Slot === undefined || x2Slot === undefined) {
        throw new RangeError("Vertical line is missing slots.");
      }
      const x1 = parameters[x1Slot];
      const x2 = parameters[x2Slot];
      if (x1 === undefined || x2 === undefined) {
        throw new RangeError("Vertical line is missing values.");
      }
      return {
        value: x1 - x2,
        grad: new Map([
          [x1Slot, 1],
          [x2Slot, -1],
        ]),
      };
    },
  };
}
