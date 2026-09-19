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

/**
 * The fixed UNO R3 footprint data (see the module doc for the source):
 * outline and hole centers from the board's bottom-left corner, x along
 * the 68.58 mm edge, y along the 53.34 mm edge.
 */
export const ARDUINO_UNO_R3_FOOTPRINT = {
  boardWidthMm: 68.58,
  boardDepthMm: 53.34,
  boardHoleDiameterMm: 3.2,
  holeCentersFromBoardCornerMm: [
    [13.97, 2.54],
    [15.24, 50.8],
    [66.04, 35.56],
    [66.04, 7.62],
  ] as const,
} as const;

/** The validated, typed parameter set of the Arduino mount. */
export type ArduinoMountParameters = {
  /** The baseplate's thickness under the standoffs. */
  readonly plateThicknessMm: number;
  /** The standoff height the board rides above the plate. */
  readonly standoffHeightMm: number;
  /** The standoff diameter (the board-hole boss around each hole). */
  readonly standoffDiameterMm: number;
  /** The drilled clearance through plate and standoff. */
  readonly boardHoleDiameterMm: number;
  /** The plate's overhang beyond the board outline on every side. */
  readonly marginMm: number;
};

/** The closest a UNO R3 hole center sits to a board edge, in mm. */
const MIN_HOLE_EDGE_DISTANCE_MM = 2.54;

/**
 * The Arduino mount's serialized definition, carrying the dimension-source
 * disclosure verbatim in its description.
 */
export const ARDUINO_MOUNT_DEFINITION: CadComponentDefinition = defineComponent(
  {
    contractVersion: COMPONENT_CONTRACT_VERSION,
    description:
      "Mounting base for an Arduino UNO-class board: a baseplate with four standoffs at the UNO R3 footprint's hole positions, each drilled for an M3-compatible screw, so the board rides standoffHeight above the plate with its ⌀3.2 mounting holes accessible. Dimension sources (fixed board data, from the official Arduino UNO R3 mechanical drawing / Eagle reference design): 68.58 mm × 53.34 mm board outline; four ⌀3.2 mm mounting holes at (13.97, 2.54), (15.24, 50.80), (66.04, 35.56), (66.04, 7.62) mm from the board's bottom-left corner. The mount construction itself is parameterized: plate thickness, standoff height and diameter, drilled clearance, and the plate's overhang beyond the board outline.",
    id: "arduino-uno-mount",
    name: "Arduino UNO mounting base",
    parameters: [
      {
        defaultValue: 3,
        description: "The baseplate's thickness, in mm.",
        dimension: "length",
        max: 12,
        min: 1.5,
        name: "plateThicknessMm",
        step: 0.5,
      },
      {
        defaultValue: 6,
        description: "The standoff height under the board, in mm.",
        dimension: "length",
        max: 20,
        min: 2,
        name: "standoffHeightMm",
        step: 0.5,
      },
      {
        defaultValue: 7,
        description: "The standoff diameter, in mm.",
        dimension: "length",
        max: 16,
        min: 4,
        name: "standoffDiameterMm",
        step: 0.5,
      },
      {
        defaultValue: 3.2,
        description:
          "The drilled clearance through plate and standoff, in mm (the UNO holes are ⌀3.2).",
        dimension: "length",
        max: 6,
        min: 2,
        name: "boardHoleDiameterMm",
        step: 0.1,
      },
      {
        defaultValue: 2,
        description:
          "The plate's overhang beyond the board outline on every side, in mm (keeps the ⌀7 default standoffs fully on the plate).",
        dimension: "length",
        max: 10,
        min: 0,
        name: "marginMm",
        step: 0.5,
      },
    ],
    ports: [
      {
        description:
          "The board seat at the first UNO hole (13.97, 2.54) from the board corner.",
        kind: "boss",
        name: "boardMount1",
      },
      {
        description:
          "The board seat at the second UNO hole (15.24, 50.80) from the board corner.",
        kind: "boss",
        name: "boardMount2",
      },
      {
        description:
          "The board seat at the third UNO hole (66.04, 35.56) from the board corner.",
        kind: "boss",
        name: "boardMount3",
      },
      {
        description:
          "The board seat at the fourth UNO hole (66.04, 7.62) from the board corner.",
        kind: "boss",
        name: "boardMount4",
      },
    ],
    preview: {
      bodyIds: ["body_arduino-uno-mount"],
      viewport: { heightPx: 520, widthPx: 800 },
    },
    version: "1.0.0",
  },
);

/**
 * The definition's default values. The typed literal IS the descriptor
 * defaults; the contract tests pin the two in lockstep.
 */
export const ARDUINO_MOUNT_DEFAULT_PARAMETERS: ArduinoMountParameters = {
  boardHoleDiameterMm: 3.2,
  marginMm: 2,
  plateThicknessMm: 3,
  standoffDiameterMm: 7,
  standoffHeightMm: 6,
};

function parametersOf(
  resolved: ResolvedComponentParameters,
): ArduinoMountParameters {
  return {
    boardHoleDiameterMm: resolved.get("boardHoleDiameterMm"),
    marginMm: resolved.get("marginMm"),
    plateThicknessMm: resolved.get("plateThicknessMm"),
    standoffDiameterMm: resolved.get("standoffDiameterMm"),
    standoffHeightMm: resolved.get("standoffHeightMm"),
  };
}

