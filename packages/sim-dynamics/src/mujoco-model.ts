/**
 * The document→MuJoCo model mapping (Phase 67b): the door's compiled
 * mechanism (SI, validated) rendered as ONE deterministic MJCF string,
 * plus the channel metadata the provider uses to translate state and
 * forces across. Pure: same mechanism → character-identical XML (S2) —
 * the builder output is pinned per joint kind by the provider's suite.
 *
 * ## The mapping, stated
 *
 * - **Bodies**: every occurrence becomes a `<body>` nested under its
 *   tree parent (the worldbody for grounded roots and free roots), with
 *   `pos`/`quat` = the INITIAL placement relative to that parent and an
 *   explicit `<inertial>` (mass, the COG the door rotated into the body
 *   frame, the COG-centred full inertia its origin-frame spatial
 *   inertia parallel-axis-shifts to, then floored at
 *   {@link MJCF_INERTIA_FLOOR_KG_M2} and TRIANGLE-BALANCED by the
 *   minimal rule below — MuJoCo demands strictly positive eigenvalues
 *   AND the rigid-body triangle inequality `λ₁ + λ₂ ≥ λ₃`, while the
 *   door's point-mass stance deliberately admits singular tensors. The
 *   floor adds ε to every eigenvalue; the balance raises ONLY the two
 *   smaller eigenvalues of a violating tensor to `λ₃/2` (the minimal
 *   lift — MuJoCo's own `balanceinertia` substitutes ALL THREE with
 *   their average, 3× off the large principal, rejected here). A real
 *   mass distribution satisfies the triangle law physically, so the
 *   rule fires only on idealized singular tensors; on them the raised
 *   principals multiply exactly the cross-axis motions an axis-granted
 *   joint forbids — dynamically exact for the 67a fixture family — and
 *   the cross-tolerance matrix measures the general effect. No geoms:
 *   contacts never arise.
 * - **Joints**: the mates' chain `W_base ∘ T(o) ∘ Free(q) ∘ B` maps to
 *   MuJoCo's per-body joint list — anchor and axis expressed in the
 *   child's reference frame (`R_refᵀ·(anchor_world − t_ref)` and
 *   `R_refᵀ·R_base·â`), which reproduces the chain's conjugation
 *   semantics exactly for hinges and slides. KIND BY KIND: `revolute`
 *   → one hinge; `slider` → one slide; `cylindrical` → [hinge, slide]
 *   (one axis — the pair commutes); `planar` → [slide(e₁), slide(e₂),
 *   hinge(n)] — slides FIRST so the plane directions stay
 *   pre-rotational and the hinge's anchor rides the translation, the
 *   mates' convention; `ball` → a ball joint (its quaternion composes
 *   child-locally: `R_ball = Bᵀ·exp(φ)·B`); the kernel's `free` root →
 *   `<freejoint/>`; `rigid` → no joint (the body welds by nesting).
 * - **Friction (§7.10, the additive record fields)**: the viscous
 *   damping and Coulomb friction-loss map to the native `damping` and
 *   `frictionloss` attributes on EVERY joint element of the kind — the
 *   per-DOF stance of the reference kernel's cone. Under MuJoCo's
 *   Euler integrator `damping` integrates implicitly and `frictionloss`
 *   solves as a force-limited constraint — measured to reproduce the
 *   reference kernel's spin-down arithmetic exactly (the roadmap's
 *   near-free mapping).
 * - **Motors**: one `<motor>` per record (`gear=1`) on the joint's
 *   rotational element; the record's rotor inertia rides that element's
 *   `armature` — the same mass-diagonal term the reference folds onto
 *   the drive DOF.
 * - **Gravity**: the build's vector rides `<option gravity>` — MuJoCo
 *   applies it as a per-body force at every CoM, the model's own body
 *   force, exactly the contract's stance.
 * - **Loops**: a closing joint maps to MuJoCo equality constraints —
 *   `connect` at the joint origin plus `connect` at an axis-offset
 *   sample point for axis-bearing kinds (two point-coincidences leave
 *   exactly the granted motion), a single `connect` for `ball`, a
 *   `weld` for `rigid`. These are MuJoCo's SOFT constraints (solver
 *   tolerance, not the reference's LM projection): the honest band is
 *   the cross-tolerance matrix's, stated there.
 */

