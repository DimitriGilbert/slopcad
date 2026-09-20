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
  bezierChainOfSpline,
  projectOntoSpline,
  splinePointGradient,
} from "./spline-math";
import {
  type PointTarget,
  type SketchConstraint,
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
        if (xSlot === undefined || ySlot === undefined) continue;
        grad.set(xSlot, (grad.get(xSlot) ?? 0) + ux * weight);
        grad.set(ySlot, (grad.get(ySlot) ?? 0) + uy * weight);
      }
      return { value: projection.distance, grad };
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
          parallelRow(
            "parallel",
            origin,
            constraint.first,
            constraint.second,
            context,
          ),
        );
        break;
      case "perpendicular":
        rows.push(
          perpendicularRow(
            "perpendicular",
            origin,
            constraint.first,
            constraint.second,
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
          angleRow(
            "angle",
            origin,
            constraint.first,
            constraint.second,
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
