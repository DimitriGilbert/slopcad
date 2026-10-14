/**
 * The sim-core view of the scenario kind vocabulary. The AUTHORITATIVE
 * record vocabulary lives in the document model
 * (`@slopcad/cad-core`'s `SIM_SCENARIO_KINDS`); sim-core depends on
 * nothing at runtime, so its compile boundary restates the same literal
 * union — the canonical serialized scenario JSON is the contract between
 * the two packages, exactly as the kernel wire contract is between
 * cad-core and cad-kernel. The union carries `combustion` (Phase 68,
 * two mode-locked stances) and `structural` (Phase 69, live: the kind
 * compiles and the structural engine serves it); every kind's solver
 * surface is its own.
 */

/** The scenario kinds the compile boundary understands (mirrors cad-core). */
export const SIM_CORE_SCENARIO_KINDS = [
  "flow",
  "thermal",
  "dynamics",
  "combustion",
  "structural",
] as const;

export type SimScenarioKind = (typeof SIM_CORE_SCENARIO_KINDS)[number];

/** Whether the input is one of the compile boundary's scenario kinds. */
export function isSimScenarioKind(input: unknown): input is SimScenarioKind {
  return (
    typeof input === "string" &&
    SIM_CORE_SCENARIO_KINDS.includes(input as SimScenarioKind)
  );
}

/** The six domain-box faces a serialized boundary condition may address. */
export const SIM_CORE_DOMAIN_FACES = [
  "xMin",
  "xMax",
  "yMin",
  "yMax",
  "zMin",
  "zMax",
] as const;

export type SimDomainFace = (typeof SIM_CORE_DOMAIN_FACES)[number];