import type { CompiledMechanism } from "./door";
import type { JointDofLayout } from "./joints";
import type { MechanismTopology } from "./topology";

import { motorRotorInertiaKgM2 } from "./motor";
import {
  type Mat3,
  type Vec3,
  add3,
  mulMat3,
  mulMat3Vec,
  scale3,
  sub3,
  transposeMat3,
} from "./spatial";

/** The axis-offset sample of a closing joint's second connect point, m. */
export const MJCF_LOOP_AXIS_SAMPLE_M = 0.05;

/**
 * The loop equality constraints' Baumgarte pair (timeconst s, dampratio
 * 1): a time constant of TWO steps — MuJoCo floors a constraint's
 * solref timeconst at 2×dt, so this is the STIFFEST closure the solver
 * takes at the fixtures' dt = 1 ms (measured: firmer values clamp to
 * the same behavior). The residual band this leaves — tens of µm on
 * the four-bar, with the crank angle tracking the reference's swing to
 * ~4e-2 rad — is the soft-vs-projected closure semantics difference,
 * banded in the cross-tolerance matrix, never hidden.
 */
export const MJCF_LOOP_SOLREF_TIMECONST = 0.002;
export const MJCF_LOOP_SOLREF_DAMPRATIO = 1;

/**
 * The uniform COG-inertia floor, kg·m² (the ONE model-fabrication the
 * mapping makes, stated): MuJoCo requires strictly positive inertia
 * eigenvalues, while the door's point-mass stance deliberately admits
 * singular PSD tensors (zero rotational resistance about the COG — the
 * 67a fixtures are point masses by design). Every body's COG tensor
 * gains ε on its diagonal — a bounded, deterministic band of
 * 1e-9 kg·m², six orders below the fixtures' authored inertias
 * (1e-3..1e-1) and invisible at the cross-tolerance matrix's bands,
 * measured there.
 */
export const MJCF_INERTIA_FLOOR_KG_M2 = 1e-9;

// ---------------------------------------------------------------------------
// Quaternion bridge (MuJoCo speaks wxyz quaternions; the kernel is matrix)
// ---------------------------------------------------------------------------

/** The rotation quaternion (w, x, y, z) of a rotation matrix (Shepperd's method). */
export function quatFromMat3(r: Mat3): [number, number, number, number] {
  const trace = r[0] + r[4] + r[8];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [s / 4, (r[7] - r[5]) / s, (r[2] - r[6]) / s, (r[3] - r[1]) / s];
  }
  if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    return [(r[7] - r[5]) / s, s / 4, (r[3] + r[1]) / s, (r[6] + r[2]) / s];
  }
  if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    return [(r[2] - r[6]) / s, (r[3] + r[1]) / s, s / 4, (r[7] + r[5]) / s];
  }
  const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
  return [(r[3] - r[1]) / s, (r[6] + r[2]) / s, (r[7] + r[5]) / s, s / 4];
}

/** The rotation matrix of a (w, x, y, z) quaternion. */
export function mat3FromQuat(
  q: readonly [number, number, number, number],
): Mat3 {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

/**
 * The rotation vector (axis × angle) of a rotation matrix — the exact
 * inverse of the kernel's `exp([φ]×)`, robust through the acos wedge.
 */
export function rotationVectorFromMat3(r: Mat3): Vec3 {
  const cos = Math.min(1, Math.max(-1, (r[0] + r[4] + r[8] - 1) / 2));
  const angle = Math.acos(cos);
  if (angle < 1e-12) return [0, 0, 0];
  if (Math.PI - angle < 1e-7) {
    // Near π: the axis from the diagonal (every term ≥ 0 there), signs
    // from the symmetric off-diagonal.
    const x = Math.sqrt(Math.max(0, (r[0] + 1) / 2));
    const y = Math.sqrt(Math.max(0, (r[4] + 1) / 2)) * (r[1] >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (r[8] + 1) / 2)) * (r[2] >= 0 ? 1 : -1);
    const len = Math.hypot(x, y, z) || 1;
    return [(x / len) * angle, (y / len) * angle, (z / len) * angle];
  }
  const skew: Vec3 = [(r[7] - r[5]) / 2, (r[2] - r[6]) / 2, (r[3] - r[1]) / 2];
  const len = Math.hypot(skew[0], skew[1], skew[2]) || 1;
  return [
    (skew[0] / len) * angle,
    (skew[1] / len) * angle,
    (skew[2] / len) * angle,
  ];
}

