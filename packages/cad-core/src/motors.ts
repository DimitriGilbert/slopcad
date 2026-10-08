/**
 * Document motor records (Phase 61, the 2026-10-08 owner ruling —
 * ROADMAP-SIM §7.9): an additive `motors` document section carrying
 * {@link DocumentMotorRecord} rows on the named-record discipline of
 * `DocumentMaterialRecord` — a name, a kind, and honest datasheet
 * parameters. Fan scenarios select a record (`motorId`); Phase 66 finds
 * the operating point where the motor's torque-speed line meets the fan
 * load curve; Phase 67 consumes the optional rotor inertia for the
 * transient path.
 *
 * Units are authored the way motor datasheets print them — torque in
 * mN·m, speed in rpm — and converted to SI (N·m, rad/s) ONLY at the sim
 * S4 boundary (`@slopcad/sim-core`'s units module), never here: this
 * record is storage, not physics. The analytic kinds (DC brushed, BLDC)
 * store the complete linear motor trio — stall torque, no-load speed,
 * nominal voltage — which fully defines the straight torque-speed line.
 * The Kv/Kt mental model authors may prefer is a DERIVED view of that
 * trio (documented in the sim-core units module: Kv = no-load speed /
 * nominal voltage, and Kt from the ideal-motor identity Kt·ω0/V), so one
 * storage shape serves both authoring styles without a redundant
 * parameterization. The tabulated kind stores a measured torque-vs-speed
 * point list (speeds strictly increasing) for motors whose line is not
 * straight.
 *
 * Parsing validates untrusted input strictly with stable `motor/*`
 * failure codes; serialization is canonical (fixed key order, declaration
 * order preserved).
 */

import { type MotorId, parseMotorId } from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** The motor record kinds. */
export const DOCUMENT_MOTOR_KINDS = [
  "dc-brushed",
  "bldc",
  "tabulated",
] as const;

export type DocumentMotorKind = (typeof DOCUMENT_MOTOR_KINDS)[number];

/** One measured torque-speed point: speed in rpm, torque in mN·m. */
export interface MotorTorqueSpeedPoint {
  readonly speedRpm: number;
  readonly torqueMNm: number;
}

/** The analytic motor parameters (DC brushed and BLDC share the trio). */
export interface DocumentMotorAnalyticParameters {
  /** The stall (locked-rotor) torque, mN·m (strictly positive). */
  readonly stallTorqueMNm: number;
  /** The no-load speed, rpm (strictly positive). */
  readonly noLoadSpeedRpm: number;
  /** The nominal voltage, V (strictly positive). */
  readonly nominalVoltageV: number;
}

/**
 * A document-level motor record: the analytic kinds carry the linear
 * torque-speed trio, the tabulated kind a measured point list; every kind
 * may carry an optional rotor inertia (kg·m² — the one SI-authored field,
 * because datasheets print inertia in mixed units and kg·m² is the
 * Phase 67 dynamics unit) for the transient path.
 */
export type DocumentMotorRecord =
  | (DocumentMotorAnalyticParameters & {
      readonly id: MotorId;
      readonly name: string;
      readonly kind: "dc-brushed";
      readonly rotorInertiaKgM2?: number;
    })
  | (DocumentMotorAnalyticParameters & {
      readonly id: MotorId;
      readonly name: string;
      readonly kind: "bldc";
      readonly rotorInertiaKgM2?: number;
    })
  | {
      readonly id: MotorId;
      readonly name: string;
      readonly kind: "tabulated";
      readonly points: readonly MotorTorqueSpeedPoint[];
      readonly rotorInertiaKgM2?: number;
    };

/** The mutable fields of a motor record — everything but its identity. */
export type DocumentMotorBody = DistributiveOmit<DocumentMotorRecord, "id">;

/** `Omit` that distributes over a union (per-kind bodies stay discriminated). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Input accepted by the document-level {@link addDocumentMotor}. */
export interface DocumentMotorInput {
  readonly id?: MotorId;
  readonly name: string;
  readonly kind: DocumentMotorKind;
  readonly stallTorqueMNm?: number;
  readonly noLoadSpeedRpm?: number;
  readonly nominalVoltageV?: number;
  readonly points?: readonly MotorTorqueSpeedPoint[];
  readonly rotorInertiaKgM2?: number;
}

/** Stable failure codes produced when motor input is rejected. */
export const MOTOR_ERROR_CODES = {
  malformed: "motor/malformed",
  idInvalid: "motor/id-invalid",
  nameInvalid: "motor/name-invalid",
  kindInvalid: "motor/kind-invalid",
  parametersInvalid: "motor/parameters-invalid",
  pointsInvalid: "motor/points-invalid",
  inertiaInvalid: "motor/inertia-invalid",
} as const;

export type MotorErrorCode =
  (typeof MOTOR_ERROR_CODES)[keyof typeof MOTOR_ERROR_CODES];

