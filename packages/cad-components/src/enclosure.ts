/**
 * The parameterized electronics enclosure (Phase 32.4): an open-top
 * rounded shell plus a plug lid with four self-tapping screw bosses,
 * built exclusively through the public cad-components surfaces.
 *
 * ## Fits (the honesty of the numbers)
 *
 * - **Wall / floor** — the cavity undercuts the outer footprint by the
 *   wall thickness on every side and rides on the floor thickness; the
 *   rim is the outer height. Defaults 2.4 mm: a stiff, printable wall.
 * - **Corner fillets** — the footprint's corners are TRUE rounded
 *   corners, built as arcs in the extruded profile (the public profile
 *   extrusion), so they are kernel-neutral by construction. Top-edge
 *   fillets are deliberately not attempted: the shipped kernels declare
 *   `fillet: false` (probed, see cad-kernel's capability docs).
 * - **Lid fit** — the lid is a PLUG: it undercuts the cavity by the total
 *   sliding clearance `lidFitClearanceMm` on the diameter (0.2 mm/side
 *   pair by default), with its corner radius the cavity's minus the same
 *   undercut, so a printed lid seats without reaming.
 * - **Bosses** — four ⌀6 bosses under the lid at `bossInsetMm` from the
 *   inner walls, each with a ⌀2.8 mm pilot through boss and lid: the
 *   conventional M3 self-tapping pilot for thermoplastic 3D prints
 *   (⌀2.7–2.9 mm; the parameter carries the fit).
 *
 * ## Geometry (z-up, component-local canonical millimetres)
 *
 * The shell extrudes from [0,0,0] to [outerW, outerD, outerH]; the cavity
 * cut starts at the floor top and overshoots 1 mm past the rim, so the
 * boolean never leans on a coplanar face. The lid builds at its own
 * origin ([0,0,0] → [lidW, lidD, lidT]); a consumer seats it at
 * z = outerHeight — the preview scene does exactly that, and the port
 * positions are quoted in the SEATED assembly frame. The lid unions its
 * bosses first and drills the pilots afterwards.
 */

import { angle, length } from "@slopcad/cad-core";
import type { KernelSolid, ProfileSegmentInput } from "@slopcad/cad-kernel";
import type { ParseResult } from "@slopcad/cad-core";
import type {
  ComponentParameterValues,
  ResolvedComponentParameters,
} from "./component-contract";
import type {
  CadComponent,
  ComponentBuildError,
  ComponentBuildResult,
} from "./cad-component";
import type { ComponentKernel } from "./component-kernel";

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

/** The validated, typed parameter set of the enclosure. */
export type EnclosureParameters = {
  /** The cavity's inner width (x). */
  readonly innerWidthMm: number;
  /** The cavity's inner depth (y). */
  readonly innerDepthMm: number;
  /** The cavity's inner height (the clear height under the rim). */
  readonly innerHeightMm: number;
  /** The wall thickness on every side. */
  readonly wallThicknessMm: number;
  /** The floor thickness under the cavity. */
  readonly floorThicknessMm: number;
  /** The outer footprint's corner radius (0 = sharp). */
  readonly cornerRadiusMm: number;
  /** The lid's thickness. */
  readonly lidThicknessMm: number;
  /** The lid's total undercut against the cavity wall (the sliding fit). */
  readonly lidFitClearanceMm: number;
  /** The screw boss diameter under the lid. */
  readonly bossDiameterMm: number;
  /** The self-tapping pilot diameter through boss and lid. */
  readonly bossPilotDiameterMm: number;
  /** The screw boss height (reaching down from the lid's underside). */
  readonly bossHeightMm: number;
  /** The boss centers' inset from the inner walls. */
  readonly bossInsetMm: number;
};

/** The cavity cut's overshoot past the rim, in mm (boolean hygiene). */
const CAVITY_OVERSHOOT_MM = 1;

/**
 * The enclosure's serialized definition, carrying the fit provenance
 * verbatim in its description.
 */
