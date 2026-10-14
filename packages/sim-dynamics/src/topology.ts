/**
 * The mechanism topology split (Phase 67a's kernel discipline, shared by
 * the reference kernel and the MuJoCo provider since 67b): which joints
 * are TREE edges and which CLOSE cycles. The rule, deterministic by wire
 * order: the FIRST joint per moved occurrence claims the tree edge
 * (document order); a joint whose moved occurrence already has a parent,
 * or whose base is a descendant of the moved occurrence (it would close a
 * cycle), becomes a loop constraint instead. One synthetic FREE root
 * joint per ungrounded occurrence with no parent. Pure: same inputs →
 * same outputs (S2), zero dependencies.
 */

import type { CompiledBody, CompiledJoint } from "./door";

/** One tree edge: a wire joint, or a synthetic free root (wireIndex −1). */
export interface TreeTopologyNode {
  /** The wire joint's compiled index; −1 for a synthetic free root. */
  readonly wireIndex: number;
  readonly child: number;
  readonly parent: number;
}

/** The split mechanism's topology (all orders deterministic by wire order). */
export interface MechanismTopology {
  /** Tree joints in topological order (parents before children). */
  readonly nodes: readonly TreeTopologyNode[];
  /** Body indices in the tree's visit order (ties by input order). */
  readonly order: readonly number[];
  /** The wire indices that close loops, in wire order. */
  readonly loopWire: readonly number[];
  /** Per body: whether a wire joint claims it as a tree child. */
  readonly isTreeChild: readonly boolean[];
}

/**
 * Splits the mechanism's joints into tree edges and closing loops. The
 * `bodies`/`joints` are the door's compiled forms; only ids, grounded
 * flags, and joint endpoints are consumed.
 */
export function mechanismTopology(
  bodies: readonly CompiledBody[],
  joints: readonly CompiledJoint[],
): MechanismTopology {
  const bodyIndexOf = new Map<string, number>();
  bodies.forEach((body, index) => bodyIndexOf.set(body.id, index));

  const parentWireOf = new Map<number, number>();
  const edgeOf = new Map<number, { parent: number; child: number }>();
  const treeWire: number[] = [];
  const loopWire: number[] = [];
  const isAncestorOf = (candidate: number, of: number): boolean => {
    let cursor = of;
    for (let guard = 0; guard < bodies.length; guard += 1) {
      const wireIndex = parentWireOf.get(cursor);
      if (wireIndex === undefined) return false;
      const edge = edgeOf.get(wireIndex);
      if (edge === undefined) return false;
      if (edge.parent === candidate) return true;
      cursor = edge.parent;
    }
    return false;
  };
  joints.forEach((joint, wireIndex) => {
    const base = bodyIndexOf.get(joint.baseId);
    const moved = bodyIndexOf.get(joint.movedId);
    if (base === undefined || moved === undefined) {
      throw new Error("Unreachable: the door validated joint endpoints.");
    }
    if (parentWireOf.has(moved) || isAncestorOf(moved, base)) {
      loopWire.push(wireIndex);
      return;
    }
    parentWireOf.set(moved, wireIndex);
    edgeOf.set(wireIndex, { parent: base, child: moved });
    treeWire.push(wireIndex);
  });

  const pending: TreeTopologyNode[] = treeWire.map((wireIndex) => {
    const edge = edgeOf.get(wireIndex);
    if (edge === undefined) {
      throw new Error("Unreachable: every tree wire index carries an edge.");
    }
    return { wireIndex, child: edge.child, parent: edge.parent };
  });
  for (const [index, body] of bodies.entries()) {
    if (parentWireOf.has(index) || body.grounded) continue;
    pending.push({ wireIndex: -1, child: index, parent: -1 });
  }
  const childrenOf = new Map<number, number[]>();
  for (const node of pending) {
    const list = childrenOf.get(node.parent) ?? [];
    list.push(node.child);
    childrenOf.set(node.parent, list);
  }
  const order: number[] = [];
  const visited = new Set<number>();
  const visit = (body: number): void => {
    if (visited.has(body)) return;
    visited.add(body);
    order.push(body);
    for (const child of [...(childrenOf.get(body) ?? [])].sort(
      (a, b) => a - b,
    )) {
      visit(child);
    }
  };
  for (const index of bodies.keys()) {
    if (!parentWireOf.has(index)) visit(index);
  }
  for (const index of bodies.keys()) visit(index);
  const orderPosition = new Map<number, number>();
  order.forEach((body, position) => orderPosition.set(body, position));
  pending.sort(
    (a, b) =>
      (orderPosition.get(a.child) ?? 0) - (orderPosition.get(b.child) ?? 0),
  );

  return {
    nodes: pending,
    order,
    loopWire,
    isTreeChild: bodies.map((_, index) => parentWireOf.has(index)),
  };
}