/** Structured failure describing why motor input was rejected. */
export interface MotorError extends ParseFailure {
  readonly code: MotorErrorCode;
}

function motorError(
  code: MotorErrorCode,
  message: string,
  input: unknown,
): MotorError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Whether the input is one of the declared motor kinds. */
export function isDocumentMotorKind(
  input: unknown,
): input is DocumentMotorKind {
  return (
    typeof input === "string" &&
    DOCUMENT_MOTOR_KINDS.includes(input as DocumentMotorKind)
  );
}

/** The motor naming rule: 1-64 characters after trimming (the configuration rule). */
export function isValidMotorName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

function parsePositiveNumber(
  input: unknown,
  code: MotorErrorCode,
  what: string,
): ParseResult<number, MotorError> {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return fail(
      motorError(code, `${what} must be a positive finite number.`, input),
    );
  }
  return ok(input);
}

/**
 * Validates and freezes a motor record's authored fields (typed or
 * untrusted) — the build boundary the document add path and the native
 * parse boundary share. The analytic kinds must carry the complete trio;
 * the tabulated kind must carry at least two points with strictly
 * increasing speeds.
 */
export function buildDocumentMotorBody(
  name: unknown,
  kind: unknown,
  stallTorqueMNm: unknown,
  noLoadSpeedRpm: unknown,
  nominalVoltageV: unknown,
  points: unknown,
  rotorInertiaKgM2: unknown,
): ParseResult<DocumentMotorBody, MotorError> {
  if (typeof name !== "string" || !isValidMotorName(name)) {
    return fail(
      motorError(
        MOTOR_ERROR_CODES.nameInvalid,
        "A motor name must be 1-64 characters (trimmed).",
        name,
      ),
    );
  }
  if (!isDocumentMotorKind(kind)) {
    return fail(
      motorError(
        MOTOR_ERROR_CODES.kindInvalid,
        `A motor kind must be one of: ${DOCUMENT_MOTOR_KINDS.join(", ")}.`,
        kind,
      ),
    );
  }
  let inertia: number | undefined;
  if (rotorInertiaKgM2 !== undefined && rotorInertiaKgM2 !== null) {
    const parsed = parsePositiveNumber(
      rotorInertiaKgM2,
      MOTOR_ERROR_CODES.inertiaInvalid,
      "A motor's rotor inertia",
    );
    if (!parsed.ok) return parsed;
    inertia = parsed.value;
  }
  if (kind === "tabulated") {
    if (!Array.isArray(points) || points.length < 2) {
      return fail(
        motorError(
          MOTOR_ERROR_CODES.pointsInvalid,
          "A tabulated motor must carry at least two torque-speed points.",
          points,
        ),
      );
    }
    const parsedPoints: MotorTorqueSpeedPoint[] = [];
    for (const entry of points) {
      if (!isPlainRecord(entry)) {
        return fail(
          motorError(
            MOTOR_ERROR_CODES.pointsInvalid,
            "A torque-speed point must be an object with speedRpm and torqueMNm fields.",
            entry,
          ),
        );
      }
      const speedRpm = entry.speedRpm;
      if (
        typeof speedRpm !== "number" ||
        !Number.isFinite(speedRpm) ||
        speedRpm < 0
      ) {
        return fail(
          motorError(
            MOTOR_ERROR_CODES.pointsInvalid,
            "A torque-speed point's speed must be a non-negative finite number of rpm (0 is the stall point).",
            entry.speedRpm,
          ),
        );
      }
      if (
        typeof entry.torqueMNm !== "number" ||
        !Number.isFinite(entry.torqueMNm)
      ) {
        return fail(
          motorError(
            MOTOR_ERROR_CODES.pointsInvalid,
            "A torque-speed point's torque must be a finite number.",
            entry.torqueMNm,
          ),
        );
      }
      const previous = parsedPoints[parsedPoints.length - 1];
      if (previous !== undefined && speedRpm <= previous.speedRpm) {
        return fail(
          motorError(
            MOTOR_ERROR_CODES.pointsInvalid,
            "A tabulated motor's points must carry strictly increasing speeds (author-side sort; the record is stored as declared).",
            entry,
          ),
        );
      }
      parsedPoints.push(
        Object.freeze({
          speedRpm,
          torqueMNm: entry.torqueMNm,
        }),
      );
    }
    return ok(
      Object.freeze({
        name: name.trim(),
        kind,
        points: Object.freeze(parsedPoints),
        ...(inertia === undefined ? {} : { rotorInertiaKgM2: inertia }),
      }),
    );
  }
  const stallTorque = parsePositiveNumber(
    stallTorqueMNm,
    MOTOR_ERROR_CODES.parametersInvalid,
    `A ${kind} motor's stall torque`,
  );
  if (!stallTorque.ok) return stallTorque;
  const noLoadSpeed = parsePositiveNumber(
    noLoadSpeedRpm,
    MOTOR_ERROR_CODES.parametersInvalid,
    `A ${kind} motor's no-load speed`,
  );
  if (!noLoadSpeed.ok) return noLoadSpeed;
  const nominalVoltage = parsePositiveNumber(
    nominalVoltageV,
    MOTOR_ERROR_CODES.parametersInvalid,
    `A ${kind} motor's nominal voltage`,
  );
  if (!nominalVoltage.ok) return nominalVoltage;
  return ok(
    Object.freeze({
      name: name.trim(),
      kind,
      stallTorqueMNm: stallTorque.value,
      noLoadSpeedRpm: noLoadSpeed.value,
      nominalVoltageV: nominalVoltage.value,
      ...(inertia === undefined ? {} : { rotorInertiaKgM2: inertia }),
    }),
  );
}