export const ENCLOSURE_DEFINITION: CadComponentDefinition = defineComponent({
  contractVersion: COMPONENT_CONTRACT_VERSION,
  description:
    "Open-top electronics enclosure with a plug lid: a rounded rectangular shell (uniform wall and floor, true rounded-corner fillets built into the extruded footprint) plus a lid that undercuts the cavity by the sliding-fit clearance, carrying four self-tapping screw bosses. Fit sources: the 2.4 mm default wall/floor is a stiff printable wall; the lid undercut default (0.2 mm on the diameter) is the conventional snug slide fit for FDM prints; the ⌀2.8 mm boss pilot default is the conventional M3 self-tapping pilot for thermoplastic 3D prints (typical ⌀2.7–2.9 mm). Corner fillets ride the profile extrusion (kernel-neutral); top-edge fillets are not attempted because the shipped kernels declare fillet: false.",
  id: "electronics-enclosure",
  name: "Electronics enclosure with plug lid",
  parameters: [
    {
      defaultValue: 60,
      description: "The cavity's inner width (x), in mm.",
      dimension: "length",
      max: 300,
      min: 20,
      name: "innerWidthMm",
      step: 1,
    },
    {
      defaultValue: 40,
      description: "The cavity's inner depth (y), in mm.",
      dimension: "length",
      max: 300,
      min: 20,
      name: "innerDepthMm",
      step: 1,
    },
    {
      defaultValue: 25,
      description: "The cavity's clear inner height, in mm.",
      dimension: "length",
      max: 200,
      min: 10,
      name: "innerHeightMm",
      step: 1,
    },
    {
      defaultValue: 2.4,
      description: "The wall thickness on every side, in mm.",
      dimension: "length",
      max: 6,
      min: 1,
      name: "wallThicknessMm",
      step: 0.2,
    },
    {
      defaultValue: 2.4,
      description: "The floor thickness under the cavity, in mm.",
      dimension: "length",
      max: 8,
      min: 1,
      name: "floorThicknessMm",
      step: 0.2,
    },
    {
      defaultValue: 3,
      description:
        "The outer footprint's corner radius, in mm (0 builds sharp corners).",
      dimension: "length",
      max: 20,
      min: 0,
      name: "cornerRadiusMm",
      step: 0.5,
    },
    {
      defaultValue: 2.4,
      description: "The lid's thickness, in mm.",
      dimension: "length",
      max: 6,
      min: 1,
      name: "lidThicknessMm",
      step: 0.2,
    },
    {
      defaultValue: 0.2,
      description:
        "The lid's total undercut against the cavity wall (the sliding fit), in mm on the diameter.",
      dimension: "length",
      max: 1,
      min: 0,
      name: "lidFitClearanceMm",
      step: 0.05,
    },
    {
      defaultValue: 6,
      description: "The screw boss diameter under the lid, in mm.",
      dimension: "length",
      max: 12,
      min: 3,
      name: "bossDiameterMm",
      step: 0.5,
    },
    {
      defaultValue: 2.8,
      description:
        "The self-tapping pilot diameter through boss and lid, in mm (M3 self-tapping in thermoplastic: ⌀2.7–2.9).",
      dimension: "length",
      max: 5,
      min: 1,
      name: "bossPilotDiameterMm",
      step: 0.1,
    },
    {
      defaultValue: 6,
      description:
        "The screw boss height reaching down from the lid's underside, in mm (must stay within the cavity).",
      dimension: "length",
      max: 40,
      min: 2,
      name: "bossHeightMm",
      step: 0.5,
    },
    {
      defaultValue: 5,
      description:
        "The boss centers' inset from the inner cavity walls, in mm.",
      dimension: "length",
      max: 30,
      min: 2,
      name: "bossInsetMm",
      step: 0.5,
    },
  ],
  ports: [
    {
      description:
        "The boss pilot at the cavity's −x/−y corner (seated-assembly frame).",
      kind: "hole",
      name: "bossPilot1",
    },
    {
      description:
        "The boss pilot at the cavity's +x/−y corner (seated-assembly frame).",
      kind: "hole",
      name: "bossPilot2",
    },
    {
      description:
        "The boss pilot at the cavity's −x/+y corner (seated-assembly frame).",
      kind: "hole",
      name: "bossPilot3",
    },
    {
      description:
        "The boss pilot at the cavity's +x/+y corner (seated-assembly frame).",
      kind: "hole",
      name: "bossPilot4",
    },
    {
      description:
        "The cavity's opening (the rim's center in the seated-assembly frame) — the component's interface face.",
      kind: "interface",
      name: "cavityOpening",
    },
  ],
  preview: {
    bodyIds: ["body_enclosure-shell", "body_enclosure-lid"],
    viewport: { heightPx: 520, widthPx: 800 },
  },
  version: "1.0.0",
});