/**
 * The board's hole centers in COMPONENT coordinates (the plate spans from
 * the origin, so the board outline is inset by the margin).
 */
export function boardHoleCentersMm(
  marginMm: number,
): readonly (readonly [number, number])[] {
  return ARDUINO_UNO_R3_FOOTPRINT.holeCentersFromBoardCornerMm.map(
    ([x, y]) => [x + marginMm, y + marginMm] as const,
  );
}

/**
 * The component-specific constraint the descriptors' bounds cannot
 * express: every standoff stays fully on the plate — the standoff radius
 * must fit within the margin plus the closest hole's distance to the
 * board edge.
 */
function validateConstraints(
  p: ArduinoMountParameters,
): ComponentBuildResult | null {
  const standoffRadius = p.standoffDiameterMm / 2;
  const reach = p.marginMm + MIN_HOLE_EDGE_DISTANCE_MM;
  if (standoffRadius > reach) {
    return {
      ok: false,
      error: parameterConflict(
        `The ⌀${String(p.standoffDiameterMm)} standoffs overhang the plate: the closest UNO hole sits ${String(MIN_HOLE_EDGE_DISTANCE_MM)} mm from the board edge, so the standoff radius (${String(standoffRadius)} mm) needs margin ≥ ${String(standoffRadius - MIN_HOLE_EDGE_DISTANCE_MM)} mm.`,
        p,
      ),
    };
  }
  if (p.boardHoleDiameterMm >= p.standoffDiameterMm) {
    return {
      ok: false,
      error: parameterConflict(
        `The drilled clearance (⌀${String(p.boardHoleDiameterMm)}) leaves no standoff wall — it must stay below the standoff diameter (⌀${String(p.standoffDiameterMm)}).`,
        p,
      ),
    };
  }
  return null;
}

/** The Arduino UNO mounting base component: one body, four boss ports. */
export const arduinoMount: CadComponent = {
  definition: ARDUINO_MOUNT_DEFINITION,

  async build(kernel, values): Promise<ComponentBuildResult> {
    const resolved = resolveBuildParameters(ARDUINO_MOUNT_DEFINITION, values);
    if (!resolved.ok) {
      return { ok: false, error: contractFailureAsBuildError(resolved.error) };
    }
    const p = parametersOf(resolved.value);
    const constrained = validateConstraints(p);
    if (constrained !== null) return constrained;

    const widthMm = ARDUINO_UNO_R3_FOOTPRINT.boardWidthMm + 2 * p.marginMm;
    const depthMm = ARDUINO_UNO_R3_FOOTPRINT.boardDepthMm + 2 * p.marginMm;
    const totalHeightMm = p.plateThicknessMm + p.standoffHeightMm;

    const plate = await kernel.createBox({
      depth: length(depthMm),
      height: length(p.plateThicknessMm),
      width: length(widthMm),
    });
    if (!plate.ok) return plate;

    const centers = boardHoleCentersMm(p.marginMm);
    const tools: KernelSolid[] = [];
    const standoffs: KernelSolid[] = [];
    for (const [x, y] of centers) {
      const standoff = await kernel.createCylinder({
        height: length(p.standoffHeightMm),
        radius: length(p.standoffDiameterMm / 2),
      });
      if (!standoff.ok) return standoff;
      const placed = await kernel.transform(standoff.value, {
        x: length(x),
        y: length(y),
        z: length(p.plateThicknessMm),
      });
      if (!placed.ok) return placed;
      standoffs.push(placed.value);
    }

    let assembled = plate.value;
    if (standoffs.length > 0) {
      const united = await kernel.union([plate.value, ...standoffs]);
      if (!united.ok) return united;
      assembled = united.value;
    }

    for (const [x, y] of centers) {
      const hole = await kernel.createCylinder({
        height: length(totalHeightMm),
        radius: length(p.boardHoleDiameterMm / 2),
      });
      if (!hole.ok) return hole;
      const holePlaced = await kernel.transform(hole.value, {
        x: length(x),
        y: length(y),
        z: length(0),
      });
      if (!holePlaced.ok) return holePlaced;
      tools.push(holePlaced.value);
    }

    const drilled = await kernel.subtract(assembled, tools);
    if (!drilled.ok) return drilled;

    return {
      ok: true,
      value: {
        bodies: [
          {
            bodyId: ARDUINO_MOUNT_DEFINITION.preview.bodyIds[0] ?? "",
            name: "base",
            solid: drilled.value,
          },
        ],
      },
    };
  },

  ports(values: ComponentParameterValues): readonly ComponentPortInstance[] {
    // Metadata view, not a build path: malformed values read the defaults.
    const value = (name: string): number =>
      parameterValueOrDefault(ARDUINO_MOUNT_DEFINITION, values, name);
    const margin = value("marginMm");
    const topZ = value("plateThicknessMm") + value("standoffHeightMm");
    const centers = boardHoleCentersMm(margin);
    return centers.map(([x, y], index) => ({
      axis: 3 as const,
      diameter: value("boardHoleDiameterMm"),
      kind: "boss" as const,
      name: `boardMount${String(index + 1)}`,
      position: [x, y, topZ] as const,
    }));
  },
};
