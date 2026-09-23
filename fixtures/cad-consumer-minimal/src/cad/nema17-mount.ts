import { length } from "@slopcad/cad-core";
import type { KernelSolid } from "@slopcad/cad-kernel";
import type {
  ComponentParameterValues,
  ResolvedComponentParameters,
} from "./component-contract";
import type { CadComponent, ComponentBuildResult } from "./cad-component";

import {
  COMPONENT_CONTRACT_VERSION,
  parameterValueOrDefault,
  type CadComponentDefinition,
  type ComponentPortInstance,
} from "./component-contract";
import {
  contractFailureAsBuildError,
  defineComponent,
  parameterConflict,
  resolveBuildParameters,
} from "./cad-component";

/** The validated, typed parameter set of the NEMA 17 mount. */
export type Nema17MountParameters = {
  /** The mount plate's side length (square). */
  readonly plateSizeMm: number;
  /** The mount plate's thickness. */
  readonly plateThicknessMm: number;
  /** The stepper's mounting-hole grid pitch (the NEMA 17 standard is 31). */
  readonly holeSpacingMm: number;
  /** The four screw clearance holes' diameter. */
  readonly screwHoleDiameterMm: number;
  /** The register bore's diameter (over the motor's pilot boss). */
  readonly boreDiameterMm: number;
  /** The raised register collar's diameter (only built when the height > 0). */
  readonly bossDiameterMm: number;
  /** The raised register collar's height (0 disables it). */
  readonly bossHeightMm: number;
};

/** Minimum plate edge distance kept around the screw holes, in mm. */
const SCREW_EDGE_DISTANCE_MM = 2;
/** Minimum wall kept around the register bore, in mm. */
const BORE_WALL_MM = 1;

/**
 * The NEMA 17 mount's serialized definition. `defineComponent` round-trips
 * it through the public contract parse, so the shipped definition provably
 * satisfies the contract it advertises.
 */
export const NEMA17_MOUNT_DEFINITION: CadComponentDefinition = defineComponent({
  contractVersion: COMPONENT_CONTRACT_VERSION,
  description:
    "Faceplate mount for a NEMA 17 frame stepper motor: a square plate with four M3 clearance holes on the motor's 31 mm mounting grid, a central register bore over the motor's pilot boss, and an optional raised register collar. Dimension sources: the NEMA 17 standard metric drawing (42.3 mm square faceplate; 31 mm × 31 mm M3 mounting-hole grid; ⌀22 mm pilot boss about the ⌀5 mm shaft — NEMA ICS 16 frame family) and ISO 273 medium-series M3 clearance (⌀3.4 mm). The bore default ⌀22.5 mm gives 0.25 mm radial clearance over the ⌀22 pilot boss. Every dimension is a parameter, so other NEMA frames (different grid pitches) and reamed fits build from the same component.",
  id: "nema17-mount",
  name: "NEMA 17 stepper mount",
  parameters: [
    {
      defaultValue: 46,
      description: "The mount plate's side length (square), in mm.",
      dimension: "length",
      max: 90,
      min: 30,
      name: "plateSizeMm",
      step: 1,
    },
    {
      defaultValue: 6,
      description: "The mount plate's thickness, in mm.",
      dimension: "length",
      max: 15,
      min: 2,
      name: "plateThicknessMm",
      step: 0.5,
    },
    {
      defaultValue: 31,
      description:
        "The stepper's mounting-hole grid pitch, in mm (NEMA 17 standard: 31).",
      dimension: "length",
      max: 80,
      min: 10,
      name: "holeSpacingMm",
      step: 0.5,
    },
    {
      defaultValue: 3.4,
      description:
        "The four screw clearance holes' diameter, in mm (ISO 273 medium M3: 3.4).",
      dimension: "length",
      max: 6,
      min: 2,
      name: "screwHoleDiameterMm",
      step: 0.1,
    },
    {
      defaultValue: 22.5,
      description:
        "The central register bore's diameter, in mm (⌀22 pilot boss + 0.25 radial clearance).",
      dimension: "length",
      max: 60,
      min: 5,
      name: "boreDiameterMm",
      step: 0.5,
    },
    {
      defaultValue: 24,
      description:
        "The raised register collar's diameter, in mm (ignored when bossHeightMm is 0).",
      dimension: "length",
      max: 70,
      min: 5,
      name: "bossDiameterMm",
      step: 0.5,
    },
    {
      defaultValue: 3.5,
      description:
        "The raised register collar's height, in mm (0 disables the collar).",
      dimension: "length",
      max: 20,
      min: 0,
      name: "bossHeightMm",
      step: 0.5,
    },
  ],
  ports: [
    {
      description:
        "The central register bore the motor's ⌀22 pilot boss registers into.",
      kind: "interface",
      name: "shaftBore",
    },
    {
      description: "The M3 mounting hole at the grid's −x/−y corner.",
      kind: "hole",
      name: "screwHole1",
    },
    {
      description: "The M3 mounting hole at the grid's +x/−y corner.",
      kind: "hole",
      name: "screwHole2",
    },
    {
      description: "The M3 mounting hole at the grid's −x/+y corner.",
      kind: "hole",
      name: "screwHole3",
    },
    {
      description: "The M3 mounting hole at the grid's +x/+y corner.",
      kind: "hole",
      name: "screwHole4",
    },
  ],
  preview: {
    bodyIds: ["body_nema17-mount"],
    viewport: { heightPx: 520, widthPx: 800 },
  },
  version: "1.0.0",
});

