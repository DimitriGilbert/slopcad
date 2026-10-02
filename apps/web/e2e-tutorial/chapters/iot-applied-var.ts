import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  collectDownloads,
  DIALOG,
  OCCT_ROOT,
  SKETCH,
  VIEWPORT_COMPLETE,
  volumeNear,
  waitForRootSettle,
} from "../../e2e-session/helpers";
import { readFaceAnchors } from "../../e2e-render/helpers";
import {
  fillLabeledField,
  openFeatureDialog,
  pickComboboxOption,
} from "../feature-verbs";

// ---------------------------------------------------------------------------
// The variable system (every number below is the arithmetic, shown)
// ---------------------------------------------------------------------------
//
// The commission: a 3D-printable case whose EVERY dimension derives from a
// small variable system, built live in the parameter manager. The root is
// the print line width; the owner's ratios (a corner post twice the wall,
// floor and lid three times it) and the board's socketing stack (pin
// header + board thickness + the lift gap) do the rest:
//
//   lineWidth   0.4 mm   the root — one printed line
//   wallCount   5        the perimeter count (dimensionless)
//   wall        := wallCount * lineWidth          = 2 mm
//   post        := 2 * wall                       = 4 mm
//   bottom      := 3 * wall                       = 6 mm
//   lidT        := 3 * wall                       = 6 mm
//   boardL      70 mm    the perfboard, 5 by 7 cm
//   boardW      50 mm
//   header      8.5 mm   the pin header under the board
//   boardT      1.6 mm   the board itself
//   gapUnder    0.5 mm   the socketing clearance
//   boardLift   := header + gapUnder              = 9 mm
//   topClear    25 mm    the components above the board
//   caseH       := boardLift + boardT + topClear  = 35.6 mm
//   caseL       := boardL + 2 * wall              = 74 mm
//   caseW       := boardW + 2 * wall              = 54 mm
//   portX       35 mm    the connector's place along the front face
//   portW       10 mm    the window's width
//   portH       7 mm     the window's height
//   portOffset  1 mm     centers the window on the connector
//   portZ       := boardLift + portOffset         = 10 mm
//   lidClear    0.5 mm   the lid lip's slide clearance (total)
//   cavityD     := caseH - bottom                 = 29.6 mm
//   portCut     := wall + 1mm                     = 3 mm
//   postDrop    := cavityD - boardLift            = 20.6 mm
//   postFarX    := boardL + wall - post           = 68 mm
//   postFarY    := boardW + wall - post           = 48 mm
//   lipL        := boardL - lidClear              = 69.5 mm
//   lipW        := boardW - lidClear              = 49.5 mm
//   lipInset    := wall + lidClear / 2            = 2.25 mm
//   The DIALOG grammar is a bare `$name` (the token pattern anchors both
//   ends — no `-$name`), so the four DOWNWARD extrudes ride signed
//   helpers, and the sign is a variable like everything else:
//   cavityDrop  := -cavityD                       = -29.6 mm
//   postDropDown := -postDrop                     = -20.6 mm
//   portCutIn   := -portCut                       = -3 mm
//   lidHang     := -lidT                          = -6 mm
//   caseDrop    := -caseH                         = -35.6 mm
//
// ## The build, and what the probes taught
//
// 1. THE FRAME. The bed plane is the case's OPENING RIM (z = 0); the whole
//    case hangs below it — the applied-iot-case teaching frame. The block
//    is the footprint extruded DOWN $caseH; the cavity tool is a bed
//    sketch too, extruded DOWN $cavityD.
// 2. THE FOOTPRINT SKETCHES READ THE VARIABLES. Phase 26a's binding is
//    the chapter's payoff: every plan rectangle is drawn, dimensioned
//    with distanceX/distanceY pairs, and each dimension is then BOUND
//    through the sketch inspector's `$`-autocomplete — the field takes
//    `$name`, Apply commits the bound `sketch.dimension.set` (a
//    parameterId, no value), the inspector row renames to
//    `distanceX $caseL`, and the sketch re-solves against the variable.
//    The saved sketch keeps its bindings, so a parameter edit re-solves
//    the sketch and re-drives every consuming feature (the engine's
//    bound-sketch invalidation edge). One `horizontal` per rectangle
//    squares the frame to the world axes; the drawn geometry equals the
//    bound defaults, so the pinning changes nothing until a variable
//    moves. The probe also fixed the pick grammar: a click 0.4 mm inside
//    the wanted endpoint (never mid-edge — the center target ties at
//    short spans), and one probe finding shapes the bind flow: right
//    after an Apply the NEXT constraint's field can mount stale-empty,
//    so each bind re-selects its row and clears the field blind
//    (Ctrl+A) before typing the token.
// 3. THE POSTS ARE UNIONED BACK, ALL `$`-DRIVEN. The draft's first
//    instinct — a notched one-piece tool whose subtract leaves the
//    posts — died in the binding probe: the 12-gon chain has no
//    rectangle-entity conveniences, and keeping it closed while the
//    board moves needs ~36 constraints (twelve coincidences, twelve
//    horizontals/verticals, fourteen dimensions) — unteachable at
//    tutorial pace. The rectangle-native answer: the cavity is ONE
//    bound rectangle (place pair at the wall inset, size pair at the
//    board), the subtract empties it, and FOUR post squares — sizes at
//    $post, the near square at the wall corner, the far three at
//    $postFarX/$postFarY place pairs — extrude DOWN $cavityD and union
//    back onto the shell in a sequential chain (the applied chapter's
//    probed-and-exact union chain): born fused, printed as one body.
//    (The old multi-tool subtract was probed and avoided: one subtract
//    with four tools removed five prisms' worth.)
// 4. THE TRIM IS THE BOARD'S OWN OUTLINE. One bed rectangle at the
//    cavity's own bound numbers — place $wall/$wall, size
//    $boardL/$boardW — extruded DOWN $postDrop and subtracted once:
//    it shears exactly the four posts' tops (4 · post² · postDrop), so
//    the posts come out boardLift tall wherever the board moves them.
//    The old four-rect trim chain was exact but unbindable; the prism
//    is exact AND reads the variables.
// 5. EVERY DEPTH IS A $ NAME. The draft dialog's Distance fields take
//    `$name` references with the clickable autocomplete (Phase 21), and a
//    referenced parameter is re-read on every dispatch. The chapter's
//    extrudes ride $caseH, $cavityD, $postDrop (five times), $portCut and
//    $lidT (twice) — so the payoff demos re-drive real geometry.
// 6. THE EDIT THAT RE-DERIVES IS THE EXPRESSION COMMIT. Probed: the
//    panel's literal edit is the value-only arm ("the cached value moves,
//    nothing is recomputed") — features referencing DERIVED variables read
//    the stale cache. The manager's expression editor (a constant is a
//    legal expression) is the commit that runs the topological recompute;
//    the demos edit the roots THERE, and the whole DAG follows.
// 7. THE PORT IS ONE FACE SUBTRACT. The hole dialog takes no `$` (probed),
//    so the window is a prism sketched on the front wall's outer face —
//    the view cube's LEFT face aims it, sketch-on-face anchors it, and
//    the datum frame's u/v ride the session's in-plane rule (u = world Y,
//    v = -world Z for a -x normal). The prism extrudes -$portCut (into
//    the material, one wall of overshoot) and one subtract opens the
//    window. The face, X, and height are parameters of the design — the
//    narration teaches re-positioning as re-authoring the one sketch.
//    The near corner's pin keeps the front wall at x = 0 through every
//    re-drive (growth reads +x/+y), so the window's placement rides
//    still through demo 2.
//
// ## The volume ledger (defaults; every pin below derives from it)
//
//   block            74 * 54 * 35.6            = 142,257.6
//   cavity tool      70 * 50 * 29.6            = 103,600
//   shell            142,257.6 - 103,600       =  38,657.6
//   each post union  +4 * 4 * 29.6             =   +473.6 (x4)
//   shell + posts                              =  40,552
//   trim prism cut   -4 * 4 * 20.6             = -1,318.4
//   trimmed                                    =  39,233.6
//   port prism       10 * 7 * 3                =     210   (body on stage)
//   port cut         2 * 10 * 7                =    -140
//   THE BOX                                    =  39,093.6
//   lid plate        74 * 54 * 6               =  23,976
//   lid lip          69.5 * 49.5 * 6           =  20,641.5
//   THE LID                                    =  44,617.5
//   box bounds   [0,0,-35.6]..[74,54,0]; lid bounds [0,0,-6]..[74,54,6]
//
//   demo 1 (lineWidth 0.5): wall 2.5, post 5, bottom/lidT 7.5, caseL 75,
//     caseW 55, cavityD 28.1, postDrop 19.1, portCut 3.5, wall cut 2.5:
//     146,850 - 98,350 + 2,810 - 1,910 - 175 = 49,225
//     (the posts' squares really grow now — the bindings re-derive them;
//     the pre-binding chapter had to narrate them as held at 4)
//   demo 2 (board 85 by 60): caseL 89, caseW 64 — THE CASE MOVES. The
//     bound sketches re-solve: 89 * 64 * 35.6 = 202,777.6; cavity
//     85 * 60 * 29.6 = 150,960; posts 1,894.4; trim cut 1,318.4;
//     port cut 140: 202,777.6 - 150,960 + 1,894.4 - 1,318.4 - 140
//     = 52,253.6. Then back to 70 by 50, re-pinned at 39,093.6.
//   demo 3 (header 12): boardLift 12.5, caseH 39.1, cavityD 33.1,
//     postDrop = boardT + topClear - bottom = 20.6 (the rest-plane
//     invariant — the floor drops with the stack):
//     156,243.6 - 115,850 + 2,118.4 - 1,318.4 - 140 = 41,053.6