/**
 * The definition's default values. The typed literal IS the descriptor
 * defaults; the contract tests pin the two in lockstep.
 */
export const ENCLOSURE_DEFAULT_PARAMETERS: EnclosureParameters = {
  bossDiameterMm: 6,
  bossHeightMm: 6,
  bossInsetMm: 5,
  bossPilotDiameterMm: 2.8,
  cornerRadiusMm: 3,
  floorThicknessMm: 2.4,
  innerDepthMm: 40,
  innerHeightMm: 25,
  innerWidthMm: 60,
  lidFitClearanceMm: 0.2,
  lidThicknessMm: 2.4,
  wallThicknessMm: 2.4,
};

/** Derived footprint numbers one build works from. */
export interface EnclosureDerived {
  readonly outerWidthMm: number;
  readonly outerDepthMm: number;
  readonly outerHeightMm: number;
  readonly outerRadiusMm: number;
  readonly innerRadiusMm: number;
  readonly lidWidthMm: number;
  readonly lidDepthMm: number;
  readonly lidRadiusMm: number;
}

/** The footprint numbers `parameters` derive (pure arithmetic, shared). */
export function deriveEnclosure(p: EnclosureParameters): EnclosureDerived {
  const outerWidthMm = p.innerWidthMm + 2 * p.wallThicknessMm;
  const outerDepthMm = p.innerDepthMm + 2 * p.wallThicknessMm;
  return {
    innerRadiusMm: Math.max(p.cornerRadiusMm - p.wallThicknessMm, 0),
    lidDepthMm: p.innerDepthMm - p.lidFitClearanceMm,
    lidRadiusMm: Math.max(
      p.cornerRadiusMm - p.wallThicknessMm - p.lidFitClearanceMm / 2,
      0,
    ),
    lidWidthMm: p.innerWidthMm - p.lidFitClearanceMm,
    outerDepthMm,
    outerHeightMm: p.floorThicknessMm + p.innerHeightMm,
    outerRadiusMm: p.cornerRadiusMm,
    outerWidthMm,
  };
}

/**
 * A closed rounded-rectangle profile loop spanning [0, w] × [0, d] with
 * corner radius r (r = 0 builds four lines). Counter-clockwise, arcs
 * sweeping the CCW quarter turns the profile contract defines.
 */
export function roundedRectLoop(
  w: number,
  d: number,
  r: number,
): readonly ProfileSegmentInput[] {
  if (r <= 0) {
    return [
      { end: [w, 0], kind: "line", start: [0, 0] },
      { end: [w, d], kind: "line", start: [w, 0] },
      { end: [0, d], kind: "line", start: [w, d] },
      { end: [0, 0], kind: "line", start: [0, d] },
    ];
  }
  const halfPi = Math.PI / 2;
  return [
    { end: [w - r, 0], kind: "line", start: [r, 0] },
    {
      center: [w - r, r],
      endAngle: angle(0, "rad"),
      kind: "arc",
      radius: r,
      startAngle: angle(-halfPi, "rad"),
    },
    { end: [w, d - r], kind: "line", start: [w, r] },
    {
      center: [w - r, d - r],
      endAngle: angle(halfPi, "rad"),
      kind: "arc",
      radius: r,
      startAngle: angle(0, "rad"),
    },
    { end: [r, d], kind: "line", start: [w - r, d] },
    {
      center: [r, d - r],
      endAngle: angle(Math.PI, "rad"),
      kind: "arc",
      radius: r,
      startAngle: angle(halfPi, "rad"),
    },
    { end: [0, r], kind: "line", start: [0, d - r] },
    {
      center: [r, r],
      endAngle: angle(3 * halfPi, "rad"),
      kind: "arc",
      radius: r,
      startAngle: angle(Math.PI, "rad"),
    },
  ];
}