// ---------------------------------------------------------------------------
// Deterministic number formatting (the pinned-XML discipline)
// ---------------------------------------------------------------------------

/** Twelve fixed decimals, trailing zeros trimmed, −0 normalized — total on finite input. */
export function mjcfNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      "Unreachable: the door validated every consumed field as finite.",
    );
  }
  const trimmed = value
    .toFixed(12)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

const vec3Text = (v: Vec3): string =>
  `${mjcfNumber(v[0])} ${mjcfNumber(v[1])} ${mjcfNumber(v[2])}`;

const escapeName = (name: string): string =>
  name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The MJCF element name of joint `id`'s element `k` (0 for single-element joints). */
function elementName(id: string, k: number): string {
  return k === 0 ? id : `${id}#${k}`;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** One tree joint's translation channel between our state and MJCF. */
export interface MjcfJointChannel {
  readonly ourId: string;
  readonly wireIndex: number;
  readonly layout: JointDofLayout;
  /** The MJCF joint element names, in MJCF qpos order. */
  readonly elementNames: readonly string[];
  /** Our pinned DOF order → MJCF element index ([] for ball/free — custom conversions). */
  readonly elementOfDof: readonly number[];
  /** Ball joints only: the child's zero-station rotation B. */
  readonly ballB?: Mat3;
  /** Free roots only: the body's initial world frame (B itself). */
  readonly freeInitial?: { readonly r: Mat3; readonly t: Vec3 };
}

/** One motor's channel: the record drives this MJCF joint element. */
export interface MjcfMotorChannel {
  readonly jointId: string;
  readonly elementName: string;
  readonly motorIndex: number;
}

/** One closing joint's equality constraint names. */
export interface MjcfLoopChannel {
  readonly jointId: string;
  readonly equalityNames: readonly string[];
}

/** The built model: the deterministic MJCF text plus every state channel. */
export interface MjcfDocument {
  readonly xml: string;
  readonly joints: readonly MjcfJointChannel[];
  readonly motors: readonly MjcfMotorChannel[];
  readonly loops: readonly MjcfLoopChannel[];
}

/** Renders the mechanism as MJCF — a pure function of the compiled mechanism and topology. */
export function buildMjcf(
  mechanism: CompiledMechanism,
  topology: MechanismTopology,
): MjcfDocument {
  const joints: MjcfJointChannel[] = [];
  const loops: MjcfLoopChannel[] = [];
  const motors: MjcfMotorChannel[] = [];
  const builder = new MjcfBuilder(mechanism, topology, joints, motors, loops);
  const xml = builder.render();
  return { xml, joints, motors, loops };
}

/** Internal one-shot builder state (renderBody recursion). */
class MjcfBuilder {
  private readonly childrenOf = new Map<number, number[]>();
  private readonly wireIndexOfBody = new Map<number, number>();
  private readonly nodesByBody = new Map<
    number,
    MechanismTopology["nodes"][number]
  >();

  constructor(
    private readonly mechanism: CompiledMechanism,
    private readonly topology: MechanismTopology,
    private readonly joints: MjcfJointChannel[],
    private readonly motors: MjcfMotorChannel[],
    private readonly loops: MjcfLoopChannel[],
  ) {
    this.nodesByBody = new Map(
      topology.nodes.map((node) => [node.child, node]),
    );
    for (const node of topology.nodes) {
      const list = this.childrenOf.get(node.parent) ?? [];
      list.push(node.child);
      this.childrenOf.set(node.parent, list);
      this.wireIndexOfBody.set(node.child, node.wireIndex);
    }
  }

  render(): string {
    const worldChildren = this.mechanism.bodies
      .map((_, index) => index)
      .filter((index) => {
        // World children: grounded roots (no tree node) and free roots
        // (node with a −1 parent); everything else nests under its
        // tree parent.
        const node = this.nodeOf(index);
        return (
          !this.topology.isTreeChild[index] &&
          (node === undefined || node.parent < 0)
        );
      })
      .sort((a, b) => a - b)
      .map((index) => this.renderBody(index, "    "))
      .join("\n");

    const equalityLines: string[] = [];
    for (const wireIndex of this.topology.loopWire) {
      this.renderLoopEquality(wireIndex, equalityLines);
    }
    const actuatorLines: string[] = [];
    for (const [index, entry] of this.mechanism.motors.entries()) {
      const channel = this.joints.find(
        (joint) => joint.ourId === entry.jointId,
      );
      if (channel === undefined) {
        throw new Error("Unreachable: the door validated motor joints.");
      }
      // Motors ride exactly-one-rotational-DOF kinds (revolute or
      // cylindrical) — the rotational element is elementNames[0].
      const element = channel.elementNames[0];
      if (element === undefined) {
        throw new Error("Unreachable: motor channels carry elements.");
      }
      actuatorLines.push(
        `      <motor name="${escapeName(entry.jointId)}" joint="${escapeName(element)}" gear="1"/>`,
      );
      this.motors.push({
        jointId: entry.jointId,
        elementName: element,
        motorIndex: index,
      });
    }

    const g = this.mechanism.gravityMPerS2;
    const gravity: Vec3 = [g[0], g[1], g[2]];
    return [
      `<mujoco model="slopcad">`,
      `  <compiler angle="radian" inertiafromgeom="false"/>`,
      `  <option timestep="0.001" gravity="${vec3Text(gravity)}" integrator="Euler"/>`,
      `  <worldbody>`,
      worldChildren,
      `  </worldbody>`,
      ...(equalityLines.length > 0
        ? [`  <equality>`, ...equalityLines, `  </equality>`]
        : []),
      ...(actuatorLines.length > 0
        ? [`  <actuator>`, ...actuatorLines, `  </actuator>`]
        : []),
      `</mujoco>`,
    ].join("\n");
  }

  private nodeOf(
    bodyIndex: number,
  ): MechanismTopology["nodes"][number] | undefined {
    return this.nodesByBody.get(bodyIndex);
  }

  private renderBody(bodyIndex: number, indent: string): string {
    const body = this.mechanism.bodies[bodyIndex];
    if (body === undefined) {
      throw new Error("Unreachable: body indices address compiled bodies.");
    }
    const wireIndex = this.wireIndexOfBody.get(bodyIndex);
    const parentIndex = this.nodeOf(bodyIndex)?.parent;
    const parent =
      parentIndex !== undefined && parentIndex >= 0
        ? this.mechanism.bodies[parentIndex]
        : undefined;
    const pos = parent
      ? mulMat3Vec(
          transposeMat3(parent.initialR),
          sub3(body.initialT, parent.initialT),
        )
      : body.initialT;
    const rel = parent
      ? mulMat3(transposeMat3(parent.initialR), body.initialR)
      : body.initialR;
    const quat = quatFromMat3(rel);
    const cog = scale3(body.inertiaLocal.h, 1 / body.inertiaLocal.m);
    const full = cogInertia(body.inertiaLocal);
    const lines = [
      `${indent}<body name="${escapeName(body.id)}" pos="${vec3Text(pos)}" quat="${quat.map(mjcfNumber).join(" ")}">`,
      `${indent}  <inertial pos="${vec3Text(cog)}" mass="${mjcfNumber(body.inertiaLocal.m)}" fullinertia="${full.map(mjcfNumber).join(" ")}"/>`,
    ];
    if (wireIndex !== undefined) {
      lines.push(
        ...this.renderJoint(bodyIndex, wireIndex).map(
          (line) => `${indent}  ${line}`,
        ),
      );
    }
    for (const child of [...(this.childrenOf.get(bodyIndex) ?? [])].sort(
      (a, b) => a - b,
    )) {
      lines.push(this.renderBody(child, `${indent}  `));
    }
    lines.push(`${indent}</body>`);
    return lines.join("\n");
  }

  private renderJoint(bodyIndex: number, wireIndex: number): string[] {
    const body = this.mechanism.bodies[bodyIndex];
    const parentIndex = this.nodeOf(bodyIndex)?.parent;
    if (body === undefined || parentIndex === undefined) {
      throw new Error("Unreachable: jointed bodies carry tree parents.");
    }
    if (wireIndex < 0) {
      // The synthetic free root.
      this.joints.push({
        ourId: `${body.id}::free`,
        wireIndex: -1,
        layout: {
          kind: "free",
          rotational: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          translational: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
        },
        elementNames: [`${body.id}::free`],
        elementOfDof: [],
        freeInitial: { r: body.initialR, t: body.initialT },
      });
      return [`<freejoint name="${escapeName(`${body.id}::free`)}"/>`];
    }
    const wire = this.mechanism.joints[wireIndex];
    const parent = this.mechanism.bodies[parentIndex];
    if (wire === undefined || parent === undefined) {
      throw new Error("Unreachable: wire indices and parents are validated.");
    }
    const anchorWorld = add3(
      parent.initialT,
      mulMat3Vec(parent.initialR, wire.origin ?? [0, 0, 0]),
    );
    const anchorLocal = mulMat3Vec(
      transposeMat3(body.initialR),
      sub3(anchorWorld, body.initialT),
    );
    // One element's attributes: the axis (base-local, per element) into
    // the child's reference frame, friction fields, rotor armature.
    const attrs = (
      k: number,
      rotational: boolean,
      axisBaseLocal: Vec3,
    ): string => {
      const axisWorld = mulMat3Vec(parent.initialR, axisBaseLocal);
      const axisLocal = mulMat3Vec(transposeMat3(body.initialR), axisWorld);
      const parts = [
        ` type="${rotational ? "hinge" : "slide"}"`,
        ` name="${escapeName(elementName(wire.id, k))}"`,
        ` pos="${vec3Text(anchorLocal)}"`,
        ` axis="${vec3Text(axisLocal)}"`,
      ];
      if (wire.viscousDamping > 0) {
        parts.push(` damping="${mjcfNumber(wire.viscousDamping)}"`);
      }
      if (wire.frictionLoss > 0) {
        parts.push(` frictionloss="${mjcfNumber(wire.frictionLoss)}"`);
      }
      const motorIndex = this.motorIndexOf(wire.id);
      if (motorIndex !== undefined && rotational) {
        const entry = this.mechanism.motors[motorIndex];
        const armature = entry ? motorRotorInertiaKgM2(entry.motor) : 0;
        if (armature > 0) {
          parts.push(` armature="${mjcfNumber(armature)}"`);
        }
      }
      return parts.join("");
    };
    const e1 = wire.plane?.[0] ?? [1, 0, 0];
    const e2 = wire.plane?.[1] ?? [0, 1, 0];
    const axis = wire.axis ?? [0, 0, 1];
    switch (wire.kind) {
      case "rigid":
        return [];
      case "revolute": {
        this.joints.push({
          ourId: wire.id,
          wireIndex,
          layout: wire.layout,
          elementNames: [elementName(wire.id, 0)],
          elementOfDof: [0],
        });
        return [`<joint${attrs(0, true, axis)}/>`];
      }
      case "slider": {
        this.joints.push({
          ourId: wire.id,
          wireIndex,
          layout: wire.layout,
          elementNames: [elementName(wire.id, 0)],
          elementOfDof: [0],
        });
        return [`<joint${attrs(0, false, axis)}/>`];
      }
      case "cylindrical": {
        this.joints.push({
          ourId: wire.id,
          wireIndex,
          layout: wire.layout,
          elementNames: [elementName(wire.id, 0), elementName(wire.id, 1)],
          elementOfDof: [0, 1],
        });
        return [
          `<joint${attrs(0, true, axis)}/>`,
          `<joint${attrs(1, false, axis)}/>`,
        ];
      }
      case "planar": {
        // Slides first, hinge last — the mates' pre-rotational plane
        // directions with the riding rotation centre (stated in the
        // module header). Our pinned DOF order [n, e₁, e₂] maps to
        // elements [2, 0, 1].
        this.joints.push({
          ourId: wire.id,
          wireIndex,
          layout: wire.layout,
          elementNames: [
            elementName(wire.id, 0),
            elementName(wire.id, 1),
            elementName(wire.id, 2),
          ],
          elementOfDof: [2, 0, 1],
        });
        return [
          `<joint${attrs(0, false, e1)}/>`,
          `<joint${attrs(1, false, e2)}/>`,
          `<joint${attrs(2, true, axis)}/>`,
        ];
      }
      case "ball": {
        // B = R_baseᵀ·R_child — the child's zero-station rotation, the
        // ball quaternion's conjugation frame.
        const bR = mulMat3(transposeMat3(parent.initialR), body.initialR);
        this.joints.push({
          ourId: wire.id,
          wireIndex,
          layout: wire.layout,
          elementNames: [elementName(wire.id, 0)],
          elementOfDof: [],
          ballB: bR,
        });
        const parts = [
          ` type="ball"`,
          ` name="${escapeName(elementName(wire.id, 0))}"`,
          ` pos="${vec3Text(anchorLocal)}"`,
        ];
        if (wire.viscousDamping > 0) {
          parts.push(` damping="${mjcfNumber(wire.viscousDamping)}"`);
        }
        if (wire.frictionLoss > 0) {
          parts.push(` frictionloss="${mjcfNumber(wire.frictionLoss)}"`);
        }
        return [`<joint${parts.join("")}/>`];
      }
    }
  }

  private motorIndexOf(jointId: string): number | undefined {
    const index = this.mechanism.motors.findIndex(
      (entry) => entry.jointId === jointId,
    );
    return index === -1 ? undefined : index;
  }

  private renderLoopEquality(wireIndex: number, lines: string[]): void {
    const wire = this.mechanism.joints[wireIndex];
    if (wire === undefined) {
      throw new Error("Unreachable: loop wire indices are joint indices.");
    }
    const b1 = escapeName(wire.baseId);
    const b2 = escapeName(wire.movedId);
    if (wire.kind === "rigid") {
      lines.push(
        `      <weld name="${escapeName(`${wire.id}#eq0`)}" body1="${b1}" body2="${b2}"/>`,
      );
      this.loops.push({
        jointId: wire.id,
        equalityNames: [`${wire.id}#eq0`],
      });
      return;
    }
    const origin = wire.origin ?? [0, 0, 0];
    const axis = wire.axis ?? [0, 0, 1];
    lines.push(
      `      <connect name="${escapeName(`${wire.id}#eq0`)}" body1="${b1}" body2="${b2}" anchor="${vec3Text(origin)}" solref="${mjcfNumber(MJCF_LOOP_SOLREF_TIMECONST)} ${mjcfNumber(MJCF_LOOP_SOLREF_DAMPRATIO)}"/>`,
    );
    if (wire.kind === "ball") {
      this.loops.push({
        jointId: wire.id,
        equalityNames: [`${wire.id}#eq0`],
      });
      return;
    }
    const anchor2 = add3(origin, scale3(axis, MJCF_LOOP_AXIS_SAMPLE_M));
    lines.push(
      `      <connect name="${escapeName(`${wire.id}#eq1`)}" body1="${b1}" body2="${b2}" anchor="${vec3Text(anchor2)}" solref="${mjcfNumber(MJCF_LOOP_SOLREF_TIMECONST)} ${mjcfNumber(MJCF_LOOP_SOLREF_DAMPRATIO)}"/>`,
    );
    this.loops.push({
      jointId: wire.id,
      equalityNames: [`${wire.id}#eq0`, `${wire.id}#eq1`],
    });
  }
}

/**
 * The COG-centred inertia tensor [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] of an
 * origin-frame spatial inertia, floored and triangle-balanced for
 * MuJoCo: the inverse parallel-axis shift
 * `I_cog = I₀ − m·(‖c‖²E − ccᵀ)` (a point mass lands on all-zero
 * rotational inertia, the door's own stance), `+ ε·E`, then — only
 * when the eigenvalues violate `λ₁ + λ₂ ≥ λ₃` — the two smaller
 * eigenvalues raised to `λ₃/2` in the tensor's own principal frame
 * (deterministic cyclic Jacobi, pinned sweeps).
 */
function cogInertia(inertia: {
  m: number;
  h: Vec3;
  i0: Mat3;
}): [number, number, number, number, number, number] {
  const c = scale3(inertia.h, 1 / inertia.m);
  const c2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
  const m = inertia.m;
  const kernel = (i: number, j: number): number =>
    i === j ? c2 - (c[i] ?? 0) * (c[i] ?? 0) : -(c[i] ?? 0) * (c[j] ?? 0);
  const floored: Mat3 = [
    inertia.i0[0] - m * kernel(0, 0) + MJCF_INERTIA_FLOOR_KG_M2,
    inertia.i0[1] - m * kernel(0, 1),
    inertia.i0[2] - m * kernel(0, 2),
    inertia.i0[3] - m * kernel(1, 0),
    inertia.i0[4] - m * kernel(1, 1) + MJCF_INERTIA_FLOOR_KG_M2,
    inertia.i0[5] - m * kernel(1, 2),
    inertia.i0[6] - m * kernel(2, 0),
    inertia.i0[7] - m * kernel(2, 1),
    inertia.i0[8] - m * kernel(2, 2) + MJCF_INERTIA_FLOOR_KG_M2,
  ];
  const balanced = balanceTriangle(floored);
  return [
    balanced[0],
    balanced[4],
    balanced[8],
    balanced[1],
    balanced[2],
    balanced[5],
  ];
}

/** The pinned Jacobi sweep count of the principal-frame decomposition. */
const JACOBI_SWEEPS = 8;

/**
 * Raises the two smaller eigenvalues of a symmetric tensor to λ₃/2 when
 * they violate `λ₁ + λ₂ ≥ λ₃`, in the tensor's own principal frame
 * (cyclic Jacobi, fixed sweeps — deterministic). Tensors that already
 * satisfy the law pass through UNCHANGED (real mass distributions
 * always do).
 */
function balanceTriangle(tensor: Mat3): Mat3 {
  let a: number[] = [...tensor];
  let q: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep += 1) {
    for (const [p, r] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p * 3 + r] ?? 0;
      if (Math.abs(apq) < 1e-18) continue;
      const app = a[p * 3 + p] ?? 0;
      const arr = a[r * 3 + r] ?? 0;
      const theta = (arr - app) / (2 * apq);
      const t =
        Math.sign(theta || 1) /
        (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cos = 1 / Math.sqrt(t * t + 1);
      const sin = t * cos;
      a = rotateSimilarity(a, p, r, cos, sin);
      q = rotateRight(q, p, r, cos, sin);
    }
  }
  const eigen = [a[0] ?? 0, a[4] ?? 0, a[8] ?? 0];
  const sorted = [...eigen].sort((x, y) => x - y);
  const smallest = sorted[0] ?? 0;
  const middle = sorted[1] ?? 0;
  const largest = sorted[2] ?? 0;
  if (smallest + middle >= largest) return tensor;
  // The lifted pair must clear λ₃ STRICTLY (the ε floor on λ₃ would
  // otherwise break the equality edge again).
  const lifted = largest / 2 + MJCF_INERTIA_FLOOR_KG_M2;
  const adjusted: number[] = eigen.map((value) =>
    value <= middle + 1e-15 ? lifted : value,
  );
  // Recompose Q·diag(adjusted)·Qᵀ (columns of q are the eigenvectors).
  const out: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let col = 0; col < 3; col += 1) {
    const scale = adjusted[col] ?? 0;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const vi = q[i * 3 + col] ?? 0;
        const vj = q[j * 3 + col] ?? 0;
        out[i * 3 + j] = (out[i * 3 + j] ?? 0) + scale * vi * vj;
      }
    }
  }
  return [
    out[0] ?? 0,
    out[1] ?? 0,
    out[2] ?? 0,
    out[3] ?? 0,
    out[4] ?? 0,
    out[5] ?? 0,
    out[6] ?? 0,
    out[7] ?? 0,
    out[8] ?? 0,
  ];
}