/** The block: the full footprint, 35.6 tall, extruded below the bed. */
const BLOCK_VOLUME = 74 * 54 * 35.6;
/** The cavity tool: the board's own footprint, wall-inset, cavityD deep. */
const CAVITY_VOLUME = 70 * 50 * 29.6;
/** The shell after the cavity subtract: walls and floor, no posts. */
const SHELL_VOLUME = BLOCK_VOLUME - CAVITY_VOLUME;
/** One post: post by post, the cavity's full depth. */
const POST_VOLUME = 4 * 4 * 29.6;
/** The shell with its four corner posts unioned back on. */
const SHELL_POSTS_VOLUME = SHELL_VOLUME + 4 * POST_VOLUME;
/** The material one trim prism cut removes: four post-square columns. */
const TRIM_CUT_VOLUME = 4 * 4 * 20.6;
/** The case after the board-outline trim: boardLift-tall posts. */
const TRIMMED_VOLUME = SHELL_POSTS_VOLUME - 4 * TRIM_CUT_VOLUME;
/** The port prism: portW by portH by portCut, overshooting into air. */
const PORT_PRISM_VOLUME = 10 * 7 * 3;
/** The wall the port cut removes: wall thickness by the window. */
const PORT_CUT_VOLUME = 2 * 10 * 7;
/** The box file: the trimmed case with its USB window. */
const BOX_VOLUME = TRIMMED_VOLUME - PORT_CUT_VOLUME;
/** The lid's plate: the full footprint, lidT thick. */
const PLATE_VOLUME = 74 * 54 * 6;
/** The lid's lip: board minus the clearance, hanging lidT down. */
const LIP_VOLUME = 69.5 * 49.5 * 6;
/** The lid file: plate + lip. */
const LID_VOLUME = PLATE_VOLUME + LIP_VOLUME;
/** The boot demo plate's volume (30 x 20 x 10 with the diameter-8 bore). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** Demo 1 (lineWidth 0.5): the whole chain re-derived — posts included. */
const DEMO_WIDTH_VOLUME =
  75 * 55 * 35.6 -
  70 * 50 * 28.1 +
  4 * (5 * 5 * 28.1) -
  4 * (5 * 5 * 19.1) -
  2.5 * 10 * 7;
/** Demo 2 (board 85 by 60): the bound sketches re-solve; the case MOVES. */
const DEMO_BOARD_VOLUME =
  89 * 64 * 35.6 -
  85 * 60 * 29.6 +
  4 * (4 * 4 * 29.6) -
  4 * (4 * 4 * 20.6) -
  PORT_CUT_VOLUME;
/** Demo 3 (header 12): the deeper case, posts grown with the dropped floor. */
const DEMO_HEADER_VOLUME =
  74 * 54 * 39.1 -
  70 * 50 * 33.1 +
  4 * (4 * 4 * 33.1) -
  4 * (4 * 4 * 20.6) -
  PORT_CUT_VOLUME;
/** All bodies tessellate planar-exact: the house band is generous. */
const PLANAR_VOLUME_FLOOR = 0.999;

/** The extrudes' body-key suffixes ride the shared extrude counter: the
 * draft dialog's n-th extrude is `body_extrude{n}` (no bare first form —
 * the dialog path always suffixes). Block, cavity, four posts, trim,
 * port prism, plate, lip. */
const EXTRUDE_KEYS = [
  "body|body_extrude1",
  "body|body_extrude2",
  "body|body_extrude3",
  "body|body_extrude4",
  "body|body_extrude5",
  "body|body_extrude6",
  "body|body_extrude7",
  "body|body_extrude8",
] as const;
/** The seven booleans' bodies: the cavity subtract, four post unions,
 * the board-outline trim, the port. */
const BOOLEAN_KEYS = [
  "body|body_boolean",
  "body|body_boolean2",
  "body|body_boolean3",
  "body|body_boolean4",
  "body|body_boolean5",
  "body|body_boolean6",
  "body|body_boolean7",
] as const;

/**
 * Chapter 31 — the applied variables capstone. ONE continuous build that
 * makes everything derive: the commission brief, the variable system built
 * live in the manager (create, expression, `$` autocomplete), the case
 * whose every dimension — extrude depth AND sketch dimension — is a
 * `$name` reference (Phase 26a's binding through the sketch inspector's
 * autocomplete), the cavity subtract with four post squares unioned back
 * fused, the board-outline trim that shears them to boardLift, the port
 * authored on the front face at its parameterized height, the three
 * re-drive demos (lineWidth, board size — the case MOVES, header), the
 * two-rectangle lid, and the two view-scoped exports verified against
 * their analytic volumes and their taught world bounds.
 */