/** Canonical JSON form of a motor record's authored fields; fixed key order. */
export type SerializedDocumentMotorBody =
  | {
      readonly name: string;
      readonly kind: "dc-brushed";
      readonly stallTorqueMNm: number;
      readonly noLoadSpeedRpm: number;
      readonly nominalVoltageV: number;
      readonly rotorInertiaKgM2?: number;
    }
  | {
      readonly name: string;
      readonly kind: "bldc";
      readonly stallTorqueMNm: number;
      readonly noLoadSpeedRpm: number;
      readonly nominalVoltageV: number;
      readonly rotorInertiaKgM2?: number;
    }
  | {
      readonly name: string;
      readonly kind: "tabulated";
      readonly points: readonly {
        readonly speedRpm: number;
        readonly torqueMNm: number;
      }[];
      readonly rotorInertiaKgM2?: number;
    };

/** Serializes a motor record's authored fields; the identity rides separately. */
export function serializeDocumentMotorBody(
  motor: DocumentMotorBody,
): SerializedDocumentMotorBody {
  return motor.kind === "tabulated"
    ? {
        name: motor.name,
        kind: "tabulated",
        points: motor.points.map((point) => ({
          speedRpm: point.speedRpm,
          torqueMNm: point.torqueMNm,
        })),
        ...(motor.rotorInertiaKgM2 === undefined
          ? {}
          : { rotorInertiaKgM2: motor.rotorInertiaKgM2 }),
      }
    : {
        name: motor.name,
        kind: motor.kind,
        stallTorqueMNm: motor.stallTorqueMNm,
        noLoadSpeedRpm: motor.noLoadSpeedRpm,
        nominalVoltageV: motor.nominalVoltageV,
        ...(motor.rotorInertiaKgM2 === undefined
          ? {}
          : { rotorInertiaKgM2: motor.rotorInertiaKgM2 }),
      };
}

/**
 * Parses untrusted input as a motor record's authored fields. Ids are
 * validated for wire shape; whether the name is unique is the document
 * layer's cross-check.
 */
export function parseDocumentMotorBody(
  input: unknown,
): ParseResult<DocumentMotorBody, MotorError> {
  if (!isPlainRecord(input)) {
    return fail(
      motorError(
        MOTOR_ERROR_CODES.malformed,
        "A serialized motor must be a plain object with name and kind fields.",
        input,
      ),
    );
  }
  return buildDocumentMotorBody(
    input.name,
    input.kind,
    input.stallTorqueMNm,
    input.noLoadSpeedRpm,
    input.nominalVoltageV,
    input.points,
    input.rotorInertiaKgM2,
  );
}

/** Canonical JSON form of a motor record; fixed key order, additive discipline. */
export type SerializedDocumentMotor = SerializedDocumentMotorBody & {
  readonly id: string;
};

/** Serializes a motor record to its canonical, deterministic JSON form. */
export function serializeDocumentMotor(
  motor: DocumentMotorRecord,
): SerializedDocumentMotor {
  return { id: motor.id, ...serializeDocumentMotorBody(motor) };
}

/** Parses untrusted input as a {@link DocumentMotorRecord}. */
export function parseDocumentMotor(
  input: unknown,
): ParseResult<DocumentMotorRecord, MotorError> {
  if (!isPlainRecord(input)) {
    return fail(
      motorError(
        MOTOR_ERROR_CODES.malformed,
        "A serialized motor must be a plain object with an id field.",
        input,
      ),
    );
  }
  const parsedId = parseMotorId(input.id);
  if (!parsedId.ok) {
    return fail(
      motorError(
        MOTOR_ERROR_CODES.idInvalid,
        `A motor id must be a valid motor id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const body = parseDocumentMotorBody(input);
  if (!body.ok) return body;
  return ok(Object.freeze({ id: parsedId.value, ...body.value }));
}

/** Returns the motor record with the given id, or undefined. */
export function getDocumentMotor(
  motors: readonly DocumentMotorRecord[],
  id: MotorId,
): DocumentMotorRecord | undefined {
  return motors.find((motor) => motor.id === id);
}