/** Extrudes a rounded-rect footprint upward from the placement's origin. */
async function extrudeFootprint(
  kernel: ComponentKernel,
  w: number,
  d: number,
  r: number,
  heightMm: number,
  translate: { readonly x: number; readonly y: number; readonly z: number },
): Promise<ParseResult<KernelSolid, ComponentBuildError>> {
  const extruded = await kernel.extrude({
    direction: 1,
    height: length(heightMm),
    loop: roundedRectLoop(w, d, r),
    placement: {
      rotation: { axis: [0, 0, 1], angle: angle(0, "rad") },
      translation: {
        x: length(translate.x),
        y: length(translate.y),
        z: length(translate.z),
      },
    },
  });
  if (!extruded.ok) {
    return { ok: false, error: extruded.error };
  }
  return extruded;
}

function parametersOf(
  resolved: ResolvedComponentParameters,
): EnclosureParameters {
  return {
    bossDiameterMm: resolved.get("bossDiameterMm"),
    bossHeightMm: resolved.get("bossHeightMm"),
    bossInsetMm: resolved.get("bossInsetMm"),
    bossPilotDiameterMm: resolved.get("bossPilotDiameterMm"),
    cornerRadiusMm: resolved.get("cornerRadiusMm"),
    floorThicknessMm: resolved.get("floorThicknessMm"),
    innerDepthMm: resolved.get("innerDepthMm"),
    innerHeightMm: resolved.get("innerHeightMm"),
    innerWidthMm: resolved.get("innerWidthMm"),
    lidFitClearanceMm: resolved.get("lidFitClearanceMm"),
    lidThicknessMm: resolved.get("lidThicknessMm"),
    wallThicknessMm: resolved.get("wallThicknessMm"),
  };
}

/**
 * The component-specific constraints (structured
 * `component/parameter-conflict`): the corners fit the footprint, the
 * bosses stay clear of the walls and of each other, the bosses stop above
 * the floor, and the pilot leaves boss wall.
 */
function validateConstraints(
  p: EnclosureParameters,
): ComponentBuildResult | null {
  const outerWidthMm = p.innerWidthMm + 2 * p.wallThicknessMm;
  const outerDepthMm = p.innerDepthMm + 2 * p.wallThicknessMm;
  const maxRadius = Math.min(outerWidthMm, outerDepthMm) / 2;
  if (p.cornerRadiusMm > maxRadius) {
    return {
      ok: false,
      error: parameterConflict(
        `The corner radius (${String(p.cornerRadiusMm)} mm) exceeds half the smaller outer side (${String(maxRadius)} mm).`,
        p,
      ),
    };
  }
  const bossRadius = p.bossDiameterMm / 2;
  if (p.bossInsetMm < bossRadius) {
    return {
      ok: false,
      error: parameterConflict(
        `The boss centers sit ${String(p.bossInsetMm)} mm from the inner walls, so a ⌀${String(p.bossDiameterMm)} boss crosses the wall (inset must be ≥ the boss radius).`,
        p,
      ),
    };
  }
  const spreadX = p.innerWidthMm - 2 * p.bossInsetMm;
  const spreadY = p.innerDepthMm - 2 * p.bossInsetMm;
  if (spreadX < p.bossDiameterMm || spreadY < p.bossDiameterMm) {
    return {
      ok: false,
      error: parameterConflict(
        `The corner bosses overlap: their centers spread ${String(spreadX)} × ${String(spreadY)} mm, less than one boss diameter (⌀${String(p.bossDiameterMm)}).`,
        p,
      ),
    };
  }
  if (p.bossHeightMm > p.innerHeightMm) {
    return {
      ok: false,
      error: parameterConflict(
        `The bosses (${String(p.bossHeightMm)} mm) reach below the rim: they must stay within the cavity's clear height (${String(p.innerHeightMm)} mm).`,
        p,
      ),
    };
  }
  if (p.bossPilotDiameterMm >= p.bossDiameterMm) {
    return {
      ok: false,
      error: parameterConflict(
        `The pilot (⌀${String(p.bossPilotDiameterMm)}) leaves no boss wall — it must stay below the boss diameter (⌀${String(p.bossDiameterMm)}).`,
        p,
      ),
    };
  }
  return null;
}