export const chapter: ChapterModule = {
  definition: {
    id: "iot-applied-var",
    title: "Applied project: a case driven by variables",
    summary:
      "One continuous build from a line width to a two-file print set: the variable system in the manager, every depth and every footprint dimension a $name reference, the re-drive demos, and the exports.",
    cues: [
      {
        stepId: "brief",
        text: "The commission: a case where one number, the print line width, drives it all.",
      },
      {
        stepId: "vars-root",
        text: "Two roots: lineWidth 0.4, a printed line; wallCount 5, the perimeter count.",
      },
      {
        stepId: "vars-wall",
        text: "wall := wallCount times lineWidth — five lines stack two millimetres.",
      },
      {
        stepId: "vars-print",
        text: "The printer's ratios: post twice the wall, floor and lid three times.",
      },
      {
        stepId: "vars-board",
        text: "The board's numbers: 70 by 50, header 8.5, board 1.6, lift gap 0.5.",
      },
      {
        stepId: "vars-lift",
        text: "boardLift := header + gapUnder — nine millimetres of socketed air.",
      },
      {
        stepId: "vars-case",
        text: "caseH adds the stack: 9 + 1.6 + 25. caseL and caseW wrap the board.",
      },
      {
        stepId: "vars-port",
        text: "The port: X 35, window 10 by 7, portZ := boardLift + offset — ten.",
      },
      {
        stepId: "vars-build",
        text: "Build helpers: depths, the far-post place, the lip fit — all derived.",
      },
      {
        stepId: "stage",
        text: "The demo plate steps aside — the stage belongs to the build now.",
      },
      {
        stepId: "block",
        text: "The block: 74 by 54 drawn, its spans bound to caseL and caseW.",
      },
      {
        stepId: "pocket-why",
        text: "The cavity is one bound rectangle; four bound squares return as posts.",
      },
      {
        stepId: "pocket",
        text: "The cavity: drawn at the wall inset, its four numbers bound — then cut.",
      },
      {
        stepId: "subtract",
        text: "The subtract: 38,657.6 — walls and floor, no posts yet.",
      },
      {
        stepId: "posts",
        text: "Four squares at $post, placed by variables, union back — 40,552.",
      },
      {
        stepId: "posts-why",
        text: "Born fused: the union is the print — walls and posts, one body.",
      },
      {
        stepId: "trims",
        text: "The board's own outline shears the columns to boardLift — 39,233.6.",
      },
      {
        stepId: "port-why",
        text: "Face, X, height: all parameters. We author the one subtract on the short face.",
      },
      {
        stepId: "port-face",
        text: "The left view aims the front wall: sketch on its face, at the port's height.",
      },
      {
        stepId: "port-cut",
        text: "A 10 by 7 window at portX, portZ, cut by $portCut — 39,093.6.",
      },
      {
        stepId: "iso-read",
        text: "The port rides at MCU height: boardLift plus the offset, from the floor's math.",
      },
      {
        stepId: "demo-width",
        text: "lineWidth to 0.5: wall 2.5, post 5 — the case re-derives to 49,225.",
      },
      {
        stepId: "demo-board",
        text: "An 85 by 60 board: the sketches re-solve — the case grows to 52,253.6.",
      },
      {
        stepId: "demo-header",
        text: "header to 12: the case deepens to 39.1 — the posts grow with the floor.",
      },
      {
        stepId: "lid-why",
        text: "The lid: two rectangles — a plate to the footprint, a lip to slide inside.",
      },
      {
        stepId: "lid-plate",
        text: "The plate: the block's bound spans again, up lidT — 23,976 cubic.",
      },
      {
        stepId: "lid-lip",
        text: "The lip: board minus clearance at the inset, hung lidT down — 20,641.5.",
      },
      {
        stepId: "box-scope",
        text: "The lid steps aside through its tree eyes — the scene is the box alone.",
      },
      {
        stepId: "export-box",
        text: "The box's STL: 39,093.6 cubic, z from -35.6 to the rim.",
      },
      {
        stepId: "lid-scope",
        text: "The reverse: the box aside, the lid back — the second file's scope.",
      },
      {
        stepId: "export-lid",
        text: "The lid's STL: 44,617.5 cubic, z from -6 to 6.",
      },
      {
        stepId: "recap",
        text: "Two files, one variable system: change a root, and the whole case follows.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    // -- The brief, over the fresh boot -------------------------------------
    await driver.step("brief");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeCloseTo(BOOT_PLATE_VOLUME, 0);
    await driver.dwell();

    // -- The variable system, live in the manager ---------------------------
    await driver.step("vars-root");
    const panel = page.locator('[data-slot="cad-parameter-panel"]');
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await createVariable(page, driver, panel, "lineWidth", "0.4mm");
    await createVariable(page, driver, panel, "wallCount", "5");
    await driver.dwell();

    await driver.step("vars-wall");
    // wall := wallCount * lineWidth — the first definition, written with
    // the manager's own `$` autocomplete (two clicked rows). Each derived
    // name is CREATED first with the number a hand calc gives, then its
    // expression keeps it true — the manager defines over existing rows.
    await createVariable(page, driver, panel, "wall", "2mm");
    await defineExpression(page, driver, panel, "wall", [
      { type: "$", text: "$wallC", option: "wallCount" },
      { type: "text", text: " * " },
      { type: "$", text: "$line", option: "lineWidth" },
    ]);
    await driver.pointAtReadout(
      rowOf(page, panel, "wall").getByText("= 2 mm", { exact: true }),
    );
    await driver.dwell();

    await driver.step("vars-print");
    // The owner's print logic, two clicks an expression: a corner post is
    // twice the wall; floor and lid are three.
    await createVariable(page, driver, panel, "post", "4mm");
    await createVariable(page, driver, panel, "bottom", "6mm");
    await createVariable(page, driver, panel, "lidT", "6mm");
    await defineExpression(page, driver, panel, "post", [
      { type: "text", text: "2 * " },
      { type: "$", text: "$wal", option: "wall" },
    ]);
    await defineExpression(page, driver, panel, "bottom", [
      { type: "text", text: "3 * " },
      { type: "$", text: "$wal", option: "wall" },
    ]);
    await defineExpression(page, driver, panel, "lidT", [
      { type: "text", text: "3 * " },
      { type: "$", text: "$wal", option: "wall" },
    ]);
    await driver.dwell();

    await driver.step("vars-board");
    await createVariable(page, driver, panel, "boardL", "70mm");
    await createVariable(page, driver, panel, "boardW", "50mm");
    await createVariable(page, driver, panel, "header", "8.5mm");
    await createVariable(page, driver, panel, "boardT", "1.6mm");
    await createVariable(page, driver, panel, "gapUnder", "0.5mm");
    await driver.dwell();

    await driver.step("vars-lift");
    // The socketing stack: the header lifts the board, the gap keeps the
    // sockets from seating hard.
    await createVariable(page, driver, panel, "boardLift", "9mm");
    await defineExpression(page, driver, panel, "boardLift", [
      { type: "$", text: "$hea", option: "header" },
      { type: "text", text: " + " },
      { type: "$", text: "$gap", option: "gapUnder" },
    ]);
    await driver.pointAtReadout(
      rowOf(page, panel, "boardLift").getByText("= 9 mm", { exact: true }),
    );
    await driver.dwell();

    await driver.step("vars-case");
    await createVariable(page, driver, panel, "topClear", "25mm");
    await createVariable(page, driver, panel, "caseH", "35.6mm");
    await createVariable(page, driver, panel, "caseL", "74mm");
    await createVariable(page, driver, panel, "caseW", "54mm");
    await defineExpression(page, driver, panel, "caseH", [
      { type: "$", text: "$boardLi", option: "boardLift" },
      { type: "text", text: " + " },
      { type: "$", text: "$boardT", option: "boardT" },
      { type: "text", text: " + " },
      { type: "$", text: "$top", option: "topClear" },
    ]);
    await defineExpression(page, driver, panel, "caseL", [
      { type: "$", text: "$boardL", option: "boardL" },
      { type: "text", text: " + 2 * " },
      { type: "$", text: "$wal", option: "wall" },
    ]);
    await defineExpression(page, driver, panel, "caseW", [
      { type: "$", text: "$boardW", option: "boardW" },
      { type: "text", text: " + 2 * " },
      { type: "$", text: "$wal", option: "wall" },
    ]);
    await driver.pointAtReadout(
      rowOf(page, panel, "caseH").getByText("= 35.6 mm", { exact: true }),
    );
    await driver.dwell();

    await driver.step("vars-port");
    await createVariable(page, driver, panel, "portX", "35mm");
    await createVariable(page, driver, panel, "portW", "10mm");
    await createVariable(page, driver, panel, "portH", "7mm");
    await createVariable(page, driver, panel, "portOffset", "1mm");
    await createVariable(page, driver, panel, "portZ", "10mm");
    await defineExpression(page, driver, panel, "portZ", [
      { type: "$", text: "$boardLi", option: "boardLift" },
      { type: "text", text: " + " },
      { type: "$", text: "$portO", option: "portOffset" },
    ]);
    await driver.dwell();

    await driver.step("vars-build");
    // The build's own helpers join the DAG: the pocket's depth, the port
    // cut's overshoot, the post trim's drop, the far posts' place (the
    // board's far corner minus one post), the lip's fit — every one an
    // expression.
    await createVariable(page, driver, panel, "lidClear", "0.5mm");
    await createVariable(page, driver, panel, "cavityD", "29.6mm");
    await createVariable(page, driver, panel, "portCut", "3mm");
    await createVariable(page, driver, panel, "postDrop", "20.6mm");
    await createVariable(page, driver, panel, "postFarX", "68mm");
    await createVariable(page, driver, panel, "postFarY", "48mm");
    await createVariable(page, driver, panel, "lipL", "69.5mm");
    await createVariable(page, driver, panel, "lipW", "49.5mm");
    await createVariable(page, driver, panel, "lipInset", "2.25mm");
    // The five downward extrudes ride signed helpers: the dialog grammar
    // is a bare `$name`, so the sign is a variable like everything else.
    await createVariable(page, driver, panel, "cavityDrop", "0mm");
    await createVariable(page, driver, panel, "postDropDown", "0mm");
    await createVariable(page, driver, panel, "portCutIn", "0mm");
    await createVariable(page, driver, panel, "lidHang", "0mm");
    await createVariable(page, driver, panel, "caseDrop", "0mm");
    await defineExpression(page, driver, panel, "cavityD", [
      { type: "$", text: "$caseH", option: "caseH" },
      { type: "text", text: " - " },
      { type: "$", text: "$bot", option: "bottom" },
    ]);
    await defineExpression(page, driver, panel, "portCut", [
      { type: "$", text: "$wal", option: "wall" },
      { type: "text", text: " + 1mm" },
    ]);
    await defineExpression(page, driver, panel, "postDrop", [
      { type: "$", text: "$cavity", option: "cavityD" },
      { type: "text", text: " - " },
      { type: "$", text: "$boardLi", option: "boardLift" },
    ]);
    await defineExpression(page, driver, panel, "postFarX", [
      { type: "$", text: "$boardL", option: "boardL" },
      { type: "text", text: " + " },
      { type: "$", text: "$wal", option: "wall" },
      { type: "text", text: " - " },
      { type: "$", text: "$pos", option: "post" },
    ]);
    await defineExpression(page, driver, panel, "postFarY", [
      { type: "$", text: "$boardW", option: "boardW" },
      { type: "text", text: " + " },
      { type: "$", text: "$wal", option: "wall" },
      { type: "text", text: " - " },
      { type: "$", text: "$pos", option: "post" },
    ]);
    await defineExpression(page, driver, panel, "lipL", [
      { type: "$", text: "$boardL", option: "boardL" },
      { type: "text", text: " - " },
      { type: "$", text: "$lidC", option: "lidClear" },
    ]);
    await defineExpression(page, driver, panel, "lipW", [
      { type: "$", text: "$boardW", option: "boardW" },
      { type: "text", text: " - " },
      { type: "$", text: "$lidC", option: "lidClear" },
    ]);
    await defineExpression(page, driver, panel, "lipInset", [
      { type: "$", text: "$wal", option: "wall" },
      { type: "text", text: " + " },
      { type: "$", text: "$lidC", option: "lidClear" },
      { type: "text", text: " / 2" },
    ]);
    await defineExpression(page, driver, panel, "cavityDrop", [
      { type: "text", text: "-" },
      { type: "$", text: "$cavity", option: "cavityD" },
    ]);
    await defineExpression(page, driver, panel, "postDropDown", [
      { type: "text", text: "-" },
      { type: "$", text: "$postDr", option: "postDrop" },
    ]);
    await defineExpression(page, driver, panel, "portCutIn", [
      { type: "text", text: "-" },
      { type: "$", text: "$portCu", option: "portCut" },
    ]);
    await defineExpression(page, driver, panel, "lidHang", [
      { type: "text", text: "-" },
      { type: "$", text: "$lidT", option: "lidT" },
    ]);
    await defineExpression(page, driver, panel, "caseDrop", [
      { type: "text", text: "-" },
      { type: "$", text: "$caseH", option: "caseH" },
    ]);
    await driver.humanClick(
      page.getByRole("button", { name: "Done", exact: true }),
    );
    await driver.dwell();

    await driver.step("stage");
    // The readouts must count the build alone: the demo plate steps
    // offstage through its tree eye (the applied chapter's discipline).
    // The display flag renders at the sketch round-trip inside the block
    // beat — the flag lands here, the pixels follow one dispatch later.
    await setBodyVisible(page, driver, "body|body_plate", false);
    await driver.dwell();

    // -- The block: the first bound footprint -------------------------------
    await driver.step("block");
    // Draw, square, PIN the near corner at the origin (a construction
    // point at (-10,-10) carries a literal place pair — the corner's
    // inflated diagonal then holds while the far corner absorbs every
    // span edit; the probe caught the unpinned rectangle sliding its
    // origin corner when BOTH spans moved), dimension both spans, and
    // BIND each dimension to its variable through the inspector's
    // `$`-autocomplete (Phase 26a): type the trigger, click the suggested
    // row, Apply — the inspector row renames to `distanceX $caseL` and
    // the sketch re-solves against the variable. The drawn geometry
    // equals the bound defaults, so nothing moves until a variable moves.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 74, 54);
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 37, 0);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, -10, -10);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, -10, -10);
    await clickDatumPoint(driver, 0.4, 0);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, -10, -10);
    await clickDatumPoint(driver, 0, 0.4);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0.4, 0);
    await clickDatumPoint(driver, 73.6, 0);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0.4);
    await clickDatumPoint(driver, 0, 53.6);
    // Rows: 0 horizontal, 1 placeX, 2 placeY, 3 spanX, 4 spanY.
    await bindSketchDimension(page, driver, 3, "$caseL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$caseW", "distanceY");
    await saveSketch(page, driver);
    // The feature rows gate on a sketch pool of two: the throwaway line.
    await saveThrowawayLine(page, driver, OCCT_ROOT);
    await draftDialog(page, driver, { ref: "caseDrop" }, "sketch 1");
    await expectVolume(page, BLOCK_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The cavity: one bound rectangle, one subtract ----------------------
    await driver.step("pocket-why");
    await driver.dwell();

    await driver.step("pocket");
    // The cavity is the board's own footprint at the wall inset: drawn,
    // squared, its PLACE pair bound to $wall and its SIZE pair bound to
    // $boardL/$boardW — the sketch itself reads the variables. One
    // anchored construction point at the origin carries the place pair.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 72, 52);
    await clickDatumPoint(driver, 2, 2);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 37, 2);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 2.4, 2);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 2, 2.4);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 2.4, 2);
    await clickDatumPoint(driver, 71.6, 2);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 2, 2.4);
    await clickDatumPoint(driver, 2, 51.6);
    // Rows: 0 horizontal, 1 placeX, 2 placeY, 3 spanX, 4 spanY.
    await bindSketchDimension(page, driver, 1, "$wall", "distanceX");
    await bindSketchDimension(page, driver, 2, "$wall", "distanceY");
    await bindSketchDimension(page, driver, 3, "$boardL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$boardW", "distanceY");
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "cavityDrop" }, "sketch 3");
    await expectVolume(page, BLOCK_VOLUME + CAVITY_VOLUME);
    await driver.dwell();

    // -- The subtract that empties the cavity -------------------------------
    await driver.step("subtract");
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 1, "drafted 1");
    await driver.humanClick(
      page
        .locator(DIALOG)
        .getByRole("checkbox", { name: "drafted 2", exact: true }),
    );
    const shelled = await createBoolean(page, driver);
    expect(
      volumeNear(shelled, SHELL_VOLUME),
      `the shell settled at ${String(shelled)}`,
    ).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The posts: four bound squares, unioned back fused ------------------
    await driver.step("posts");
    // Each post: a post-by-post square at a cavity corner, its size pair
    // bound to $post and its place pair bound to $wall (the near square,
    // at the wall corner) or $postFarX/$postFarY (the far three, at the
    // board's far corner minus a post). Extruded DOWN $cavityD and
    // unioned onto the shell in a chain — born fused, printed as one
    // body; every square re-places and re-sizes with the board.
    const posts: readonly {
      readonly corner: readonly [number, number];
      readonly placeX: string;
      readonly placeY: string;
    }[] = [
      { corner: [2, 2], placeX: "$wall", placeY: "$wall" },
      { corner: [68, 2], placeX: "$postFarX", placeY: "$wall" },
      { corner: [2, 48], placeX: "$wall", placeY: "$postFarY" },
      { corner: [68, 48], placeX: "$postFarX", placeY: "$postFarY" },
    ];
    let running = SHELL_VOLUME;
    let sketchNumber = 4;
    let draftedNumber = 3;
    let booleanNumber = 2;
    for (const post of posts) {
      const [x, y] = post.corner;
      await driver.enterSketchMode(OCCT_ROOT);
      await driver.activateSketchTool("rectangle");
      await clickDatumPoint(driver, x + 4, y + 4);
      await clickDatumPoint(driver, x, y);
      await driver.activateSketchTool("horizontal");
      await clickDatumPoint(driver, x + 2, y);
      await driver.activateSketchTool("point");
      await clickDatumPoint(driver, 0, 0);
      // The size pair: corner to corner, 0.4 inside the wanted endpoints.
      await driver.activateSketchTool("distanceX");
      await clickDatumPoint(driver, x + 0.4, y);
      await clickDatumPoint(driver, x + 3.6, y);
      await driver.activateSketchTool("distanceY");
      await clickDatumPoint(driver, x + 4, y + 0.4);
      await clickDatumPoint(driver, x + 4, y + 3.6);
      // The place pair pins the square's near corner to its variable
      // place — every square pinned, the near one at the wall corner.
      await driver.activateSketchTool("distanceX");
      await clickDatumPoint(driver, 0, 0);
      await clickDatumPoint(driver, x + 0.4, y);
      await driver.activateSketchTool("distanceY");
      await clickDatumPoint(driver, 0, 0);
      await clickDatumPoint(driver, x, y + 0.4);
      // Rows: 0 horizontal, 1 sizeX, 2 sizeY, 3 placeX, 4 placeY.
      await bindSketchDimension(page, driver, 1, "$post", "distanceX");
      await bindSketchDimension(page, driver, 2, "$post", "distanceY");
      await bindSketchDimension(page, driver, 3, post.placeX, "distanceX");
      await bindSketchDimension(page, driver, 4, post.placeY, "distanceY");
      await saveSketch(page, driver);
      await draftDialog(
        page,
        driver,
        { ref: "cavityDrop" },
        `sketch ${String(sketchNumber)}`,
      );
      running += POST_VOLUME;
      await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
      await pickComboboxOption(page, driver, 0, "Union (join)");
      await pickComboboxOption(
        page,
        driver,
        1,
        booleanNumber === 2
          ? "subtract 1"
          : `union ${String(booleanNumber - 1)}`,
      );
      await driver.humanClick(
        page.locator(DIALOG).getByRole("checkbox", {
          name: `drafted ${String(draftedNumber)}`,
          exact: true,
        }),
      );
      const united = await createBoolean(page, driver);
      expect(
        volumeNear(united, running),
        `post union ${String(booleanNumber)} settled at ${String(united)}`,
      ).toBe(true);
      sketchNumber += 1;
      draftedNumber += 1;
      booleanNumber += 1;
    }
    expect(
      running,
      "the post union chain's arithmetic must land on the taught number",
    ).toBeCloseTo(SHELL_POSTS_VOLUME, 3);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("posts-why");
    await driver.dwell();

    // -- The board-outline trim ---------------------------------------------
    await driver.step("trims");
    // ONE prism at the cavity's own bound numbers — the board's own
    // outline, place $wall/$wall and size $boardL/$boardW — extruded DOWN
    // $postDrop and subtracted once: it shears exactly the four posts'
    // tops, so they come out boardLift tall wherever the board moves.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 72, 52);
    await clickDatumPoint(driver, 2, 2);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 37, 2);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 2.4, 2);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 2, 2.4);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 2.4, 2);
    await clickDatumPoint(driver, 71.6, 2);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 2, 2.4);
    await clickDatumPoint(driver, 2, 51.6);
    await bindSketchDimension(page, driver, 1, "$wall", "distanceX");
    await bindSketchDimension(page, driver, 2, "$wall", "distanceY");
    await bindSketchDimension(page, driver, 3, "$boardL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$boardW", "distanceY");
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "postDropDown" }, "sketch 8");
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 1, "union 5");
    await driver.humanClick(
      page
        .locator(DIALOG)
        .getByRole("checkbox", { name: "drafted 7", exact: true }),
    );
    const trimmed = await createBoolean(page, driver);
    expect(
      volumeNear(trimmed, TRIMMED_VOLUME),
      `the board-outline trim settled at ${String(trimmed)}`,
    ).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The port: one face subtract, placed by variables --------------------
    await driver.step("port-why");
    await driver.dwell();

    await driver.step("port-face");
    // The view cube's LEFT face aims the -x wall; the face pick anchors
    // sketch-on-face; the datum frame's u/v ride the session's in-plane
    // rule (u = world Y, v = -world Z for a -x normal).
    await driver.humanClick(
      page.locator('[data-testid="view-cube-face-left"]'),
    );
    await driver.dwell(400);
    const portDatum = await sketchOnFrontFace(page, driver);
    await driver.dwell();

    await driver.step("port-cut");
    // The window: portW by portH centered at (portX, portZ) over the
    // floor — world z -23.1..-16.1 here, so the v coordinates (pointing
    // DOWN the world z axis) ride the datum origin. Arithmetic from the
    // var table: u = portX +/- portW/2; v = origin + cavityD - portZ -/+
    // portH/2.
    const portUMin = 35 - 5 - portDatum.origin[1];
    const portUMax = 35 + 5 - portDatum.origin[1];
    const portVLow = portDatum.origin[2] + 29.6 - 10 + 3.5;
    const portVHigh = portDatum.origin[2] + 29.6 - 10 - 3.5;
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, portUMin, portVHigh);
    await clickDatumPoint(driver, portUMax, portVLow);
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "portCutIn" }, "sketch 9");
    await expectVolume(page, TRIMMED_VOLUME + PORT_PRISM_VOLUME);
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 1, "subtract 6");
    await driver.humanClick(
      page
        .locator(DIALOG)
        .getByRole("checkbox", { name: "drafted 8", exact: true }),
    );
    const boxVolume = await createBoolean(page, driver);
    expect(
      volumeNear(boxVolume, BOX_VOLUME),
      `the box settled at ${String(boxVolume)}`,
    ).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("iso-read");
    await driver.humanClick(page.locator('[data-testid="view-iso"]'));
    await driver.dwell();

    // -- The payoff demos: the re-drives -------------------------------------
    await driver.step("demo-width");
    // The root moves 0.4 -> 0.5 through the manager's expression editor —
    // the commit that re-derives the whole DAG — and every depth, every
    // footprint, every post follows on the next dispatch: wall 2.5, post
    // 5 by 5, the case 75 by 55.
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await setVariableExpression(page, driver, panel, "lineWidth", "0.5mm");
    await driver.humanClick(
      page.getByRole("button", { name: "Done", exact: true }),
    );
    await expectVolume(page, DEMO_WIDTH_VOLUME, 90_000);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();
    // The return trip pins that it was the variable, not an accident.
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await setVariableExpression(page, driver, panel, "lineWidth", "0.4mm");
    await driver.humanClick(
      page.getByRole("button", { name: "Done", exact: true }),
    );
    await expectVolume(page, BOX_VOLUME);
    await driver.dwell();

    await driver.step("demo-board");
    // A different perfboard: 85 by 60. The bound sketches RE-SOLVE — the
    // block, the cavity, the posts, the trim all re-place and re-size —
    // the case visibly grows to 89 by 64, volume 52,253.6. The owner's
    // ask, delivered: set the board, the whole case follows. Then back
    // to 70 by 50, re-pinned.
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await setVariableExpression(page, driver, panel, "boardL", "85mm");
    await setVariableExpression(page, driver, panel, "boardW", "60mm");
    await driver.pointAtReadout(
      rowOf(page, panel, "caseL").getByText("= 89 mm", { exact: true }),
    );
    await driver.dwell();
    await driver.humanClick(
      page.getByRole("button", { name: "Done", exact: true }),
    );
    await expectVolume(page, DEMO_BOARD_VOLUME, 90_000);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await setVariableExpression(page, driver, panel, "boardL", "70mm");
    await setVariableExpression(page, driver, panel, "boardW", "50mm");
    await driver.humanClick(
      page.getByRole("button", { name: "Done", exact: true }),
    );
    await expectVolume(page, BOX_VOLUME);
    await driver.dwell();

    await driver.step("demo-header");
    // A taller header: boardLift 12.5, caseH 39.1 — the case deepens and
    // the posts grow with the dropped floor (postDrop reads boardT +
    // topClear - bottom: the rest plane's own invariant). Then back.
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await setVariableExpression(page, driver, panel, "header", "12mm");
    await driver.humanClick(
      page.getByRole("button", { name: "Done", exact: true }),
    );
    await expectVolume(page, DEMO_HEADER_VOLUME, 90_000);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await setVariableExpression(page, driver, panel, "header", "8.5mm");
    await driver.humanClick(
      page.getByRole("button", { name: "Done", exact: true }),
    );
    await expectVolume(page, BOX_VOLUME);
    await driver.dwell();

    // -- The lid: the doctrine's two rectangles, all `$` ---------------------
    await driver.step("lid-why");
    await driver.dwell();

    await driver.step("lid-plate");
    // The plate: the block's bound spans again — caseL and caseW — so
    // the lid's footprint is the case's footprint BY CONSTRUCTION, with
    // the same origin-side pin (the block's own recipe).
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 74, 54);
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 37, 0);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, -10, -10);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, -10, -10);
    await clickDatumPoint(driver, 0.4, 0);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, -10, -10);
    await clickDatumPoint(driver, 0, 0.4);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0.4, 0);
    await clickDatumPoint(driver, 73.6, 0);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0.4);
    await clickDatumPoint(driver, 0, 53.6);
    // Rows: 0 horizontal, 1 placeX, 2 placeY, 3 spanX, 4 spanY.
    await bindSketchDimension(page, driver, 3, "$caseL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$caseW", "distanceY");
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "lidT" }, "sketch 10");
    await expectVolume(page, BOX_VOLUME + PLATE_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("lid-lip");
    // The lip hangs INTO the opening: board minus the clearance, placed
    // at the wall-plus-half-clearance inset — every number a variable —
    // extruded DOWN lidT from the same bed plane.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 71.75, 51.75);
    await clickDatumPoint(driver, 2.25, 2.25);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 37, 2.25);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 2.65, 2.25);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 2.25, 2.65);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 2.65, 2.25);
    await clickDatumPoint(driver, 71.35, 2.25);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 2.25, 2.65);
    await clickDatumPoint(driver, 2.25, 51.35);
    // Rows: 0 horizontal, 1 placeX, 2 placeY, 3 spanX, 4 spanY.
    await bindSketchDimension(page, driver, 1, "$lipInset", "distanceX");
    await bindSketchDimension(page, driver, 2, "$lipInset", "distanceY");
    await bindSketchDimension(page, driver, 3, "$lipL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$lipW", "distanceY");
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "lidHang" }, "sketch 11");
    await expectVolume(page, BOX_VOLUME + LID_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The STLs that go to the bed ----------------------------------------
    await driver.step("box-scope");
    // The lid's two bodies step aside through their tree eyes: the scene
    // is the box alone, and the export carries what renders.
    await setBodyVisible(page, driver, "body|body_extrude9", false);
    await setBodyVisible(page, driver, "body|body_extrude10", false);
    await driver.dwell();

    await driver.step("export-box");
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    await runStlExport(page, driver, BOX_VOLUME, PLANAR_VOLUME_FLOOR, {
      min: [0, 0, -35.6],
      max: [74, 54, 0],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    await driver.dwell();

    await driver.step("lid-scope");
    // The opposite file: the box steps aside, the lid steps back.
    await setBodyVisible(page, driver, "body|body_extrude9", true);
    await setBodyVisible(page, driver, "body|body_extrude10", true);
    for (const key of [...EXTRUDE_KEYS, ...BOOLEAN_KEYS]) {
      await setBodyVisible(page, driver, key, false);
    }
    await driver.dwell();

    await driver.step("export-lid");
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    await runStlExport(page, driver, LID_VOLUME, PLANAR_VOLUME_FLOOR, {
      min: [0, 0, -6],
      max: [74, 54, 6],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    for (const key of [...EXTRUDE_KEYS, ...BOOLEAN_KEYS]) {
      await setBodyVisible(page, driver, key, true);
    }
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};

// ---------------------------------------------------------------------------
// The chapter's local verbs
// ---------------------------------------------------------------------------

/** The management row of one variable, matched by its exact name text. */
function rowOf(
  page: Page,
  panel: ReturnType<Page["locator"]>,
  name: string,
): ReturnType<Page["locator"]> {
  return panel
    .locator('[data-slot="cad-parameter-row"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}

/**
 * Creates one literal variable through the manager's create form (the
 * `$`-autocomplete's source: every created name joins the vocabulary).
 */
async function createVariable(
  page: Page,
  driver: TutorialDriver,
  panel: ReturnType<Page["locator"]>,
  name: string,
  value: string,
): Promise<void> {
  await fillLabeledField(
    page,
    driver,
    panel.getByLabel("Name", { exact: true }),
    name,
  );
  await fillLabeledField(
    page,
    driver,
    panel.getByLabel("Value", { exact: true }),
    value,
  );
  await driver.humanClick(
    panel.getByRole("button", { name: "Create variable" }),
  );
  await expect(rowOf(page, panel, name)).toBeVisible();
}

/** One fragment of an expression build: typed text or an autocomplete pick. */
type ExpressionFragment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "$"; readonly text: string; readonly option: string };

/**
 * Defines one variable's expression through the row's Set-expression
 * editor, building the text fragment by fragment so the `$`-autocomplete
 * clicks happen on camera: type the trigger, click the suggested row (the
 * bare identifier inserts), keep typing. Applies and waits for the editor
 * to close — the commit that re-derives the dependents.
 */
async function defineExpression(
  page: Page,
  driver: TutorialDriver,
  panel: ReturnType<Page["locator"]>,
  name: string,
  fragments: readonly ExpressionFragment[],
): Promise<void> {
  const row = rowOf(page, panel, name);
  await driver.humanClick(row.getByRole("button", { name: "Set expression" }));
  const editor = panel.getByLabel(name, { exact: true });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  for (const fragment of fragments) {
    if (fragment.type === "text") {
      await page.keyboard.type(fragment.text);
      continue;
    }
    await page.keyboard.type(fragment.text);
    await driver.humanClick(
      panel.getByRole("option", { name: `$${fragment.option}`, exact: true }),
    );
  }
  await driver.humanClick(row.getByRole("button", { name: "Apply" }));
  await expect(editor).toHaveCount(0);
}

/**
 * Edits an existing variable's expression to a new constant (the demos'
 * re-drive): the Set/Edit-expression editor is the commit that re-derives
 * the whole DAG — the panel's literal edit is the value-only arm the
 * features never re-read (the probe's own finding, narrated honestly).
 */
async function setVariableExpression(
  page: Page,
  driver: TutorialDriver,
  panel: ReturnType<Page["locator"]>,
  name: string,
  value: string,
): Promise<void> {
  const row = rowOf(page, panel, name);
  const setButton = row.getByRole("button", { name: "Set expression" });
  const editButton = row.getByRole("button", { name: "Edit expression" });
  if ((await setButton.count()) > 0) {
    await driver.humanClick(setButton);
  } else {
    await driver.humanClick(editButton);
  }
  const editor = panel.getByLabel(name, { exact: true });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(value);
  await driver.humanClick(row.getByRole("button", { name: "Apply" }));
  await expect(editor).toHaveCount(0);
}

/**
 * Binds one sketch dimension to a variable through the sketch inspector —
 * Phase 26a's flow, on camera: select the constraint's row, clear the
 * field BLIND (right after an Apply the next constraint's field can mount
 * stale-empty — the probe's finding), type the `$` trigger (the target
 * name's first three letters — the exact-name click below picks the row
 * out of whatever else the prefix lists), click the suggested parameter
 * row, Apply. The commit is the BOUND `sketch.dimension.set` (a
 * parameterId, no value) and the inspector row renames to
 * `distanceX $caseL` — the assertion below pins exactly that.
 */
async function bindSketchDimension(
  page: Page,
  driver: TutorialDriver,
  rowIndex: number,
  option: string,
  kind: "distanceX" | "distanceY",
): Promise<void> {
  const row = page.locator("[data-sketch-constraint-id]").nth(rowIndex);
  if ((await row.getAttribute("aria-pressed")) !== "true") {
    await driver.humanClick(row);
  }
  const field = page.getByLabel("Dimension (mm)");
  await driver.humanClick(field);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`$${option.slice(1, 4)}`);
  await driver.humanClick(
    page.getByRole("option", { name: option, exact: true }),
  );
  await expect(field).toHaveValue(option);
  await driver.humanClick(
    page.locator(`${SKETCH} form`).getByRole("button", { name: "Apply" }),
  );
  await expect(
    page
      .locator(`${SKETCH} [data-slot="cad-sketch-inspector"]`)
      .getByText(`${kind} ${option}`),
  ).toBeVisible();
}

/** Saves the open sketch as a standalone record and returns to model mode. */
async function saveSketch(page: Page, driver: TutorialDriver): Promise<void> {
  await driver.humanClick(page.locator('[data-testid="sketch-save"]'));
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-sketch-mode",
    "model",
  );
}

/** The one-line throwaway that unlocks the pool-gated feature rows. */
async function saveThrowawayLine(
  page: Page,
  driver: TutorialDriver,
  rootId: string,
): Promise<void> {
  await driver.enterSketchMode(rootId);
  await driver.activateSketchTool("line");
  await clickDatumPoint(driver, 40, 40);
  await clickDatumPoint(driver, 45, 45);
  await saveSketch(page, driver);
}

/**
 * One sketch point, ALWAYS through the pinned pick: the locator click's
 * position is ELEMENT-relative, so a mid-drawing layout shift (the
 * toolbar's own scrollIntoView nudging the surface's container) can never
 * move the landing point — the viewport-absolute plain click's guard
 * caught exactly that during the probe runs. The glide still teaches
 * where the point lives.
 */
async function clickDatumPoint(
  driver: TutorialDriver,
  u: number,
  v: number,
): Promise<void> {
  await driver.pickPinnedCanvasPoint(u, v);
}

/**
 * Opens the draft dialog on one saved sketch, fills the Distance with a
 * `$name` reference (autocomplete click on camera), zeroes the taper,
 * and Creates — returning the settled scene volume. Downward extrudes
 * reference the chapter's SIGNED helper variables: the field's token
 * grammar is a bare `$name` (anchored both ends — no `-$name`), which is
 * why the sign lives in the variable system with everything else.
 */
async function draftDialog(
  page: Page,
  driver: TutorialDriver,
  distance: { readonly ref: string },
  sketchName: string,
): Promise<string> {
  await openFeatureDialog(page, driver, OCCT_ROOT, "draft");
  await pickComboboxOption(page, driver, 0, sketchName);
  const field = page.getByLabel("Distance (mm)");
  await driver.humanClick(field);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`$${distance.ref.slice(0, 3)}`);
  await driver.humanClick(
    page.getByRole("option", { name: `$${distance.ref}`, exact: true }),
  );
  await expect(field).toHaveValue(`$${distance.ref}`);
  await fillLabeledField(
    page,
    driver,
    page.getByLabel("Draft taper (deg)"),
    "0",
  );
  const before = await dispatchedCount(page, OCCT_ROOT);
  await driver.humanClick(
    page.locator(DIALOG).getByRole("button", { name: "Create" }),
  );
  await expect(page.locator(DIALOG)).toBeHidden();
  return waitForRootSettle(page, OCCT_ROOT, { afterDispatch: before });
}

/** The dispatched-count read the settle anchors ride. */
async function dispatchedCount(page: Page, rootId: string): Promise<number> {
  const raw =
    (await page.locator(`#${rootId}`).getAttribute("data-dispatched")) ?? "0";
  return Number(raw);
}

/**
 * Submits the open boolean dialog and waits for the settled scene — the
 * subtract/union chain's one verb (the Create click rides the driver).
 */
async function createBoolean(
  page: Page,
  driver: TutorialDriver,
): Promise<number> {
  const before = await dispatchedCount(page, OCCT_ROOT);
  await driver.humanClick(
    page.locator(DIALOG).getByRole("button", { name: "Create" }),
  );
  await expect(page.locator(DIALOG)).toBeHidden();
  return Number(
    await waitForRootSettle(page, OCCT_ROOT, { afterDispatch: before }),
  );
}

/** The settled scene volume the workbench root publishes. */
async function renderedVolume(page: Page): Promise<string> {
  return (
    (await page
      .locator(`#${OCCT_ROOT}`)
      .getAttribute("data-cad-rendered-volume")) ?? "0"
  );
}

/**
 * Waits until the settled scene volume pins `expected` (the house 0.5%
 * band) — the wait's real predicate, never a counter anchor. A full-DAG
 * re-drive (the demos re-execute every feature) legitimately takes longer
 * than one build step: `timeoutMs` rises for those beats. A timeout fails
 * LOUD with the last measured volume, never a bare boolean.
 */
async function expectVolume(
  page: Page,
  expected: number,
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const measured = Number(await renderedVolume(page));
        return volumeNear(measured, expected)
          ? "in-band"
          : `off-band: ${measured.toFixed(1)} against ${expected.toFixed(1)}`;
      },
      {
        timeout: timeoutMs,
      },
    )
    .toBe("in-band");
}

