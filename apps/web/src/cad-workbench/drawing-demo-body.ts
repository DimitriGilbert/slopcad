/**
 * The drawing workbench's demo body (Phase 53): a deterministic indexed
 * tessellation of the plate-with-boss fixture — a 60 x 40 x 10 mm plate
 * carrying a centered 20 x 20 x 15 mm rectangular boss — as the overlay
 * projection's input. Hand-built triangle soup (12 triangles for the plate
 * + 12 for the boss), fixed vertex order, so the projected edges are
 * byte-deterministic and the expected feature-edge counts are analytic
 * (12 plate edges + 8 boss edges + 4 boss-footprint edges = 24 in general;
 * the front view's projective coincidence reduces what is DISTINCT on the
 * sheet, which the module's test pins exactly).
 */

import {
  createOccurrenceId,
  type OccurrenceBomFlag,
  type OccurrenceId,
} from "@slopcad/cad-core";

export interface DemoMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

/**
 * The demo plate-with-boss mesh. Vertices 0-7: the plate box (z in
 * [0, 10]); vertices 8-15: the boss box (x in [20, 40], y in [10, 30],
 * z in [10, 25]). Triangles: 12 plate + 12 boss; the boss's bottom face is
 * omitted where it is interior to the plate top (the two solids are unioned
 * by construction), and the plate top face is triangulated AROUND the boss
 * footprint (8 triangles), keeping the mesh boundary-exact.
 */
export const DEMO_PLATE_MESH: DemoMesh = {
  positions: [
    // Plate box (0-7)
    0, 0, 0, 60, 0, 0, 60, 40, 0, 0, 40, 0, 0, 0, 10, 60, 0, 10, 60, 40, 10, 0,
    40, 10,
    // Boss box (8-15), bottom four share the plate top plane z=10
    20, 10, 10, 40, 10, 10, 40, 30, 10, 20, 30, 10, 20, 10, 25, 40, 10, 25, 40,
    30, 25, 20, 30, 25,
  ],
  indices: [
    // Plate bottom (z=0), normal -z: 0,3,2 / 0,2,1
    0,
    3,
    2,
    0,
    2,
    1,
    // Plate sides
    0,
    1,
    5,
    0,
    5,
    4, // front y=0
    1,
    2,
    6,
    1,
    6,
    5, // right x=60
    2,
    3,
    7,
    2,
    7,
    6, // back y=40
    3,
    0,
    4,
    3,
    4,
    7, // left x=0
    // Plate top (z=10) around the boss footprint [20,40]x[10,30]:
    // four strips, each a quad split in two
    4,
    5,
    9,
    4,
    9,
    8, // front strip y in [0,10]
    6,
    7,
    11,
    6,
    11,
    10, // back strip y in [30,40]
    4,
    8,
    11,
    4,
    11,
    7, // left strip x in [0,20]
    5,
    6,
    10,
    5,
    10,
    9, // right strip x in [40,60]
    // Boss sides (8-15 pattern like the plate)
    8,
    9,
    13,
    8,
    13,
    12, // boss front y=10
    9,
    10,
    14,
    9,
    14,
    13, // boss right x=40
    10,
    11,
    15,
    10,
    15,
    14, // boss back y=30
    11,
    8,
    12,
    11,
    12,
    15, // boss left x=20
    // Boss top (z=25), normal +z: 12,13,14 / 12,14,15
    12,
    13,
    14,
    12,
    14,
    15,
  ],
};

/**
 * The demo assembly structure the BOM table derives from (Phase 55): three
 * item groups over the plate fixture — a default part row, a sub-assembly
 * header marked `phantom` (never ships a row and consumes no item number),
 * and a `purchased` fastener appearing twice — exercising every
 * `numberBomItems` rule in one deterministic table (items 1..2, quantities
 * 1/2, flag disclosure).
 */
export interface DemoOccurrence {
  readonly id: OccurrenceId;
  readonly name: string;
  readonly bomFlag?: OccurrenceBomFlag;
}

export const DEMO_ASSEMBLY_OCCURRENCES: readonly DemoOccurrence[] = [
  { id: createOccurrenceId("occ_plate"), name: "Mounting plate" },
  { id: createOccurrenceId("occ_frame"), name: "Frame", bomFlag: "phantom" },
  { id: createOccurrenceId("occ_bolt"), name: "M5 bolt", bomFlag: "purchased" },
  {
    id: createOccurrenceId("occ_bolt-2"),
    name: "M5 bolt",
    bomFlag: "purchased",
  },
];