/** The lid's seated z (the consumer's assembly datum): the shell's rim. */
export function seatedLidZMm(p: EnclosureParameters): number {
  return p.floorThicknessMm + p.innerHeightMm;
}

/**
 * The plug lid's seated placement (dx, dy, dz) in the shell's frame at
 * `values` — the consumer's assembly datum, expressed from the public
 * parameter mechanism: centered in the cavity (wall + half the fit
 * clearance on x and y), riding the rim (the seated z).
 */
export function seatedLidOffsetMm(
  values: ComponentParameterValues,
): readonly [number, number, number] {
  const p = enclosureParametersOf(values);
  const centering = p.wallThicknessMm + p.lidFitClearanceMm / 2;
  return [centering, centering, seatedLidZMm(p)];
}

/** The metadata-view typed parameter set (malformed values read defaults). */
function enclosureParametersOf(
  values: ComponentParameterValues,
): EnclosureParameters {
  const value = (name: string): number =>
    parameterValueOrDefault(ENCLOSURE_DEFINITION, values, name);
  return {
    bossDiameterMm: value("bossDiameterMm"),
    bossHeightMm: value("bossHeightMm"),
    bossInsetMm: value("bossInsetMm"),
    bossPilotDiameterMm: value("bossPilotDiameterMm"),
    cornerRadiusMm: value("cornerRadiusMm"),
    floorThicknessMm: value("floorThicknessMm"),
    innerDepthMm: value("innerDepthMm"),
    innerHeightMm: value("innerHeightMm"),
    innerWidthMm: value("innerWidthMm"),
    lidFitClearanceMm: value("lidFitClearanceMm"),
    lidThicknessMm: value("lidThicknessMm"),
    wallThicknessMm: value("wallThicknessMm"),
  };
}

/** The boss centers in lid-local coordinates (the seated lid's frame). */
export function lidBossCentersMm(
  p: EnclosureParameters,
): readonly (readonly [number, number])[] {
  const derived = deriveEnclosure(p);
  const inset = p.lidFitClearanceMm / 2 + p.bossInsetMm;
  const w = derived.lidWidthMm;
  const d = derived.lidDepthMm;
  return [
    [inset, inset],
    [w - inset, inset],
    [inset, d - inset],
    [w - inset, d - inset],
  ];
}

