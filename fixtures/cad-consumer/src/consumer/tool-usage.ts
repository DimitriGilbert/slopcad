/**
 * The consumer's usage of the installed HEADLESS TOOLS (Phase 33.4): the
 * registry-installed inspection and feature tools are imported here and
 * exercised — one REAL invocation each (honest null semantics included),
 * plus the feature tools' document-facing request builders kept
 * type-checked. The App renders the summary; `tsc --noEmit` type-checks
 * every import.
 */

import { boundsReadout } from "@/cad/tools/bounds-inspection";
import { distanceReadout } from "@/cad/tools/distance-inspection";
import { massPropertiesReadout } from "@/cad/tools/mass-properties-inspection";
import { radiusReadout } from "@/cad/tools/radius-inspection";
import {
  documentExtrudeRequest,
  extrudeSceneRequestOfFeature,
} from "@/cad/tools/extrude";
import { documentRevolveRequest } from "@/cad/tools/revolve";
import {
  documentHoleSceneRequest,
  HOLE_DEFAULT_DIAMETER_MM,
} from "@/cad/tools/hole";

/** One installed tool as the App lists it. */
export interface InstalledToolSummary {
  /** The tool's registry item name. */
  readonly item: string;
  /** What the tool does, one line. */
  readonly purpose: string;
  /** A real invocation's rendered outcome. */
  readonly outcome: string;
}

/** A real invocation of the bounds tool with no selection: honest null. */
const bounds = boundsReadout({
  selected: [],
  features: [],
  sceneBodyId: undefined,
  bounds: undefined,
  tightBooleanBounds: true,
});

/** A real invocation of the distance tool with no reference pair. */
const distance = distanceReadout({
  selected: [],
  features: [],
  projection: undefined,
});

/** A real invocation of the mass-properties tool with no settled scene. */
const mass = massPropertiesReadout({
  selected: [],
  features: [],
  sceneBodyId: undefined,
  volume: undefined,
  area: undefined,
});

/** A real invocation of the radius tool with no cylindrical face. */
const radius = radiusReadout({
  selected: [],
  features: [],
  projection: undefined,
});

/**
 * The feature tools' document-facing builders, referenced so the bundler
 * and the typechecker both carry the installed modules.
 */
export const featureToolExports = {
  documentExtrudeRequest,
  documentHoleSceneRequest,
  documentRevolveRequest,
  extrudeSceneRequestOfFeature,
} as const;

/** The installed headless tools, with a real outcome each. */
export const INSTALLED_TOOLS: readonly InstalledToolSummary[] = [
  {
    item: "bounds-inspection-tool",
    purpose: "Selected body's axis-aligned bounds from the settled scene.",
    outcome: `text=${bounds.text === null ? "null" : `"${bounds.text}"`} · tightness=${bounds.tightness}`,
  },
  {
    item: "distance-inspection-tool",
    purpose: "Distance between the selection's references.",
    outcome: `text=${distance.text === null ? "null" : `"${distance.text}"`}`,
  },
  {
    item: "mass-properties-inspection-tool",
    purpose: "Volume and surface area of the selected body.",
    outcome: `volume=${mass.volumeText === null ? "null" : `"${mass.volumeText}"`}`,
  },
  {
    item: "radius-inspection-tool",
    purpose: "Cylindrical face radius under the selection.",
    outcome: `text=${radius.text === null ? "null" : `"${radius.text}"`}`,
  },
  {
    item: "extrude-tool",
    purpose: "Extrude feature to kernel scene request.",
    outcome: `builder=${typeof documentExtrudeRequest}`,
  },
  {
    item: "revolve-tool",
    purpose: "Revolve feature to kernel scene request.",
    outcome: `builder=${typeof documentRevolveRequest}`,
  },
  {
    item: "hole-tool",
    purpose:
      "Hole feature to boolean cut (⌀ default " +
      `${String(HOLE_DEFAULT_DIAMETER_MM)} mm).`,
    outcome: `builder=${typeof documentHoleSceneRequest}`,
  },
];
