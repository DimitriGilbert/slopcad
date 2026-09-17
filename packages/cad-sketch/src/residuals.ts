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
 * arc (cx, cy, r, a0, a1). Rectangles carry no slots.
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
      case "rectangle":
        break;
    }
  }
  return values;
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
        throw new RangeError(`Missing parameter value for entity ${entity.id}.`);
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
      case "arc":
        return {
          id: entity.id,
          kind: "arc",
          cx: offset(0),
          cy: offset(1),
          radius: offset(2),
          startAngle: canonicalAngle(offset(3)),
          endAngle: canonicalAngle(offset(4)),
        };
      case "rectangle":
        return { id: entity.id, kind: "rectangle" };
    }
  });
  return { entities: solved };
}

function canonicalAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = angle % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
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

function lineGeom(
  parameters: readonly number[],
  slots: EntitySlots,
): LineGeom {
  const [x1s, y1s, x2s, y2s] = slots.offsets;
  if (x1s === undefined || y1s === undefined || x2s === undefined || y2s === undefined) {
    throw new RangeError("Line entity is missing parameter slots.");
  }
  const x1 = parameters[x1s];
  const y1 = parameters[y1s];
  const x2 = parameters[x2s];
  const y2 = parameters[y2s];
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
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
    for (const [slot, coeff] of ddy) dLength.set(slot, (dLength.get(slot) ?? 0) + (dy / length) * coeff);
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
  for (const [slot, coeff] of du) grad.set(slot, (grad.get(slot) ?? 0) + a * coeff);
  for (const [slot, coeff] of dv) grad.set(slot, (grad.get(slot) ?? 0) + b * coeff);
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
    throw new RangeError(`Point target references unknown entity ${target.entity}.`);
  }
  const value = (localIndex: number): number => {
    const global = slots.offsets[localIndex];
    if (global === undefined) {
      throw new RangeError(`Entity ${target.entity} is missing a parameter slot.`);
    }
    const v = parameters[global];
    if (v === undefined) {
      throw new RangeError(`Entity ${target.entity} is missing a parameter value.`);
    }
    return v;
  };
  const slot = (localIndex: number): number => {
    const global = slots.offsets[localIndex];
    if (global === undefined) {
      throw new RangeError(`Entity ${target.entity} is missing a parameter slot.`);
    }
    return global;
  };
  const slotGrad = (localIndex: number, coefficient: number): Map<number, number> =>
    new Map([[slot(localIndex), coefficient]]);
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
      const grad = chain(dxExpr.value / distance, dxExpr.grad, dyExpr.value / distance, dyExpr.grad);
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
      const sin = Math.sin(target);
      const cos = Math.cos(target);
      // N = sinθ·dot − cosθ·cross; r = N / (L1·L2) = sin(θ − φ) where φ is
      // the angle between the lines — smooth, π-periodic, scale-free.
      const dot = g1.dx * g2.dx + g1.dy * g2.dy;
      const cross = g1.dx * g2.dy - g1.dy * g2.dx;
      const n = sin * dot - cos * cross;
      const lengthProduct = g1.length * g2.length;
      const value = n / lengthProduct;
      const grad = new Map<number, number>();
      // ∂value = (∂N·L − N·∂L) / L² with ∂N = sinθ·∂dot − cosθ·∂cross.
      const dDot = new Map<number, number>();
      addInto(dDot, g1.ddx, g2.dx);
      addInto(dDot, g1.ddy, g2.dy);
      addInto(dDot, g2.ddx, g1.dx);
      addInto(dDot, g2.ddy, g1.dy);
      const dCross = new Map<number, number>();
      addInto(dCross, g1.ddx, g2.dy);
      addInto(dCross, g1.ddy, -g2.dx);
      addInto(dCross, g2.ddy, g1.dx);
      addInto(dCross, g2.ddx, -g1.dy);
      const dN = chain(sin, dDot, -cos, dCross);
      const dLengthProduct = chain(g2.length, g1.dLength, g1.length, g2.dLength);
      for (const slot of new Set([...dN.keys(), ...dLengthProduct.keys()])) {
        const dn = dN.get(slot) ?? 0;
        const dl = dLengthProduct.get(slot) ?? 0;
        grad.set(
          slot,
          (dn * lengthProduct - n * dl) / (lengthProduct * lengthProduct),
        );
      }
      return { value, grad };
    },
  };
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
      const slots = circularSlotsOf(entity, context);
      const radiusSlot = slots.offsets[2];
      if (radiusSlot === undefined) {
        throw new RangeError(`Entity ${entity} is missing its radius slot.`);
      }
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
        if (cXSlot === undefined || cYSlot === undefined || rSlot === undefined) {
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
        ax === undefined || ay === undefined || ar === undefined ||
        bx === undefined || by === undefined || br === undefined
      ) {
        throw new RangeError("Tangent circle operands are missing values.");
      }
      const ux = ax - bx;
      const uy = ay - by;
      const distance = Math.hypot(ux, uy);
      const separation =
        variant === "external" ? ar + br : Math.abs(ar - br);
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
        rows.push(horizontalRow("horizontal", origin, constraint.entity, context));
        break;
      case "vertical":
        rows.push(verticalRow("vertical", origin, constraint.entity, context));
        break;
      case "parallel":
        rows.push(
          parallelRow("parallel", origin, constraint.first, constraint.second, context),
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
        rows.push(equalRow("equal", origin, constraint.first, constraint.second, context));
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
    }
  }
  for (const entity of entities) {
    if (entity.kind !== "rectangle") continue;
    const [e0, e1, e2, e3] = entity.edges;
    if (e0 === undefined || e1 === undefined || e2 === undefined || e3 === undefined) {
      continue;
    }
    const origin: ResidualOrigin = { type: "implicit", id: entity.id };
    rows.push(
      ...coincidentRows("rectangle/chain-0", origin, { entity: e0, point: "end" }, { entity: e1, point: "start" }, context),
      ...coincidentRows("rectangle/chain-1", origin, { entity: e1, point: "end" }, { entity: e2, point: "start" }, context),
      ...coincidentRows("rectangle/chain-2", origin, { entity: e2, point: "end" }, { entity: e3, point: "start" }, context),
      ...coincidentRows("rectangle/chain-3", origin, { entity: e3, point: "end" }, { entity: e0, point: "start" }, context),
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