/** The electronics enclosure component: two bodies (shell, lid), five ports. */
export const enclosure: CadComponent = {
  definition: ENCLOSURE_DEFINITION,

  async build(kernel, values): Promise<ComponentBuildResult> {
    const resolved = resolveBuildParameters(ENCLOSURE_DEFINITION, values);
    if (!resolved.ok) {
      return { ok: false, error: contractFailureAsBuildError(resolved.error) };
    }
    const p = parametersOf(resolved.value);
    const constrained = validateConstraints(p);
    if (constrained !== null) return constrained;
    const derived = deriveEnclosure(p);

    const shellBlock = await extrudeFootprint(
      kernel,
      derived.outerWidthMm,
      derived.outerDepthMm,
      derived.outerRadiusMm,
      derived.outerHeightMm,
      { x: 0, y: 0, z: 0 },
    );
    if (!shellBlock.ok) return shellBlock;

    const cavity = await extrudeFootprint(
      kernel,
      p.innerWidthMm,
      p.innerDepthMm,
      derived.innerRadiusMm,
      p.innerHeightMm + CAVITY_OVERSHOOT_MM,
      { x: p.wallThicknessMm, y: p.wallThicknessMm, z: p.floorThicknessMm },
    );
    if (!cavity.ok) return cavity;

    const hollowed = await kernel.subtract(shellBlock.value, [cavity.value]);
    if (!hollowed.ok) return hollowed;

    const lidBlock = await extrudeFootprint(
      kernel,
      derived.lidWidthMm,
      derived.lidDepthMm,
      derived.lidRadiusMm,
      p.lidThicknessMm,
      { x: 0, y: 0, z: 0 },
    );
    if (!lidBlock.ok) return lidBlock;

    const bossCenters = lidBossCentersMm(p);
    const bosses: KernelSolid[] = [];
    for (const [x, y] of bossCenters) {
      const boss = await kernel.createCylinder({
        height: length(p.bossHeightMm),
        radius: length(p.bossDiameterMm / 2),
      });
      if (!boss.ok) return boss;
      const placed = await kernel.transform(boss.value, {
        x: length(x),
        y: length(y),
        z: length(-p.bossHeightMm),
      });
      if (!placed.ok) return placed;
      bosses.push(placed.value);
    }
    const lidWithBosses = await kernel.union([lidBlock.value, ...bosses]);
    if (!lidWithBosses.ok) return lidWithBosses;

    const pilots: KernelSolid[] = [];
    const pilotHeightMm = p.lidThicknessMm + p.bossHeightMm;
    for (const [x, y] of bossCenters) {
      const pilot = await kernel.createCylinder({
        height: length(pilotHeightMm),
        radius: length(p.bossPilotDiameterMm / 2),
      });
      if (!pilot.ok) return pilot;
      const placed = await kernel.transform(pilot.value, {
        x: length(x),
        y: length(y),
        z: length(-p.bossHeightMm),
      });
      if (!placed.ok) return placed;
      pilots.push(placed.value);
    }
    const lid = await kernel.subtract(lidWithBosses.value, pilots);
    if (!lid.ok) return lid;

    const bodyIds = ENCLOSURE_DEFINITION.preview.bodyIds;
    return {
      ok: true,
      value: {
        bodies: [
          { bodyId: bodyIds[0] ?? "", name: "shell", solid: hollowed.value },
          { bodyId: bodyIds[1] ?? "", name: "lid", solid: lid.value },
        ],
      },
    };
  },

  ports(values: ComponentParameterValues): readonly ComponentPortInstance[] {
    // Metadata view, not a build path: malformed values read the defaults.
    const p = enclosureParametersOf(values);
    const seatedZ = seatedLidZMm(p);
    const pilotMidZ = seatedZ + (p.lidThicknessMm - p.bossHeightMm) / 2;
    const lidOffset = p.lidFitClearanceMm / 2 + p.wallThicknessMm;
    const pilotDiameter = p.bossPilotDiameterMm;
    const corners = lidBossCentersMm(p);
    return [
      ...corners.map(([x, y], index) => ({
        axis: 3 as const,
        diameter: pilotDiameter,
        kind: "hole" as const,
        name: `bossPilot${String(index + 1)}`,
        position: [lidOffset + x, lidOffset + y, pilotMidZ] as const,
      })),
      {
        axis: 3 as const,
        kind: "interface" as const,
        name: "cavityOpening",
        position: [
          p.wallThicknessMm + p.innerWidthMm / 2,
          p.wallThicknessMm + p.innerDepthMm / 2,
          seatedZ,
        ] as const,
      },
    ];
  },
};