/**
 * The definition's default values — the standard NEMA 17 fit. The typed
 * literal IS the descriptor defaults; the contract tests pin the two in
 * lockstep (`defaultParameterValues` must equal this, name for name).
 */
export const NEMA17_MOUNT_DEFAULT_PARAMETERS: Nema17MountParameters = {
  boreDiameterMm: 22.5,
  bossDiameterMm: 24,
  bossHeightMm: 3.5,
  holeSpacingMm: 31,
  plateSizeMm: 46,
  plateThicknessMm: 6,
  screwHoleDiameterMm: 3.4,
};

/** The validated typed projection of a resolved parameter set. */
function parametersOf(
  resolved: ResolvedComponentParameters,
): Nema17MountParameters {
  return {
    boreDiameterMm: resolved.get("boreDiameterMm"),
    bossDiameterMm: resolved.get("bossDiameterMm"),
    bossHeightMm: resolved.get("bossHeightMm"),
    holeSpacingMm: resolved.get("holeSpacingMm"),
    plateSizeMm: resolved.get("plateSizeMm"),
    plateThicknessMm: resolved.get("plateThicknessMm"),
    screwHoleDiameterMm: resolved.get("screwHoleDiameterMm"),
  };
}

/**
 * The component-specific constraints the descriptors' bounds cannot
 * express, each answered with a structured `component/parameter-conflict`
 * refusal:
 *
 * 1. the screw holes keep ≥ 2 mm of plate edge all round;
 * 2. the bore keeps ≥ 1 mm of wall to the plate edges;
 * 3. a collar (height > 0) is at least the bore's diameter (it rings it);
 * 4. the collar stays clear of the screw holes' drill circles.
 */
function validateConstraints(
  p: Nema17MountParameters,
): ComponentBuildResult | null {
  const screwFit =
    p.holeSpacingMm + p.screwHoleDiameterMm + 2 * SCREW_EDGE_DISTANCE_MM;
  if (p.plateSizeMm < screwFit) {
    return {
      ok: false,
      error: parameterConflict(
        `The screw holes do not fit: a ${String(p.plateSizeMm)} mm plate carries a ${String(p.holeSpacingMm)} mm grid with ⌀${String(p.screwHoleDiameterMm)} holes only at ≥ ${String(SCREW_EDGE_DISTANCE_MM)} mm edge distance (needs ≥ ${String(screwFit)} mm).`,
        p,
      ),
    };
  }
  if (p.boreDiameterMm + 2 * BORE_WALL_MM > p.plateSizeMm) {
    return {
      ok: false,
      error: parameterConflict(
        `The register bore does not fit: ⌀${String(p.boreDiameterMm)} leaves < ${String(BORE_WALL_MM)} mm of wall in a ${String(p.plateSizeMm)} mm plate.`,
        p,
      ),
    };
  }
  if (p.bossHeightMm > 0 && p.bossDiameterMm < p.boreDiameterMm) {
    return {
      ok: false,
      error: parameterConflict(
        `The register collar (⌀${String(p.bossDiameterMm)}) must be at least the bore's diameter (⌀${String(p.boreDiameterMm)}) — it rings the bore.`,
        p,
      ),
    };
  }
  if (
    p.bossHeightMm > 0 &&
    p.bossDiameterMm + p.screwHoleDiameterMm > p.holeSpacingMm
  ) {
    return {
      ok: false,
      error: parameterConflict(
        `The register collar (⌀${String(p.bossDiameterMm)}) would reach the screw holes' drill circles (⌀${String(p.screwHoleDiameterMm)} at ${String(p.holeSpacingMm)} mm pitch) — ⌀collar + ⌀hole must stay within the pitch.`,
        p,
      ),
    };
  }
  return null;
}

/**
 * The NEMA 17 mount component: one body (`plate`), five ports (the shaft
 * bore plus the four screw holes), built through the kernel-neutral
 * execution surface alone.
 */