/** The datum plane marker the sketch-on-face command booted the sketch on. */
interface DatumPlane {
  readonly origin: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}

/**
 * Sketch-on-face on the FRONT WALL's outer face (the -x face of the
 * running shell). The left view is already aimed: the pick ray through
 * the face's own anchor hits that face first, and the resolved datum's
 * normal (pinned ~[-1,0,0], loud on any other face) is the proof. The
 * resolved frame rides back: the window's canvas points offset from ITS
 * origin, wherever the kernel's mesh put the anchor.
 */
async function sketchOnFrontFace(
  page: Page,
  driver: TutorialDriver,
): Promise<DatumPlane> {
  const anchors = await readFaceAnchors(page, OCCT_ROOT);
  const candidates = Object.entries(anchors)
    .filter(([key, anchor]) => {
      if (!key.startsWith("body_boolean6/")) return false;
      if (anchor.normal === null) return false;
      return (
        Math.abs(anchor.normal[0] + 1) <= 0.05 &&
        Math.abs(anchor.normal[1]) <= 0.05 &&
        Math.abs(anchor.normal[2]) <= 0.05
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));
  if (candidates.length === 0) {
    throw new Error(
      `no -x face anchor on the trimmed shell in [${Object.keys(anchors).join(", ")}]`,
    );
  }
  const canvas = await page
    .locator(`#${VIEWPORT_COMPLETE} canvas`)
    .boundingBox();
  if (canvas === null) throw new Error("the viewport canvas never mounted");
  let picked = "";
  for (const [, anchor] of candidates) {
    if (picked !== "") break;
    await driver.humanClick({
      x: canvas.x + anchor.point[0],
      y: canvas.y + anchor.point[1],
    });
    picked =
      (await page
        .locator(`#${OCCT_ROOT}`)
        .getAttribute("data-selection-key")) ?? "";
  }
  expect(picked).toMatch(/^face\|body_boolean6\|\d+\|\d+$/);
  await driver.openCommandMenu(OCCT_ROOT);
  await driver.clickCommandRow(OCCT_ROOT, "sketch-on-face");
  await expect
    .poll(
      async () =>
        (await page.locator(`#${OCCT_ROOT}`).getAttribute("data-datums")) ?? "",
      { timeout: 15_000 },
    )
    .toContain('"resolved":true');
  const raw = JSON.parse(
    (await page.locator(`#${OCCT_ROOT}`).getAttribute("data-datums")) ?? "[]",
  ) as readonly {
    readonly origin?: readonly [number, number, number];
    readonly normal?: readonly [number, number, number];
  }[];
  const last = raw[raw.length - 1];
  if (
    last === undefined ||
    last.origin === undefined ||
    last.normal === undefined
  ) {
    throw new Error(
      `the datum surface holds no resolved plane: ${JSON.stringify(raw)}`,
    );
  }
  expect(
    last.normal[0],
    `the front-face datum resolved normal ${JSON.stringify(last.normal)} — the pick ate the wrong face`,
  ).toBeLessThan(-0.9);
  return { origin: last.origin, normal: last.normal };
}

/**
 * Toggles one body's visibility through its model-tree row's eye — the
 * display control the document scene hands the user (the applied
 * chapter's helper, pointer-first).
 */
async function setBodyVisible(
  page: Page,
  driver: TutorialDriver,
  bodyKey: string,
  visible: boolean,
): Promise<void> {
  const row = page.locator(
    `[data-slot="cad-model-tree"] [data-node-key="${bodyKey}"]`,
  );
  const eye = row.locator("[data-cad-tree-body-visibility]");
  const expected = visible ? "visible" : "hidden";
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (box === null) throw new Error(`the tree row "${bodyKey}" has no box`);
  const yOffset = Math.min(12, box.height / 2);
  await driver.humanPoint({ x: box.x + 40, y: box.y + yOffset });
  await eye.click();
  await expect(eye).toHaveAttribute("data-cad-tree-body-visibility", expected);
}

/** The world-frame bounds a downloaded mesh must span. */
interface ExpectedMeshBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * The binary STL's axis-aligned vertex bounds (float32-quantized world
 * millimetres).
 */