/** A·G·Gᵀ (one Jacobi similarity rotation; the mutable inner form). */
function rotateSimilarity(
  a: number[],
  p: number,
  r: number,
  cos: number,
  sin: number,
): number[] {
  const out = [...a];
  for (let k = 0; k < 3; k += 1) {
    const akp = out[k * 3 + p] ?? 0;
    const akr = out[k * 3 + r] ?? 0;
    out[k * 3 + p] = cos * akp - sin * akr;
    out[k * 3 + r] = sin * akp + cos * akr;
  }
  for (let k = 0; k < 3; k += 1) {
    const apk = out[p * 3 + k] ?? 0;
    const ark = out[r * 3 + k] ?? 0;
    out[p * 3 + k] = cos * apk - sin * ark;
    out[r * 3 + k] = sin * apk + cos * ark;
  }
  return out;
}

/** Q·G (accumulate the eigenvector columns; the mutable inner form). */
function rotateRight(
  q: number[],
  p: number,
  r: number,
  cos: number,
  sin: number,
): number[] {
  const out = [...q];
  for (let k = 0; k < 3; k += 1) {
    const qkp = out[k * 3 + p] ?? 0;
    const qkr = out[k * 3 + r] ?? 0;
    out[k * 3 + p] = cos * qkp - sin * qkr;
    out[k * 3 + r] = sin * qkp + cos * qkr;
  }
  return out;
}