export const nema17Mount: CadComponent = {
  definition: NEMA17_MOUNT_DEFINITION,

  async build(kernel, values): Promise<ComponentBuildResult> {
    const resolved = resolveBuildParameters(NEMA17_MOUNT_DEFINITION, values);
    if (!resolved.ok) {
      return { ok: false, error: contractFailureAsBuildError(resolved.error) };
    }
    const p = parametersOf(resolved.value);
    const constrained = validateConstraints(p);
    if (constrained !== null) return constrained;

    const s = p.plateSizeMm;
    const t = p.plateThicknessMm;
    const totalHeightMm = t + p.bossHeightMm;

    // Dispose discipline: every intermediate solid the build mints is
    // released through the kernel that minted it — refusal paths included
    // — and only the returned body's solid survives the build (`dispose`
    // is the release path for WASM-backed kernels; disposing operands
    // after a boolean is proven safe by the kernel's own contract suite).
    const minted: KernelSolid[] = [];
    let returned: KernelSolid | undefined;
    try {
      const plate = await kernel.createBox({
        depth: length(s),
        height: length(t),
        width: length(s),
      });
      if (!plate.ok) return plate;
      minted.push(plate.value);

      let base = plate.value;
      if (p.bossHeightMm > 0) {
        const collar = await kernel.createCylinder({
          height: length(p.bossHeightMm),
          radius: length(p.bossDiameterMm / 2),
        });
        if (!collar.ok) return collar;
        minted.push(collar.value);
        const placed = await kernel.transform(collar.value, {
          x: length(s / 2),
          y: length(s / 2),
          z: length(t),
        });
        if (!placed.ok) return placed;
        minted.push(placed.value);
        const united = await kernel.union([base, placed.value]);
        if (!united.ok) return united;
        minted.push(united.value);
        base = united.value;
      }

      const bore = await kernel.createCylinder({
        height: length(totalHeightMm),
        radius: length(p.boreDiameterMm / 2),
      });
      if (!bore.ok) return bore;
      minted.push(bore.value);
      const borePlaced = await kernel.transform(bore.value, {
        x: length(s / 2),
        y: length(s / 2),
        z: length(0),
      });
      if (!borePlaced.ok) return borePlaced;
      minted.push(borePlaced.value);

      const grid = p.holeSpacingMm / 2;
      const centers: readonly [number, number][] = [
        [s / 2 - grid, s / 2 - grid],
        [s / 2 + grid, s / 2 - grid],
        [s / 2 - grid, s / 2 + grid],
        [s / 2 + grid, s / 2 + grid],
      ];
      const tools = [borePlaced.value];
      for (const [x, y] of centers) {
        const screw = await kernel.createCylinder({
          height: length(t),
          radius: length(p.screwHoleDiameterMm / 2),
        });
        if (!screw.ok) return screw;
        minted.push(screw.value);
        const screwPlaced = await kernel.transform(screw.value, {
          x: length(x),
          y: length(y),
          z: length(0),
        });
        if (!screwPlaced.ok) return screwPlaced;
        minted.push(screwPlaced.value);
        tools.push(screwPlaced.value);
      }

      const drilled = await kernel.subtract(base, tools);
      if (!drilled.ok) return drilled;
      minted.push(drilled.value);
      returned = drilled.value;

      return {
        ok: true,
        value: {
          bodies: [
            {
              bodyId: NEMA17_MOUNT_DEFINITION.preview.bodyIds[0] ?? "",
              name: "plate",
              solid: drilled.value,
            },
          ],
        },
      };
    } finally {
      for (const solid of minted) {
        if (solid === returned) {
          continue;
        }
        await kernel.dispose(solid);
      }
    }
  },

  ports(values: ComponentParameterValues): readonly ComponentPortInstance[] {
    // Metadata view, not a build path: malformed values read the descriptor
    // defaults (the build is the gate; see `parameterValueOrDefault`).
    const value = (name: string): number =>
      parameterValueOrDefault(NEMA17_MOUNT_DEFINITION, values, name);
    const s = value("plateSizeMm");
    const t = value("plateThicknessMm");
    const totalHeightMm = t + value("bossHeightMm");
    const grid = value("holeSpacingMm") / 2;
    const center = s / 2;
    const screwDiameter = value("screwHoleDiameterMm");
    const corners: readonly [number, number][] = [
      [center - grid, center - grid],
      [center + grid, center - grid],
      [center - grid, center + grid],
      [center + grid, center + grid],
    ];
    return [
      {
        axis: 3,
        diameter: value("boreDiameterMm"),
        kind: "interface",
        name: "shaftBore",
        position: [center, center, totalHeightMm / 2],
      },
      ...corners.map(([x, y], index) => ({
        axis: 3 as const,
        diameter: screwDiameter,
        kind: "hole" as const,
        name: `screwHole${String(index + 1)}`,
        position: [x, y, t / 2] as const,
      })),
    ];
  },
};