function binaryStlBounds(bytes: Buffer): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const triangles = bytes.readUInt32LE(80);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < triangles; index += 1) {
    const base = 84 + index * 50 + 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const at = base + corner * 12;
      const x = bytes.readFloatLE(at);
      const y = bytes.readFloatLE(at + 4);
      const z = bytes.readFloatLE(at + 8);
      min[0] = Math.min(min[0], x);
      max[0] = Math.max(max[0], x);
      min[1] = Math.min(min[1], y);
      max[1] = Math.max(max[1], y);
      min[2] = Math.min(min[2], z);
      max[2] = Math.max(max[2], z);
    }
  }
  return { min, max };
}

/**
 * The binary STL's solid volume: the signed tetrahedra of every facet
 * from the origin (the divergence theorem over the triangle soup).
 */
function binaryStlVolume(bytes: Buffer): number {
  const triangles = bytes.readUInt32LE(80);
  let volume = 0;
  for (let index = 0; index < triangles; index += 1) {
    const base = 84 + index * 50 + 12;
    const ax = bytes.readFloatLE(base);
    const ay = bytes.readFloatLE(base + 4);
    const az = bytes.readFloatLE(base + 8);
    const bx = bytes.readFloatLE(base + 12);
    const by = bytes.readFloatLE(base + 16);
    const bz = bytes.readFloatLE(base + 20);
    const cx = bytes.readFloatLE(base + 24);
    const cy = bytes.readFloatLE(base + 28);
    const cz = bytes.readFloatLE(base + 32);
    volume +=
      (ax * (by * cz - bz * cy) +
        ay * (bz * cx - bx * cz) +
        az * (bx * cy - by * cx)) /
      6;
  }
  return Math.abs(volume);
}

