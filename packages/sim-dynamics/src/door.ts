/**
 * The document→solver door of the dynamics domain (Phase 67a, law S4's
 * document half): occurrences, serialized joint records, mass
 * properties, and motor records arrive in their CANONICAL SERIALIZED
 * document forms (placements in mm, mass in grams, COG in world mm,
 * motor datasheet units) and leave as pure-SI solver-space data — the
 * same stance the thermal material door takes: this package depends on
 * nothing at runtime but `@slopcad/sim-core`, re-validates every field
 * it consumes, and declines loudly (`sim/mechanism-invalid`) rather
 * than guessing. The joint vocabulary is RESTATED (never imported at
 * runtime) and cross-compat-pinned against `@slopcad/cad-core` in the
 * dev-only suite — the established sim-flow/sim-thermal pattern.
 *
 * The conversions happen HERE and only here in this package:
 * mm → m on placements, joint frames, and COGs (÷ 1000), grams → kg on
 * mass (÷ 1000); motor records compile through sim-core's
 * `compileSimMotor` — the ONE authored-datasheet → SI motor site in
 * the stack (never restated here).
 */

import {
  compileSimMotor,
  type CompiledSimMotor,
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { DynamicsBuildInput } from "./contract";

import { auxiliaryBasis, jointDofLayout, type JointDofLayout } from "./joints";
import {
  type Mat3,
  type SpatialInertia,
  type Vec3,
  mulMat3Vec,
  rotateSpatialInertia,
  spatialInertiaAboutOrigin,
  sub3,
  transposeMat3,
} from "./spatial";

/**
 * The document joint kinds the door restates (cross-compat pinned
 * against cad-core's `JOINT_KINDS` by the dev-only suite); the
 * kernel-internal `free` root joint never crosses this wire.
 */
export type DoorJointKind =
  "rigid" | "revolute" | "slider" | "cylindrical" | "planar" | "ball";

const DOOR_JOINT_KINDS: readonly DoorJointKind[] = [
  "rigid",
  "revolute",
  "slider",
  "cylindrical",
  "planar",
  "ball",
];

const UNIT_CONVERSION = 1000;

/** Builds a row-major 3×3 from a length-validated 9-list (the door's own narrow). */
function asMat3(values: readonly number[]): Mat3 {
  return [
    values[0] ?? 0,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 0,
    values[4] ?? 0,
    values[5] ?? 0,
    values[6] ?? 0,
    values[7] ?? 0,
    values[8] ?? 0,
  ];
}

function refuse(message: string, at: unknown): SimParseResult<never, SimError> {
  return simFail(simError(SIM_ERROR_CODES.mechanismInvalid, message, at));
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function finiteTriple(
  input: unknown,
  what: string,
): SimParseResult<[number, number, number], SimError> {
  if (
    !Array.isArray(input) ||
    input.length !== 3 ||
    !input.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return refuse(
      `${what} must be an array of exactly three finite numbers.`,
      input,
    );
  }
  return simOk([input[0], input[1], input[2]]);
}

/** One body in solver space: its initial world frame (SI) and inertias. */
export interface CompiledBody {
  readonly id: string;
  readonly initialR: Mat3;
  readonly initialT: Vec3;
  /** The spatial inertia about the body-frame origin, world-aligned at the initial placement. */
  readonly inertiaWorld: SpatialInertia;
  /** The same inertia in the body's LOCAL frame (the kernel's per-step rotation source). */
  readonly inertiaLocal: SpatialInertia;
  readonly grounded: boolean;
}

/** One wire joint in solver space (SI); the tree/loop topology split is the kernel's. */
export interface CompiledJoint {
  readonly id: string;
  readonly name: string;
  readonly kind: DoorJointKind;
  readonly baseId: string;
  readonly movedId: string;
  /** The joint origin in the BASE's local coordinates, m. */
  readonly origin: Vec3 | undefined;
  /** The unit joint axis in base-local coordinates (axis-bearing kinds). */
  readonly axis: Vec3 | undefined;
  /** The deterministic in-plane basis of a planar joint's normal. */
  readonly plane: readonly [Vec3, Vec3] | undefined;
  /** Viscous damping coefficient (consumed per-DOF flavour by the kernel). */
  readonly viscousDamping: number;
  /**
   * Coulomb friction-loss magnitude (consumed per-DOF flavour by the
   * kernel; a CLOSING joint carrying either friction field is declined
   * at the kernel's build — never silently dropped).
   */
  readonly frictionLoss: number;
  readonly layout: JointDofLayout;
  readonly initialRates: readonly number[];
}

/** A motor assignment in solver space (the compiled SI motor + its joint). */
export interface CompiledMotorAssignment {
  readonly jointId: string;
  readonly motor: CompiledSimMotor;
}

/** The door's output: one mechanism in solver space. */
export interface CompiledMechanism {
  readonly bodies: readonly CompiledBody[];
  readonly joints: readonly CompiledJoint[];
  readonly motors: readonly CompiledMotorAssignment[];
  readonly gravityMPerS2: readonly [number, number, number];
}

/**
 * Compiles one mechanism's wire forms into solver space. Every decline
 * is `sim/mechanism-invalid` with the refusing field as evidence.
 */
export function compileMechanism(
  input: DynamicsBuildInput,
): SimParseResult<CompiledMechanism, SimError> {
  if (!isPlainRecord(input)) {
    return refuse("A mechanism build must be a plain object.", input);
  }
  const gravity = finiteTriple(
    input.gravityMPerS2,
    "A mechanism's gravity vector",
  );
  if (!gravity.ok) return gravity;

  // --- Occurrences: unique ids, orthonormal rotations, mm → m ----------
  const occurrenceIds: string[] = [];
  const idSet = new Set<string>();
  const initialFrames = new Map<string, { r: Mat3; t: Vec3 }>();
  if (!Array.isArray(input.occurrences) || input.occurrences.length === 0) {
    return refuse(
      "A mechanism must carry at least one placed occurrence.",
      input.occurrences,
    );
  }
  for (const entry of input.occurrences) {
    if (
      !isPlainRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0
    ) {
      return refuse("Each occurrence must carry a non-empty id string.", entry);
    }
    if (idSet.has(entry.id)) {
      return refuse(
        `The occurrence id "${entry.id}" appears twice; occurrence ids must be unique.`,
        entry.id,
      );
    }
    const placement = entry.placement;
    if (!isPlainRecord(placement)) {
      return refuse(
        `The occurrence "${entry.id}" must carry a placement object.`,
        placement,
      );
    }
    if (
      !Array.isArray(placement.rotation) ||
      placement.rotation.length !== 9 ||
      !placement.rotation.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      return refuse(
        `The occurrence "${entry.id}" placement rotation must be nine finite row-major numbers.`,
        placement.rotation,
      );
    }
    const rotation = placement.rotation as readonly number[];
    if (!isOrthonormal(rotation)) {
      return refuse(
        `The occurrence "${entry.id}" placement rotation must be orthonormal.`,
        rotation,
      );
    }
    const translation = finiteTriple(
      placement.translation,
      `The occurrence "${entry.id}" placement translation`,
    );
    if (!translation.ok) return translation;
    occurrenceIds.push(entry.id);
    idSet.add(entry.id);
    initialFrames.set(entry.id, {
      r: asMat3(rotation),
      t: [
        translation.value[0] / UNIT_CONVERSION,
        translation.value[1] / UNIT_CONVERSION,
        translation.value[2] / UNIT_CONVERSION,
      ],
    });
  }

  // --- Masses: one per occurrence; world COG → local; optional tensor ---
  const grounded = new Set(
    (input.grounded ?? []).filter((id): id is string => typeof id === "string"),
  );
  const massEntries = new Map<
    string,
    { massKg: number; cogLocal: Vec3; tensorLocal: Mat3 | undefined }
  >();
  if (!Array.isArray(input.masses)) {
    return refuse(
      "A mechanism build must carry its mass-properties list.",
      input.masses,
    );
  }
  for (const entry of input.masses) {
    if (!isPlainRecord(entry)) {
      return refuse(
        "Each mass-properties entry must be a plain object.",
        entry,
      );
    }
    if (
      typeof entry.occurrenceId !== "string" ||
      !idSet.has(entry.occurrenceId)
    ) {
      return refuse(
        "Each mass-properties entry must name an occurrence of the mechanism.",
        entry.occurrenceId,
      );
    }
    if (massEntries.has(entry.occurrenceId)) {
      return refuse(
        `The occurrence "${entry.occurrenceId}" carries two mass-properties entries.`,
        entry.occurrenceId,
      );
    }
    if (
      typeof entry.massGrams !== "number" ||
      !Number.isFinite(entry.massGrams) ||
      entry.massGrams <= 0
    ) {
      return refuse(
        `The mass of occurrence "${entry.occurrenceId}" must be a positive finite grams value.`,
        entry.massGrams,
      );
    }
    const worldCog = finiteTriple(
      entry.centerOfGravityMm,
      `The world COG of occurrence "${entry.occurrenceId}"`,
    );
    if (!worldCog.ok) return worldCog;
    const frame = initialFrames.get(entry.occurrenceId);
    if (frame === undefined) {
      return refuse(
        `The occurrence "${entry.occurrenceId}" has no resolved placement.`,
        entry.occurrenceId,
      );
    }
    const worldCogM: Vec3 = [
      worldCog.value[0] / UNIT_CONVERSION,
      worldCog.value[1] / UNIT_CONVERSION,
      worldCog.value[2] / UNIT_CONVERSION,
    ];
    // World COG → the body's local frame: R₀ᵀ·(c_world − t₀), both in m.
    const cogLocal = mulMat3Vec(
      transposeMat3(frame.r),
      sub3(worldCogM, frame.t),
    );
    let tensorLocal: Mat3 | undefined;
    if (entry.inertiaTensorKgM2 !== undefined) {
      if (
        !Array.isArray(entry.inertiaTensorKgM2) ||
        entry.inertiaTensorKgM2.length !== 9 ||
        !entry.inertiaTensorKgM2.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
      ) {
        return refuse(
          `The inertia tensor of occurrence "${entry.occurrenceId}" must be nine finite row-major kg·m² numbers.`,
          entry.inertiaTensorKgM2,
        );
      }
      const tensor = entry.inertiaTensorKgM2 as readonly number[];
      const scale = Math.max(
        Math.abs(tensor[0] ?? 0),
        Math.abs(tensor[4] ?? 0),
        Math.abs(tensor[8] ?? 0),
        1e-12,
      );
      for (const [row, col] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        if (
          Math.abs(
            (tensor[row * 3 + col] ?? 0) - (tensor[col * 3 + row] ?? 0),
          ) >
          1e-9 * scale
        ) {
          return refuse(
            `The inertia tensor of occurrence "${entry.occurrenceId}" must be symmetric.`,
            tensor,
          );
        }
      }
      // Positive semidefiniteness by Sylvester's criterion over ALL
      // principal minors (necessary AND sufficient for a symmetric
      // 3×3): the three diagonals, the three 2×2 principal minors, and
      // the determinant — non-negative diagonals alone admit indefinite
      // tensors. Each minor is guarded at the tensor's diagonal scale
      // (the symmetry tolerance's float-noise discipline).
      const d0 = tensor[0] ?? 0;
      const d1 = tensor[4] ?? 0;
      const d2 = tensor[8] ?? 0;
      const t01 = tensor[1] ?? 0;
      const t02 = tensor[2] ?? 0;
      const t12 = tensor[5] ?? 0;
      const determinant =
        d0 * (d1 * d2 - t12 * t12) -
        t01 * (t01 * d2 - t12 * t02) +
        t02 * (t01 * t12 - d1 * t02);
      const psd =
        d0 >= -1e-9 * scale &&
        d1 >= -1e-9 * scale &&
        d2 >= -1e-9 * scale &&
        d0 * d1 - t01 * t01 >= -1e-9 * scale * scale &&
        d0 * d2 - t02 * t02 >= -1e-9 * scale * scale &&
        d1 * d2 - t12 * t12 >= -1e-9 * scale * scale &&
        determinant >= -1e-9 * scale * scale * scale;
      if (!psd) {
        return refuse(
          `The inertia tensor of occurrence "${entry.occurrenceId}" must be symmetric positive semidefinite (Sylvester's principal minors) — a mass distribution's rotational inertia never carries a negative eigenvalue.`,
          tensor,
        );
      }
      tensorLocal = asMat3(tensor);
    }
    massEntries.set(entry.occurrenceId, {
      massKg: entry.massGrams / UNIT_CONVERSION,
      cogLocal,
      tensorLocal,
    });
  }
  for (const id of occurrenceIds) {
    if (!massEntries.has(id)) {
      return refuse(
        `The occurrence "${id}" carries no mass-properties entry; a mechanism body is never silently massless.`,
        id,
      );
    }
  }

  // --- Joints: the serialized DocumentJoint wire, restated in SI -------
  if (!Array.isArray(input.joints)) {
    return refuse("A mechanism build must carry its joint list.", input.joints);
  }
  const initialRates = new Map<string, readonly number[]>();
  if (input.initialJointRates !== undefined) {
    if (!Array.isArray(input.initialJointRates)) {
      return refuse(
        "The initial joint rates must be a list of { jointId, rates } entries.",
        input.initialJointRates,
      );
    }
    for (const entry of input.initialJointRates) {
      if (
        !isPlainRecord(entry) ||
        typeof entry.jointId !== "string" ||
        !Array.isArray(entry.rates)
      ) {
        return refuse(
          "Each initial joint-rate entry must carry a jointId and finite rates.",
          entry,
        );
      }
      const rates: number[] = [];
      for (const value of entry.rates) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return refuse(
            "Each initial joint-rate entry must carry a jointId and finite rates.",
            entry,
          );
        }
        rates.push(value);
      }
      initialRates.set(entry.jointId, rates);
    }
  }
  const joints: CompiledJoint[] = [];
  const jointIds = new Set<string>();
  for (const entry of input.joints) {
    const joint = compileJointWire(entry, idSet);
    if (!joint.ok) return joint;
    if (jointIds.has(joint.value.id)) {
      return refuse(
        `The joint id "${joint.value.id}" appears twice.`,
        joint.value.id,
      );
    }
    jointIds.add(joint.value.id);
    const dofCount =
      joint.value.layout.rotational.length +
      joint.value.layout.translational.length;
    const rates = initialRates.get(joint.value.id);
    if (rates !== undefined && rates.length !== dofCount) {
      return refuse(
        `The initial rates of joint "${joint.value.id}" must carry exactly ${String(dofCount)} numbers (its pinned DOF order).`,
        rates,
      );
    }
    joints.push({ ...joint.value, initialRates: rates ?? [] });
  }
  // Initial-rate addresses: a wire joint, or an ungrounded root's free
  // joint by its documented synthetic id `<occurrence>::free` (6 rates,
  // rotation then translation — the pinned order).
  for (const jointId of initialRates.keys()) {
    if (jointIds.has(jointId)) continue;
    const validFree =
      jointId.endsWith("::free") &&
      idSet.has(jointId.slice(0, -"::free".length)) &&
      !grounded.has(jointId.slice(0, -"::free".length));
    if (!validFree) {
      return refuse(
        `The initial rates address "${jointId}", which is neither a joint of the mechanism nor an ungrounded occurrence's free joint ("<id>::free").`,
        jointId,
      );
    }
    if ((initialRates.get(jointId) ?? []).length !== 6) {
      return refuse(
        `The initial rates of the free joint "${jointId}" must carry exactly 6 numbers (rotation then translation).`,
        initialRates.get(jointId),
      );
    }
  }

  // --- Motors: one per joint, on a single-rotational-DOF drive ---------
  const motors: CompiledMotorAssignment[] = [];
  if (input.motors !== undefined) {
    if (!Array.isArray(input.motors)) {
      return refuse(
        "The mechanism's motors must be a list of { jointId, motor } entries.",
        input.motors,
      );
    }
    for (const entry of input.motors) {
      if (
        !isPlainRecord(entry) ||
        typeof entry.jointId !== "string" ||
        !jointIds.has(entry.jointId)
      ) {
        return refuse(
          "Each motor entry must name a joint of the mechanism.",
          entry,
        );
      }
      const record = entry.motor;
      if (!isPlainRecord(record) || typeof record.id !== "string") {
        return refuse(
          "Each motor entry must carry the serialized motor record (with its id).",
          record,
        );
      }
      const compiled = compileSimMotor(record, record.id);
      if (!compiled.ok) return compiled;
      if (motors.some((existing) => existing.jointId === entry.jointId)) {
        return refuse(
          `Joint "${entry.jointId}" carries two motors; one drive per joint.`,
          entry.jointId,
        );
      }
      const joint = joints.find((candidate) => candidate.id === entry.jointId);
      if (joint === undefined) {
        return refuse(
          `The motor's joint "${entry.jointId}" is not part of the mechanism.`,
          entry.jointId,
        );
      }
      if (joint.kind !== "revolute" && joint.kind !== "cylindrical") {
        return refuse(
          `A motor rides a joint with exactly one rotational drive DOF (revolute or cylindrical); joint "${entry.jointId}" is ${joint.kind}.`,
          joint.kind,
        );
      }
      motors.push({ jointId: entry.jointId, motor: compiled.value });
    }
  }

  // --- Bodies: mass + local inertia, the world view derived ------------
  const zeroTensor: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const bodies: CompiledBody[] = occurrenceIds.map((id) => {
    const frame = initialFrames.get(id);
    const mass = massEntries.get(id);
    if (frame === undefined || mass === undefined) {
      throw new Error(`Unreachable: occurrence ${id} validated above.`);
    }
    const inertiaLocal = spatialInertiaAboutOrigin(
      mass.massKg,
      mass.cogLocal,
      mass.tensorLocal ?? zeroTensor,
    );
    return {
      id,
      initialR: frame.r,
      initialT: frame.t,
      inertiaLocal,
      inertiaWorld: rotateSpatialInertia(inertiaLocal, frame.r),
      grounded: grounded.has(id),
    };
  });

  return simOk({
    bodies,
    joints,
    motors,
    gravityMPerS2: gravity.value,
  });
}