/**
 * Runs the open export dialog's STL row and verifies the download is a
 * real binary STL whose own triangles measure `expectedVolume` inside a
 * `floorRatio` band under the analytic number, and whose vertices span
 * the taught world bounds. Leaves the dialog OPEN.
 */
async function runStlExport(
  page: Page,
  driver: TutorialDriver,
  expectedVolume: number,
  floorRatio: number,
  expectedBounds: ExpectedMeshBounds,
): Promise<void> {
  await driver.humanClick(page.getByTestId("cad-export-run-stl"));
  const entry = page.locator('[data-cad-export-entry="stl"]');
  await expect(entry).toContainText("triangles");
  const held = JSON.parse(
    (await page.locator(`#${OCCT_ROOT}`).getAttribute("data-export-held")) ??
      "{}",
  ) as Record<string, number>;
  if (held.stl === undefined) {
    throw new Error("the STL export held no bytes");
  }
  expect(
    held.stl,
    "the STL export must hold real, sized bytes",
  ).toBeGreaterThan(0);
  const downloads = await collectDownloads(
    page,
    () => driver.humanClick(page.getByTestId("cad-export-download-stl")),
    1,
    15_000,
  );
  const stlPath = await downloads[0]?.path();
  if (stlPath === undefined) {
    throw new Error("the STL export did not land");
  }
  const bytes = await readFile(stlPath);
  const triangles = bytes.readUInt32LE(80);
  expect(
    bytes.length,
    "a binary STL is the 84-byte head plus 50 bytes per triangle",
  ).toBe(84 + 50 * triangles);
  const meshVolume = binaryStlVolume(bytes);
  expect(
    meshVolume,
    `the downloaded mesh measures ${meshVolume.toFixed(2)} mm³ against ${expectedVolume.toFixed(2)}`,
  ).toBeGreaterThanOrEqual(expectedVolume * floorRatio);
  expect(meshVolume).toBeLessThanOrEqual(expectedVolume * 1.001);
  const { min, max } = binaryStlBounds(bytes);
  for (const axis of [0, 1, 2] as const) {
    expect(
      min[axis],
      `mesh min axis ${axis} at ${min[axis].toFixed(4)}`,
    ).toBeGreaterThanOrEqual(expectedBounds.min[axis] - 0.01);
    expect(
      min[axis],
      `mesh min axis ${axis} at ${min[axis].toFixed(4)}`,
    ).toBeLessThanOrEqual(expectedBounds.min[axis] + 0.01);
    expect(
      max[axis],
      `mesh max axis ${axis} at ${max[axis].toFixed(4)}`,
    ).toBeGreaterThanOrEqual(expectedBounds.max[axis] - 0.01);
    expect(
      max[axis],
      `mesh max axis ${axis} at ${max[axis].toFixed(4)}`,
    ).toBeLessThanOrEqual(expectedBounds.max[axis] + 0.01);
  }
}

/** Closes the export dialog with the same Escape the dialog owns. */
async function closeExportDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-export-dialog-open",
    "false",
  );
}