/**
 * Rᵀ·R = I within 1e-6 AND det R = +1 within 1e-6 — placements arrive
 * as PROPER rotations (orthonormal columns alone would admit
 * reflections) or decline.
 */
function isOrthonormal(rotation: readonly number[]): boolean {
  const column = (index: number): Vec3 => [
    rotation[index] ?? 0,
    rotation[3 + index] ?? 0,
    rotation[6 + index] ?? 0,
  ];
  for (let a = 0; a < 3; a += 1) {
    for (let b = a; b < 3; b += 1) {
      const dot =
        column(a)[0] * column(b)[0] +
        column(a)[1] * column(b)[1] +
        column(a)[2] * column(b)[2];
      const expected = a === b ? 1 : 0;
      if (Math.abs(dot - expected) > 1e-6) return false;
    }
  }
  const c0 = column(0);
  const c1 = column(1);
  const c2 = column(2);
  const determinant =
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
    c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
    c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
  return Math.abs(determinant - 1) <= 1e-6;
}

/** Parses one serialized joint record into solver space (the mates.ts rules restated, SI). */
function compileJointWire(
  entry: unknown,
  occurrenceIds: ReadonlySet<string>,
): SimParseResult<Omit<CompiledJoint, "initialRates">, SimError> {
  if (!isPlainRecord(entry)) {
    return refuse("A joint must be a plain serialized joint record.", entry);
  }
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    return refuse("A joint must carry a non-empty id.", entry.id);
  }
  const kind = entry.kind;
  if (
    typeof kind !== "string" ||
    !DOOR_JOINT_KINDS.includes(kind as DoorJointKind)
  ) {
    return refuse(
      `A joint kind must be one of: ${DOOR_JOINT_KINDS.join(", ")}.`,
      kind,
    );
  }
  const jointKind = kind as DoorJointKind;
  if (
    typeof entry.baseOccurrenceId !== "string" ||
    !occurrenceIds.has(entry.baseOccurrenceId) ||
    typeof entry.occurrenceId !== "string" ||
    !occurrenceIds.has(entry.occurrenceId)
  ) {
    return refuse(
      "A joint's two occurrences must both be occurrences of the mechanism.",
      {
        baseOccurrenceId: entry.baseOccurrenceId,
        occurrenceId: entry.occurrenceId,
      },
    );
  }
  if (entry.baseOccurrenceId === entry.occurrenceId) {
    return refuse("A joint's two occurrences must differ.", entry.occurrenceId);
  }
  let viscousDamping = 0;
  if (entry.viscousDampingNPerMSPerRad !== undefined) {
    if (
      typeof entry.viscousDampingNPerMSPerRad !== "number" ||
      !Number.isFinite(entry.viscousDampingNPerMSPerRad) ||
      entry.viscousDampingNPerMSPerRad < 0
    ) {
      return refuse(
        "A joint's viscous damping must be a finite non-negative number when present.",
        entry.viscousDampingNPerMSPerRad,
      );
    }
    viscousDamping = entry.viscousDampingNPerMSPerRad;
  }
  let frictionLoss = 0;
  if (entry.frictionLossNPerM !== undefined) {
    if (
      typeof entry.frictionLossNPerM !== "number" ||
      !Number.isFinite(entry.frictionLossNPerM) ||
      entry.frictionLossNPerM < 0
    ) {
      return refuse(
        "A joint's friction loss must be a finite non-negative number when present.",
        entry.frictionLossNPerM,
      );
    }
    frictionLoss = entry.frictionLossNPerM;
  }
  const name =
    typeof entry.name === "string" && entry.name.length > 0
      ? entry.name
      : entry.id;
  if (kind === "rigid") {
    return simOk({
      id: entry.id,
      name,
      kind: jointKind,
      baseId: entry.baseOccurrenceId,
      movedId: entry.occurrenceId,
      origin: undefined,
      axis: undefined,
      plane: undefined,
      viscousDamping,
      frictionLoss,
      layout: jointDofLayout("rigid", [0, 0, 1], [1, 0, 0], [0, 1, 0]),
    });
  }
  const frame = entry.frame;
  if (!isPlainRecord(frame)) {
    return refuse(
      `A ${kind} joint must carry its frame (origin, and axis for axis-bearing kinds).`,
      frame,
    );
  }
  const originMm = finiteTriple(
    frame.origin,
    `The ${kind} joint "${entry.id}" frame origin`,
  );
  if (!originMm.ok) return originMm;
  const origin: Vec3 = [
    originMm.value[0] / UNIT_CONVERSION,
    originMm.value[1] / UNIT_CONVERSION,
    originMm.value[2] / UNIT_CONVERSION,
  ];
  if (kind === "ball") {
    return simOk({
      id: entry.id,
      name,
      kind: jointKind,
      baseId: entry.baseOccurrenceId,
      movedId: entry.occurrenceId,
      origin,
      axis: undefined,
      plane: undefined,
      viscousDamping,
      frictionLoss,
      layout: jointDofLayout("ball", [0, 0, 1], [1, 0, 0], [0, 1, 0]),
    });
  }
  const axisRaw = finiteTriple(
    frame.axis,
    `The ${kind} joint "${entry.id}" frame axis`,
  );
  if (!axisRaw.ok) return axisRaw;
  const length = Math.hypot(
    axisRaw.value[0],
    axisRaw.value[1],
    axisRaw.value[2],
  );
  if (length === 0) {
    return refuse(
      `The ${kind} joint "${entry.id}" axis must be non-zero.`,
      frame.axis,
    );
  }
  const axis: Vec3 = [
    axisRaw.value[0] / length,
    axisRaw.value[1] / length,
    axisRaw.value[2] / length,
  ];
  const plane = kind === "planar" ? auxiliaryBasis(axis) : undefined;
  return simOk({
    id: entry.id,
    name,
    kind: jointKind,
    baseId: entry.baseOccurrenceId,
    movedId: entry.occurrenceId,
    origin,
    axis,
    plane,
    viscousDamping,
    frictionLoss,
    layout: jointDofLayout(
      jointKind,
      axis,
      plane?.[0] ?? [1, 0, 0],
      plane?.[1] ?? [0, 1, 0],
    ),
  });
}
