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
// the print line width; the owner's print logic — walls two lines (two
// perimeters), the corner ribs two lines, floor and lid three lines — and
// the board's socketing stack (pin header + board thickness + the lift
// gap) do the rest. EVERY multiple reads lineWidth DIRECTLY (the owner's
// correction: nothing chains through the wall any more, and the old
// wallCount indirection is gone — the wall is two perimeters outright):
//
//   lineWidth   0.4 mm   the root — one printed line
//   wall        := 2 * lineWidth                  = 0.8 mm
//   post        := 2 * lineWidth                  = 0.8 mm  (the rib width)
//   bottom      := 3 * lineWidth                  = 1.2 mm
//   lidT        := 3 * lineWidth                  = 1.2 mm
//   boardL      70 mm    the perfboard, 5 by 7 cm
//   boardW      50 mm
//   header      8.5 mm   the pin header under the board
//   boardT      1.6 mm   the board itself
//   gapUnder    0.5 mm   the socketing clearance
//   boardLift   := header + gapUnder              = 9 mm
//   topClear    25 mm    the components above the board
//   caseH       := boardLift + boardT + topClear  = 35.6 mm
//   caseL       := boardL + 2 * wall              = 71.6 mm
//   caseW       := boardW + 2 * wall              = 51.6 mm
//   portX       35 mm    the connector's place along the front face
//   portW       10 mm    the window's width
//   portH       7 mm     the window's height
//   portOffset  1 mm     centers the window on the connector
//   portZ       := boardLift + portOffset         = 10 mm
//   lidClear    0.5 mm   the lid lip's slide clearance (total)
//   cavityD     := caseH - bottom                 = 34.4 mm
//   portCut     := wall + 1mm                     = 1.8 mm
//   postDrop    := cavityD - boardLift            = 25.4 mm
//   reach       6 mm     the rib's diagonal reach (a design literal,
//                        the portX class: set once, referenced everywhere)
//   halfTurn    180 deg  the duplicate's rotation — half a circle about z
//                        (an angle-dimensioned literal, the reach class)
//   ribStepX    := -caseL                         = -71.6 mm
//   ribStepY    := -caseW                         = -51.6 mm
//   postNearX   := caseL - lineWidth              = 71.2 mm
//   postNearY   := caseW - lineWidth              = 51.2 mm
//   postIn      := lineWidth + reach              = 6.4 mm
//   postFarX    := caseL - lineWidth - reach      = 65.2 mm
//   postFarY    := caseW - lineWidth - reach      = 45.2 mm
//   lipL        := boardL - lidClear              = 69.5 mm
//   lipW        := boardW - lidClear              = 49.5 mm
//   lipInset    := wall + lidClear / 2            = 1.05 mm
//   The DIALOG grammar also admits a negated token (`-$name`, Phase 30 —
//   the sign rides the reference and the negation is re-derived through an
//   expression parameter), so the signed helpers below are now a CHOICE,
//   not a workaround: naming the sign keeps it a variable like everything
//   else, visible and re-drivable in the manager:
//   cavityDrop  := -cavityD                       = -34.4 mm
//   postDropDown := -postDrop                     = -25.4 mm
//   portCutIn   := -portCut                       = -1.8 mm
//   lidHang     := -lidT                          = -1.2 mm
//   caseDrop    := -caseH                         = -35.6 mm
//
// ## The build, and what the probes taught
//
// 1. THE FRAME. The bed plane is the case's OPENING RIM (z = 0); the whole
//    case hangs below it — the applied-iot-case teaching frame. The block
//    is the footprint extruded DOWN $caseDrop; the cavity tool is a bed
//    sketch too, extruded DOWN $cavityDrop.
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
// 3. THE POSTS ARE DIAGONAL RIBS, TWO DRAWN AND ONE TURN. The owner's
//    correction: the corner posts are THIN DIAGONAL BRACES — two line
//    widths wide, running at 45° across the corner with both ends buried
//    in the two walls (fused, printed with the shell) — and, the owner's
//    order for this re-recording: the braces come from ONE DRAWING plus
//    the Duplicate & transform staple, not four repeated sketches. The
//    probe's shape is the sketcher's straight slot: ONE closed entity —
//    two cap centers and a radius — so the extrudable profile needs no
//    chained-line welds, and the slot exposes its cap centers as point
//    targets and its DIAMETER as the taught width. Five dimensions per
//    rib sketch, every one `$`-bound through the inspector, BOTH cap
//    centers pinned ABSOLUTELY off the origin point: the near cap center
//    reads ($lineWidth, $lineWidth) at the origin corner — the round end
//    lands flush against the two outer faces, wholly inside the wall
//    corner — or ($postNearX, $lineWidth) at the x-far corner, and the
//    far cap center reads $postIn or $postFarX/$postIn — the 45° held
//    by the solved places themselves (|Δx| = |Δy| falls out of lineWidth
//    + reach against caseL − lineWidth − reach). The first draft pinned
//    the far cap with a magnitude reach pair (|Δx| = |Δy| = $reach) and
//    the trim beat's re-solve flipped its signs — the ribs bloomed 6 mm
//    past the case — so magnitude dimensions never carry a direction:
//    place both ends.
// 4. THE DUPLICATE IS THE STAPLE, AND THE GEOMETRY FIXES ITS SHAPE. The
//    four corners of a RECTANGULAR case are one half-turn orbit split in
//    two: a 90° z-step swaps the footprint's x/y extents (71.6 against
//    51.6 — copy 2 would always land off the case; hand-derived, no
//    single (d, 90°) step walks one rib around a rectangle), so ONE rib
//    turned can only ever reach its diagonal twin. Each brace is
//    therefore DRAWN ONCE and turned onto its far corner by ITS OWN
//    Duplicate & transform — the owner's "draw one, duplicate with
//    rotation", applied once per diagonal orientation (45° and 135°).
//    The sources are the EXTRUDED braces: the probe caught a
//    boolean-sourced duplicate's copy rendering displaced, while an
//    extrude-sourced copy rides its own derivation and lands exactly.
//    The step transform is T(p) = R(p + d) — translate
//    first, then the rotation about the WORLD axis through the ORIGIN,
//    which this corner-anchored frame pins at the case's own min corner
//    — so the step carries the case's own diagonal while it turns:
//    ribStepX := -caseL, ribStepY := -caseW (the Phase-30 signed-helper
//    route; the dialog grammar's `-$name` would also ride, but the named
//    variable keeps the carry visible and re-drivable in the manager),
//    half a circle about z ($halfTurn, an angle literal), one copy.
//    Hand-derived landings — R is (x, y, z) ↦ (−x, −y, z), so
//    T(p) = (caseL − px, caseW − py, pz):
//      brace 1 near (0.4, 0.4)  → (71.2, 51.2)  = the far corner's near cap
//      brace 1 far  (6.4, 6.4)  → (65.2, 45.2)  = its far cap
//      brace 2 near (71.2, 0.4) → (0.4, 51.2)   = the y-far corner's near cap
//      brace 2 far  (65.2, 6.4) → (6.4, 45.2)   = its far cap
//    exactly the two missing braces, each diagonal FLIPPED by the turn —
//    the work no translation can do, and the reason the staple is a
//    rotation here. The volume ledger proves the landings: a brace in
//    open air would add its full stadium; only the corner-correct copies
//    add the open-cavity part the pins below encode.
// 5. THE TRIM IS THE BOARD'S OWN OUTLINE. One bed rectangle at the
//    cavity's own bound numbers — place $wall/$wall, size
//    $boardL/$boardW — extruded DOWN $postDropDown and subtracted once:
//    it shears exactly the four ribs' open-cavity tops, so they come out
//    boardLift tall wherever the board moves them. The wall-band ends
//    need no trim — they fuse into solid wall, full height, invisibly.
// 6. EVERY DEPTH IS A $ NAME. The draft dialog's Distance fields take
//    `$name` references with the clickable autocomplete (Phase 21), and a
//    referenced parameter is re-read on every dispatch. The chapter's
//    extrudes ride the signed helpers — $caseDrop once, $cavityDrop
//    three times (the cavity tool and the two braces), $postDropDown,
//    $portCutIn — and $lidT upward for the plate; so the payoff demos
//    re-drive real geometry. The duplicate's fields ride the same
//    autocomplete — $ribStepX, $ribStepY, $halfTurn — and the duplicate
//    feature re-executes on every dispatch, so the demos' re-drives turn
//    the copies too.
// 7. THE EDIT THAT RE-DERIVES IS THE EXPRESSION COMMIT. Probed: the
//    panel's literal edit is the value-only arm ("the cached value moves,
//    nothing is recomputed") — features referencing DERIVED variables read
//    the stale cache. The manager's expression editor (a constant is a
//    legal expression) is the commit that runs the topological recompute;
//    the demos edit the roots THERE, and the whole DAG follows.
// 8. THE PORT IS ONE FACE SUBTRACT. The hole dialog takes no `$` (probed),
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
//   The ribs' new material is only the slot's OPEN-CAVITY part — the
//   wall-band ends fuse into material that is already solid. At cap
//   radius r = lineWidth and centerline L = reach·√2 (the duplicate
//   re-recording changed how the four ribs are AUTHORED — two drawn,
//   two turned — not what they ARE: the copies land exactly on the
//   previously drawn third and fourth braces, so every number below is
//   unchanged; volume is placement-invariant):
//   A(r) = 2rL − (2√2+1)·r² + πr²/2
//          (corner clip pair; the far cap's OUTER half-disc — its near
//          half is inside the body rectangle, and the start cap's outer
//          half is buried in the wall corner)
//   A(0.4) = 6.427004;  A(0.5) = 7.920874
//
//   block            71.6 * 51.6 * 35.6        = 131,526.336
//   cavity tool      70 * 50 * 34.4            = 120,400
//   shell            131,526.336 - 120,400     =  11,126.336
//   each rib union   +6.427004 * 34.4          =  +221.089 (x4)
//   shell + ribs                               =  12,010.692
//   trim cut         -6.427004 * 25.4          =   -163.246 (x4)
//   trimmed                                    =  11,357.708
//   port prism       10 * 7 * 1.8              =     126   (body on stage)
//   port cut         0.8 * 10 * 7              =     -56
//   THE BOX                                    =  11,301.708
//   lid plate        71.6 * 51.6 * 1.2         =   4,433.472
//   lid lip          69.5 * 49.5 * 1.2         =   4,128.3
//   THE LID                                    =   8,561.772
//   box bounds   [0,0,-35.6]..[71.6,51.6,0]; lid bounds [0,0,-1.2]..[71.6,51.6,1.2]
//
//   demo 1 (lineWidth 0.5): wall 1, post 1, bottom/lidT 1.5, caseL 72,
//     caseW 52, cavityD 34.1, postDrop 25.1, portCut 2 — EVERYTHING
//     scales, the thin parts included (the ribs' round ends stay flush):
//     A(0.5): 133,286.4 - 119,350 + 4·270.102 - 4·198.814 - 70
//     = 14,151.551
//   demo 2 (board 85 by 60): caseL 86.6, caseW 61.6 — THE CASE MOVES and
//     the ribs follow ($postNearX/$postNearY/$postFarX/$postFarY
//     re-derive): 189,910.336 - 175,440 + 884.357 - 652.985 - 56
//     = 14,645.708. Then back to 70 by 50, re-pinned at 11,301.708.
//   demo 3 (header 12): boardLift 12.5, caseH 39.1, cavityD 37.9,
//     postDrop = boardT + topClear - bottom = 25.4 (the rest-plane
//     invariant — the floor drops with the stack, the ribs grow):
//     144,457.296 - 132,650 + 4·243.584 - 652.985 - 56 = 12,072.646

/**
 * The diagonal rib's new-material plan area at cap radius `r`: the slot's
 * body rectangle (2r wide, the reach·√2 centerline) less the corner-clip
 * pair the cavity's open quadrant cuts ((2√2+1)·r²), plus the far cap's
 * OUTER half-disc (πr²/2 — the cap's near half is already inside the body
 * rectangle, and the start cap's outer half is buried in the wall
 * corner). The chain repro walked this area out of the kernel exactly.
 */
function stripArea(r: number): number {
  return (
    2 * r * (6 * Math.SQRT2) -
    (2 * Math.SQRT2 + 1) * r * r +
    (Math.PI * r * r) / 2
  );
}

/** The block: the full footprint, 35.6 tall, extruded below the bed. */
const BLOCK_VOLUME = 71.6 * 51.6 * 35.6;
/** The cavity tool: the board's own footprint, wall-inset, cavityD deep. */
const CAVITY_VOLUME = 70 * 50 * 34.4;
/** The shell after the cavity subtract: walls and floor, no ribs. */
const SHELL_VOLUME = BLOCK_VOLUME - CAVITY_VOLUME;
/** One rib's union: the open-cavity stadium area, the cavity's full depth. */
const STRIP_UNION_VOLUME = stripArea(0.4) * 34.4;
/**
 * One brace's own EXTRUDED body: the full stadium prism (2r·L body
 * rectangle plus the πr² cap pair), cavity deep. The open-cavity part of
 * that area only materializes at the big union — a drafted brace on the
 * stage adds its whole stadium, wall-buried halves and all.
 */
const STRIP_BODY_VOLUME =
  (2 * 0.4 * (6 * Math.SQRT2) + Math.PI * 0.4 * 0.4) * 34.4;
/** The shell with its four diagonal ribs unioned back on. */
const SHELL_POSTS_VOLUME = SHELL_VOLUME + 4 * STRIP_UNION_VOLUME;
/** The open-cavity material one trim prism cuts from one rib. */
const STRIP_TRIM_VOLUME = stripArea(0.4) * 25.4;
/** The case after the board-outline trim: boardLift-tall ribs. */
const TRIMMED_VOLUME = SHELL_POSTS_VOLUME - 4 * STRIP_TRIM_VOLUME;
/** The port prism: portW by portH by portCut, overshooting into air. */
const PORT_PRISM_VOLUME = 10 * 7 * 1.8;
/** The wall the port cut removes: wall thickness by the window. */
const PORT_CUT_VOLUME = 0.8 * 10 * 7;
/** The box file: the trimmed case with its USB window. */
const BOX_VOLUME = TRIMMED_VOLUME - PORT_CUT_VOLUME;
/** The lid's plate: the full footprint, lidT thick. */
const PLATE_VOLUME = 71.6 * 51.6 * 1.2;
/** The lid's lip: board minus the clearance, hanging lidT down. */
const LIP_VOLUME = 69.5 * 49.5 * 1.2;
/** The lid file: plate + lip. */
const LID_VOLUME = PLATE_VOLUME + LIP_VOLUME;
/** The boot demo plate's volume (30 x 20 x 10 with the diameter-8 bore). */
const BOOT_PLATE_VOLUME = 30 * 20 * 10 - Math.PI * 16 * 10;
/** Demo 1 (lineWidth 0.5): the whole chain re-derived, ribs included. */
const DEMO_WIDTH_VOLUME =
  72 * 52 * 35.6 -
  70 * 50 * 34.1 +
  4 * (stripArea(0.5) * 34.1) -
  4 * (stripArea(0.5) * 25.1) -
  1.0 * 10 * 7;
/** Demo 2 (board 85 by 60): the bound sketches re-solve; the case MOVES. */
const DEMO_BOARD_VOLUME =
  86.6 * 61.6 * 35.6 -
  85 * 60 * 34.4 +
  4 * STRIP_UNION_VOLUME -
  4 * STRIP_TRIM_VOLUME -
  PORT_CUT_VOLUME;
/** Demo 3 (header 12): the deeper case, ribs grown with the dropped floor. */
const DEMO_HEADER_VOLUME =
  71.6 * 51.6 * 39.1 -
  70 * 50 * 37.9 +
  4 * (stripArea(0.4) * 37.9) -
  4 * STRIP_TRIM_VOLUME -
  PORT_CUT_VOLUME;
/** All bodies tessellate planar-exact within the band: the ribs' four
 * cap arcs cost microseconds of deflection, the house floor is generous. */
const PLANAR_VOLUME_FLOOR = 0.999;

/** The extrudes' body-key suffixes ride the shared extrude counter: the
 * draft dialog's n-th extrude is `body_extrude{n}` (no bare first form —
 * the dialog path always suffixes). Block, cavity, the two drawn braces,
 * trim, port prism, plate, lip. */
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
/** The seven booleans' bodies: the cavity subtract, the four fuse-one-
 * tool unions (brace one, its turned twin, brace two, its turned twin),
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
/** The duplicates' copies: each duplicate feature names its copies
 * `copy 1` onward (`body_dup_c1`, then `body_dup2_c1` for feature two). */
const DUPLICATE_KEYS = ["body|body_dup_c1", "body|body_dup2_c1"] as const;

/**
 * Chapter 31 — the applied variables capstone. ONE continuous build that
 * makes everything derive: the commission brief, the variable system built
 * live in the manager (create, expression, `$` autocomplete), the case
 * whose every dimension — extrude depth AND sketch dimension — is a
 * `$name` reference (Phase 26a's binding through the sketch inspector's
 * autocomplete), the cavity subtract, and the corner braces taught the
 * Duplicate & transform way (the owner's order for this re-recording):
 * TWO thin diagonal braces drawn (one slot each, width $post, both ends
 * buried in the walls — one per diagonal orientation, the rotation
 * orbits a rectangle's corners only in diagonal pairs), and each turned
 * onto its far corner by ITS OWN duplicate whose step carries the case's
 * own diagonal ($ribStepX := -caseL, $ribStepY := -caseW) while
 * $halfTurn flips the brace's diagonal — the work no translation can
 * do. The board-outline trim shears the four
 * braces to boardLift, the port is authored on the front face at its
 * parameterized height, the three re-drive demos run (lineWidth, board
 * size — the case and the turned copies MOVE, header), the two-rectangle
 * lid closes the case, and the two view-scoped exports verify against
 * their analytic volumes and their taught world bounds.
 */
export const chapter: ChapterModule = {
  definition: {
    id: "iot-applied-var",
    title: "Applied project: a case driven by variables",
    summary:
      "One continuous build from a line width to a two-file print set: the variable system in the manager, every depth and every footprint dimension a $name reference, each corner brace drawn once and planted by its own Duplicate & transform half-turn, the re-drive demos, and the exports.",
    cues: [
      {
        stepId: "brief",
        text: "The commission: one number drives it all — the OCCT kernel turns the copies.",
      },
      {
        stepId: "vars-root",
        text: "One root: lineWidth 0.4 — a printed line. Everything multiplies it.",
      },
      {
        stepId: "vars-wall",
        text: "wall := 2 times lineWidth — two perimeters, 0.8 millimetres.",
      },
      {
        stepId: "vars-print",
        text: "The print logic: the corner ribs two lines wide, floor and lid three.",
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
        text: "Build helpers: depths, rib places, the turn and its carry, the lip fit.",
      },
      {
        stepId: "stage",
        text: "A clean stage — the case builds on nothing but its variables.",
      },
      {
        stepId: "block",
        text: "The block: 71.6 by 51.6 drawn, its spans bound to caseL and caseW.",
      },
      {
        stepId: "pocket-why",
        text: "The cavity is one bound rectangle; four diagonal slots return as ribs.",
      },
      {
        stepId: "pocket",
        text: "The cavity: drawn at the wall inset, its four numbers bound — then cut.",
      },
      {
        stepId: "subtract",
        text: "The subtract: 11,126.3 — walls and floor, no ribs yet.",
      },
      {
        stepId: "posts",
        text: "The first corner brace: one slot, five dimensions, every one a $name.",
      },
      {
        stepId: "posts-turn",
        text: "Duplicate & transform: drawn once, the half-turn plants its twin.",
      },
      {
        stepId: "posts-two",
        text: "The second brace, the same staple: drawn once, its twin turned in.",
      },
      {
        stepId: "posts-why",
        text: "Born fused: the turn flips each diagonal — a slide never could. 12,010.7.",
      },
      {
        stepId: "trims",
        text: "The board's own outline shears the ribs to boardLift — 11,357.7.",
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
        text: "A 10 by 7 window at portX, portZ, cut by $portCut — 11,301.7.",
      },
      {
        stepId: "iso-read",
        text: "The port rides at MCU height: boardLift plus the offset, from the floor's math.",
      },
      {
        stepId: "demo-width",
        text: "lineWidth to 0.5: wall 1, ribs 1 — the case re-derives to 14,151.6.",
      },
      {
        stepId: "demo-board",
        text: "An 85 by 60 board: the sketches re-solve — the case grows to 14,645.7.",
      },
      {
        stepId: "demo-header",
        text: "header to 12: the case deepens to 39.1 — the ribs grow with the floor.",
      },
      {
        stepId: "lid-why",
        text: "The lid: two rectangles — a plate to the footprint, a lip to slide inside.",
      },
      {
        stepId: "lid-plate",
        text: "The plate: the block's bound spans again, up lidT — 4,433.5 cubic.",
      },
      {
        stepId: "lid-lip",
        text: "The lip: board minus clearance at the inset, hung lidT down — 4,128.3.",
      },
      {
        stepId: "box-scope",
        text: "The lid steps aside through its tree eyes — the scene is the box alone.",
      },
      {
        stepId: "export-box",
        text: "The box's STL: 11,301.7 cubic, z from -35.6 to the rim.",
      },
      {
        stepId: "lid-scope",
        text: "The reverse: the box aside, the lid back — the second file's scope.",
      },
      {
        stepId: "export-lid",
        text: "The lid's STL: 8,561.8 cubic, z from -1.2 to 1.2.",
      },
      {
        stepId: "recap",
        text: "Two files, one variable system: change a root, and the whole case follows.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    // -- The brief, over the fresh boot -------------------------------------
    // The OCCT route is the chapter's home (the analytic volume pins
    // demand exact-BREP settles) and is now load-bearing twice over: the
    // duplicate's rotation executes as a real kernel transform here. The
    // boot plate is dismissed through its tree eye the moment the boot is
    // read — the flag lands here, the pixels follow one dispatch later.
    await driver.step("brief");
    const bootVolume = await driver.arriveAtWorkbench("occt");
    expect(Number(bootVolume)).toBeCloseTo(BOOT_PLATE_VOLUME, 0);
    await setBodyVisible(page, driver, "body|body_plate", false);
    await driver.dwell();

    // -- The variable system, live in the manager ---------------------------
    await driver.step("vars-root");
    const panel = page.locator('[data-slot="cad-parameter-panel"]');
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await createVariable(page, driver, panel, "lineWidth", "0.4mm");
    await driver.dwell();

    await driver.step("vars-wall");
    // wall := 2 * lineWidth — the first definition, written with the
    // manager's own `$` autocomplete. Each derived name is CREATED first
    // with the number a hand calc gives, then its expression keeps it
    // true — the manager defines over existing rows. Two perimeters: the
    // owner's wall is two line widths outright, no count indirection.
    await createVariable(page, driver, panel, "wall", "0.8mm");
    await defineExpression(page, driver, panel, "wall", [
      { type: "text", text: "2 * " },
      { type: "$", text: "$line", option: "lineWidth" },
    ]);
    await driver.pointAtReadout(
      rowOf(page, panel, "wall").getByText("= 0.8 mm", { exact: true }),
    );
    await driver.dwell();

    await driver.step("vars-print");
    // The owner's print logic, two clicks an expression: the diagonal
    // corner ribs are two lines wide; floor and lid are three. Every
    // multiple reads the ROOT directly — nothing chains through wall.
    await createVariable(page, driver, panel, "post", "0.8mm");
    await createVariable(page, driver, panel, "bottom", "1.2mm");
    await createVariable(page, driver, panel, "lidT", "1.2mm");
    await defineExpression(page, driver, panel, "post", [
      { type: "text", text: "2 * " },
      { type: "$", text: "$line", option: "lineWidth" },
    ]);
    await defineExpression(page, driver, panel, "bottom", [
      { type: "text", text: "3 * " },
      { type: "$", text: "$line", option: "lineWidth" },
    ]);
    await defineExpression(page, driver, panel, "lidT", [
      { type: "text", text: "3 * " },
      { type: "$", text: "$line", option: "lineWidth" },
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
    await createVariable(page, driver, panel, "caseL", "71.6mm");
    await createVariable(page, driver, panel, "caseW", "51.6mm");
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
    // cut's overshoot, the rib trim's drop, the braces' diagonal reach (a
    // design literal, the portX class), the duplicate's half turn (an
    // ANGLE literal — the duplicate's rotation field resolves angle-
    // dimensioned references) and its carry (the case's own diagonal,
    // named negative — the signed-helper route keeps the step visible and
    // re-drivable in the manager), both brace cap centers' places (the
    // near cap at the case's corner pulled one line width inside; the far
    // cap one reach further in — both ends absolute so the 45° is the
    // solve's own consequence), the lip's fit — every derived one an
    // expression.
    await createVariable(page, driver, panel, "lidClear", "0.5mm");
    await createVariable(page, driver, panel, "cavityD", "34.4mm");
    await createVariable(page, driver, panel, "portCut", "1.8mm");
    await createVariable(page, driver, panel, "postDrop", "25.4mm");
    await createVariable(page, driver, panel, "reach", "6mm");
    await createVariable(page, driver, panel, "halfTurn", "180deg");
    await createVariable(page, driver, panel, "ribStepX", "0mm");
    await createVariable(page, driver, panel, "ribStepY", "0mm");
    await createVariable(page, driver, panel, "postNearX", "71.2mm");
    await createVariable(page, driver, panel, "postNearY", "51.2mm");
    await createVariable(page, driver, panel, "postIn", "6.4mm");
    await createVariable(page, driver, panel, "postFarX", "65.2mm");
    await createVariable(page, driver, panel, "postFarY", "45.2mm");
    await createVariable(page, driver, panel, "lipL", "69.5mm");
    await createVariable(page, driver, panel, "lipW", "49.5mm");
    await createVariable(page, driver, panel, "lipInset", "1.05mm");
    // The four downward extrudes ride signed helpers — by choice since the
    // grammar also admits `-$name`: naming the sign keeps it a variable
    // like everything else.
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
    // The duplicate's step carries the case's own diagonal, named
    // negative like every signed depth in this build.
    await defineExpression(page, driver, panel, "ribStepX", [
      { type: "text", text: "-" },
      { type: "$", text: "$caseL", option: "caseL" },
    ]);
    await defineExpression(page, driver, panel, "ribStepY", [
      { type: "text", text: "-" },
      { type: "$", text: "$caseW", option: "caseW" },
    ]);
    await defineExpression(page, driver, panel, "postNearX", [
      { type: "$", text: "$caseL", option: "caseL" },
      { type: "text", text: " - " },
      { type: "$", text: "$line", option: "lineWidth" },
    ]);
    await defineExpression(page, driver, panel, "postNearY", [
      { type: "$", text: "$caseW", option: "caseW" },
      { type: "text", text: " - " },
      { type: "$", text: "$line", option: "lineWidth" },
    ]);
    await defineExpression(page, driver, panel, "postIn", [
      { type: "$", text: "$line", option: "lineWidth" },
      { type: "text", text: " + " },
      { type: "$", text: "$rea", option: "reach" },
    ]);
    await defineExpression(page, driver, panel, "postFarX", [
      { type: "$", text: "$cas", option: "caseL" },
      { type: "text", text: " - " },
      { type: "$", text: "$line", option: "lineWidth" },
      { type: "text", text: " - " },
      { type: "$", text: "$rea", option: "reach" },
    ]);
    await defineExpression(page, driver, panel, "postFarY", [
      { type: "$", text: "$cas", option: "caseW" },
      { type: "text", text: " - " },
      { type: "$", text: "$line", option: "lineWidth" },
      { type: "text", text: " - " },
      { type: "$", text: "$rea", option: "reach" },
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
    // The plate left the scene at the boot — the flag landed there, its
    // last pixels followed one dispatch later — so every readout from
    // here on counts the case alone.
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
    await clickDatumPoint(driver, 71.6, 51.6);
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 35.8, 0);
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
    await clickDatumPoint(driver, 71.2, 0);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0.4);
    await clickDatumPoint(driver, 0, 51.2);
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
    await clickDatumPoint(driver, 70.8, 50.8);
    await clickDatumPoint(driver, 0.8, 0.8);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 35.8, 0.8);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 1.2, 0.8);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 0.8, 1.2);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 1.2, 0.8);
    await clickDatumPoint(driver, 70.4, 0.8);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0.8, 1.2);
    await clickDatumPoint(driver, 0.8, 50.4);
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

    // -- The braces: each drawn once, its twin placed by the turn -----------
    await driver.step("posts");
    // Brace one, at the origin corner: ONE straight slot — two cap
    // centers and a radius, the probe's one-entity closed profile —
    // drawn at 45° across the corner, both round ends burying into the
    // two walls. Five dimensions, all `$`-bound, BOTH cap centers
    // absolute off the origin point: the near cap center reads
    // ($lineWidth, $lineWidth) — the round end lands flush with the two
    // outer faces — the far cap center reads $postIn twice, and the
    // DIAMETER is $post, the two line widths the owner asked for. The
    // dim picks land on the centerline but clear of the point entity's
    // hit halo (later-drawn entities win ties, so the point would eat a
    // closer pick — the probe's finding). Extruded DOWN $cavityDrop.
    await drawBrace(page, driver, {
      near: [0.4, 0.4],
      far: [6.4, 6.4],
      radiusPick: [0.6828, 0.1172],
      inward: [1.1, 1.1],
      outward: [5.9, 5.9],
      diameterPick: [3.6828, 3.1172],
      placeX: "$lineWidth",
      placeY: "$lineWidth",
      farX: "$postIn",
      farY: "$postIn",
    });
    await draftDialog(page, driver, { ref: "cavityDrop" }, "sketch 4");
    // The drafted brace adds its FULL stadium (the wall-buried halves
    // only fuse away at the unions).
    await expectVolume(page, SHELL_VOLUME + STRIP_BODY_VOLUME);
    await driver.dwell();

    await driver.step("posts-turn");
    // THE STAPLE, on camera: Duplicate & transform. Source = the drawn
    // brace; the step carries the case's own diagonal ($ribStepX :=
    // -caseL, $ribStepY := -caseW — the world pivot this frame sits at
    // the case's min corner, so the carry lands the turn) while
    // $halfTurn rotates half a circle about z; one copy. The turn FLIPS
    // the brace's diagonal — hand-derived, the copy lands exactly on the
    // far corner's brace: T(p) = (caseL − px, caseW − py, pz) maps the
    // near cap (0.4, 0.4) → (71.2, 51.2) and the far cap (6.4, 6.4) →
    // (65.2, 45.2) — the work no translation can do, and the volume pin
    // proves the landing (a brace in open air would add its full
    // stadium; only the corner-correct copy adds the open-cavity part).
    await duplicateDialog(page, driver, "drafted 3");
    await expectVolume(page, SHELL_VOLUME + 2 * STRIP_BODY_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("posts-two");
    // Brace two, at the x-far corner: the SAME five-dimension recipe, its
    // diagonal running at 135° (the near cap reads $postNearX and follows
    // the board) — and THE SAME STAPLE: drawn once, its twin turned into
    // the y-far corner. Two drawn braces, two turns, four corners.
    await drawBrace(page, driver, {
      near: [71.2, 0.4],
      far: [65.2, 6.4],
      radiusPick: [71.4828, 0.6828],
      inward: [70.7, 0.9],
      outward: [65.7, 5.9],
      diameterPick: [68.4828, 3.6828],
      placeX: "$postNearX",
      placeY: "$lineWidth",
      farX: "$postFarX",
      farY: "$postIn",
    });
    await draftDialog(page, driver, { ref: "cavityDrop" }, "sketch 5");
    await expectVolume(
      page,
      SHELL_VOLUME + 2 * STRIP_BODY_VOLUME + STRIP_UNION_VOLUME,
    );
    await duplicateDialog(page, driver, "drafted 4");
    await expectVolume(
      page,
      SHELL_VOLUME + 2 * STRIP_BODY_VOLUME + 2 * STRIP_UNION_VOLUME,
    );
    await driver.dwell();

    await driver.step("posts-why");
    // Born fused: FOUR single-tool unions fold each brace, drawn and
    // turned, into the shell — braces and shell, one body, printed as
    // one. One tool per boolean is not a grammar the scene imposes —
    // multi-tool unions compose fine — it is the chapter's teaching
    // choice: four visible fuse steps teach better than one batched
    // commit.
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 0, "Union (join)");
    await pickComboboxOption(page, driver, 1, "subtract 1");
    await checkBooleanTool(page, driver, "drafted 3");
    await createBoolean(page, driver);
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 0, "Union (join)");
    await pickComboboxOption(page, driver, 1, "union 2");
    await checkBooleanToolAt(page, driver, "copy 1", 0);
    await createBoolean(page, driver);
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 0, "Union (join)");
    await pickComboboxOption(page, driver, 1, "union 3");
    await checkBooleanTool(page, driver, "drafted 4");
    await createBoolean(page, driver);
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 0, "Union (join)");
    await pickComboboxOption(page, driver, 1, "union 4");
    await checkBooleanToolAt(page, driver, "copy 1", 1);
    const fused = await createBoolean(page, driver);
    expect(
      volumeNear(fused, SHELL_POSTS_VOLUME),
      `the fused union settled at ${String(fused)}`,
    ).toBe(true);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The board-outline trim ---------------------------------------------
    await driver.step("trims");
    // ONE prism at the cavity's own bound numbers — the board's own
    // outline, place $wall/$wall and size $boardL/$boardW — extruded DOWN
    // $postDropDown and subtracted once: it shears exactly the four
    // braces' open-cavity tops, so they come out boardLift tall wherever
    // the board moves. The wall-band ends need no trim: they fuse into
    // solid wall, full height, invisibly — and the turned copies came out
    // of the duplicate at full cavity depth exactly like the drawn pair,
    // so the one trim serves all four.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 70.8, 50.8);
    await clickDatumPoint(driver, 0.8, 0.8);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 35.8, 0.8);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 1.2, 0.8);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 0.8, 1.2);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 1.2, 0.8);
    await clickDatumPoint(driver, 70.4, 0.8);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0.8, 1.2);
    await clickDatumPoint(driver, 0.8, 50.4);
    await bindSketchDimension(page, driver, 1, "$wall", "distanceX");
    await bindSketchDimension(page, driver, 2, "$wall", "distanceY");
    await bindSketchDimension(page, driver, 3, "$boardL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$boardW", "distanceY");
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "postDropDown" }, "sketch 6");
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 1, "union 5");
    await checkBooleanTool(page, driver, "drafted 5");
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
    // floor — world z -27.9..-20.9 here, so the v coordinates (pointing
    // DOWN the world z axis) ride the datum origin. Arithmetic from the
    // var table: u = portX +/- portW/2; v = origin + cavityD - portZ -/+
    // portH/2.
    const portUMin = 35 - 5 - portDatum.origin[1];
    const portUMax = 35 + 5 - portDatum.origin[1];
    const portVLow = portDatum.origin[2] + 34.4 - 10 + 3.5;
    const portVHigh = portDatum.origin[2] + 34.4 - 10 - 3.5;
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, portUMin, portVHigh);
    await clickDatumPoint(driver, portUMax, portVLow);
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "portCutIn" }, "sketch 7");
    await expectVolume(page, TRIMMED_VOLUME + PORT_PRISM_VOLUME);
    await openFeatureDialog(page, driver, OCCT_ROOT, "boolean");
    await pickComboboxOption(page, driver, 1, "subtract 6");
    await checkBooleanTool(page, driver, "drafted 6");
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
    // footprint, every rib follows on the next dispatch: wall 1, ribs 1
    // wide, the case 72 by 52, the rib ends still flush with the faces.
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
    // block, the cavity, the ribs (postNearX/postNearY re-derive), the
    // trim all re-place and re-size — the case visibly grows to 86.6 by
    // 61.6, volume 14,645.7. The owner's ask, delivered: set the board,
    // the whole case follows. Then back to 70 by 50, re-pinned.
    await driver.humanClick(
      page.getByRole("button", { name: "Manage variables" }),
    );
    await setVariableExpression(page, driver, panel, "boardL", "85mm");
    await setVariableExpression(page, driver, panel, "boardW", "60mm");
    await driver.pointAtReadout(
      rowOf(page, panel, "caseL").getByText("= 86.6 mm", { exact: true }),
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
    // the ribs grow with the dropped floor (postDrop reads boardT +
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
    // the same origin-side pin (the block's own recipe). One lidT up:
    // three line widths, a plate, not a slab.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 71.6, 51.6);
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 35.8, 0);
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
    await clickDatumPoint(driver, 71.2, 0);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0.4);
    await clickDatumPoint(driver, 0, 51.2);
    // Rows: 0 horizontal, 1 placeX, 2 placeY, 3 spanX, 4 spanY.
    await bindSketchDimension(page, driver, 3, "$caseL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$caseW", "distanceY");
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "lidT" }, "sketch 8");
    await expectVolume(page, BOX_VOLUME + PLATE_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    await driver.step("lid-lip");
    // The lip hangs INTO the opening: board minus the clearance, placed
    // at the wall-plus-half-clearance inset — every number a variable —
    // extruded DOWN lidHang from the same bed plane.
    await driver.enterSketchMode(OCCT_ROOT);
    await driver.activateSketchTool("rectangle");
    await clickDatumPoint(driver, 70.55, 50.55);
    await clickDatumPoint(driver, 1.05, 1.05);
    await driver.activateSketchTool("horizontal");
    await clickDatumPoint(driver, 35.8, 1.05);
    await driver.activateSketchTool("point");
    await clickDatumPoint(driver, 0, 0);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 1.45, 1.05);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 0, 0);
    await clickDatumPoint(driver, 1.05, 1.45);
    await driver.activateSketchTool("distanceX");
    await clickDatumPoint(driver, 1.45, 1.05);
    await clickDatumPoint(driver, 70.15, 1.05);
    await driver.activateSketchTool("distanceY");
    await clickDatumPoint(driver, 1.05, 1.45);
    await clickDatumPoint(driver, 1.05, 50.15);
    // Rows: 0 horizontal, 1 placeX, 2 placeY, 3 spanX, 4 spanY.
    await bindSketchDimension(page, driver, 1, "$lipInset", "distanceX");
    await bindSketchDimension(page, driver, 2, "$lipInset", "distanceY");
    await bindSketchDimension(page, driver, 3, "$lipL", "distanceX");
    await bindSketchDimension(page, driver, 4, "$lipW", "distanceY");
    await saveSketch(page, driver);
    await draftDialog(page, driver, { ref: "lidHang" }, "sketch 9");
    await expectVolume(page, BOX_VOLUME + LID_VOLUME);
    await driver.pointAtReadout(page.locator("#workbench-complete-volume"));
    await driver.dwell();

    // -- The STLs that go to the bed ----------------------------------------
    await driver.step("box-scope");
    // The lid's two bodies step aside through their tree eyes: the scene
    // is the box alone, and the export carries what renders.
    await setBodyVisible(page, driver, "body|body_extrude7", false);
    await setBodyVisible(page, driver, "body|body_extrude8", false);
    await driver.dwell();

    await driver.step("export-box");
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );
    await runStlExport(page, driver, BOX_VOLUME, PLANAR_VOLUME_FLOOR, {
      min: [0, 0, -35.6],
      max: [71.6, 51.6, 0],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    await driver.dwell();

    await driver.step("lid-scope");
    // The opposite file: the box steps aside — its extrudes, its
    // booleans, and the duplicate's copy — and the lid steps back.
    await setBodyVisible(page, driver, "body|body_extrude7", true);
    await setBodyVisible(page, driver, "body|body_extrude8", true);
    // The box's own extrudes are 1..6 — the lid's plate and lip are 7/8,
    // shown again above (Phase 32b: the hide set once re-hidden them, and
    // the lid export refused on the honest empty scene).
    for (const key of [
      ...EXTRUDE_KEYS.slice(0, 6),
      ...BOOLEAN_KEYS,
      ...DUPLICATE_KEYS,
    ]) {
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
      min: [0, 0, -1.2],
      max: [71.6, 51.6, 1.2],
    });
    await driver.pointAtReadout(page.locator('[data-cad-export-entry="stl"]'));
    await closeExportDialog(page);
    // The restore mirrors the hide: the box's extrudes, its booleans, and
    // the copies — the lid never stepped aside (Phase 32b).
    for (const key of [
      ...EXTRUDE_KEYS.slice(0, 6),
      ...BOOLEAN_KEYS,
      ...DUPLICATE_KEYS,
    ]) {
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
 * parameterId, no value) and the inspector row renames — a distanceX to
 * `distanceX $caseL`, a diameter to `diameter $post` — the assertions
 * below pin exactly that.
 */
async function bindSketchDimension(
  page: Page,
  driver: TutorialDriver,
  rowIndex: number,
  option: string,
  kind: "distanceX" | "distanceY" | "diameter",
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

/** The pick coordinates one brace's slot sketch rides (all workplane mm). */
interface BracePlacement {
  readonly near: readonly [number, number];
  readonly far: readonly [number, number];
  readonly radiusPick: readonly [number, number];
  readonly inward: readonly [number, number];
  readonly outward: readonly [number, number];
  readonly diameterPick: readonly [number, number];
  readonly placeX: string;
  readonly placeY: string;
  readonly farX: string;
  readonly farY: string;
}

/**
 * Draws ONE diagonal brace at a case corner and extrudes nothing — the
 * sketch only. The straight slot (two cap centers and a radius pick) is
 * the probe's one-entity closed profile; the point entity at the origin
 * carries both cap centers' ABSOLUTE place pairs (near and far, so the
 * 45° is the solve's own consequence — no magnitude dimension ever
 * carries a direction), and the diameter dim picks the slot's side edge
 * for the taught width. Every dimension is `$`-bound through the
 * inspector before the sketch saves.
 */
async function drawBrace(
  page: Page,
  driver: TutorialDriver,
  brace: BracePlacement,
): Promise<void> {
  await driver.enterSketchMode(OCCT_ROOT);
  await driver.activateSketchTool("slot");
  await clickDatumPoint(driver, brace.near[0], brace.near[1]);
  await clickDatumPoint(driver, brace.far[0], brace.far[1]);
  await clickDatumPoint(driver, brace.radiusPick[0], brace.radiusPick[1]);
  await driver.activateSketchTool("point");
  await clickDatumPoint(driver, 0, 0);
  // The place pair: origin point to the near cap center.
  await driver.activateSketchTool("distanceX");
  await clickDatumPoint(driver, 0, 0);
  await clickDatumPoint(driver, brace.inward[0], brace.inward[1]);
  await driver.activateSketchTool("distanceY");
  await clickDatumPoint(driver, 0, 0);
  await clickDatumPoint(driver, brace.inward[0], brace.inward[1]);
  // The far cap center's place pair: ALSO origin-anchored — both ends
  // absolute, so the 45° is the solve's own consequence and no magnitude
  // dimension ever carries a direction (the first draft's |Δx| = |Δy| =
  // $reach pair flipped signs at the trim beat's re-solve — the probe's
  // loud lesson).
  await driver.activateSketchTool("distanceX");
  await clickDatumPoint(driver, 0, 0);
  await clickDatumPoint(driver, brace.outward[0], brace.outward[1]);
  await driver.activateSketchTool("distanceY");
  await clickDatumPoint(driver, 0, 0);
  await clickDatumPoint(driver, brace.outward[0], brace.outward[1]);
  // The width: the slot's diameter, one pick on its boundary.
  await driver.activateSketchTool("diameter");
  await clickDatumPoint(driver, brace.diameterPick[0], brace.diameterPick[1]);
  // Rows: 0 placeX, 1 placeY, 2 farX, 3 farY, 4 diameter.
  await bindSketchDimension(page, driver, 0, brace.placeX, "distanceX");
  await bindSketchDimension(page, driver, 1, brace.placeY, "distanceY");
  await bindSketchDimension(page, driver, 2, brace.farX, "distanceX");
  await bindSketchDimension(page, driver, 3, brace.farY, "distanceY");
  await bindSketchDimension(page, driver, 4, "$post", "diameter");
  // The binds re-solve asynchronously; the save snapshots the session, so
  // the SOLVED geometry is pinned to the intended places before the
  // record lands — a mid-solve snapshot would carry a transient state.
  await expect
    .poll(
      async () => {
        const raw = await page
          .locator(SKETCH)
          .getAttribute("data-sketch-solved");
        if (raw === null || raw === "null") return "unsolved";
        const entities = JSON.parse(raw) as {
          kind: string;
          x1?: number;
          y1?: number;
          x2?: number;
          y2?: number;
        }[];
        const slot = entities.find((entity) => entity.kind === "slot");
        if (
          slot === undefined ||
          slot.x1 === undefined ||
          slot.y1 === undefined ||
          slot.x2 === undefined ||
          slot.y2 === undefined
        ) {
          return "no-slot";
        }
        const atPlace =
          Math.abs(slot.x1 - brace.near[0]) < 0.01 &&
          Math.abs(slot.y1 - brace.near[1]) < 0.01 &&
          Math.abs(slot.x2 - brace.far[0]) < 0.01 &&
          Math.abs(slot.y2 - brace.far[1]) < 0.01;
        return atPlace ? "at-place" : `off ${JSON.stringify(slot)}`;
      },
      { timeout: 15_000 },
    )
    .toBe("at-place");
  await saveSketch(page, driver);
}

/**
 * Fills one expression-number dialog field with a `$name` reference the
 * established way: click, select all, type the trigger (the target name's
 * first three letters), click the suggested parameter row — the field's
 * value lands as the full reference, pinned.
 */
async function fillExpressionField(
  page: Page,
  driver: TutorialDriver,
  label: string,
  ref: string,
): Promise<void> {
  const field = page.getByLabel(label);
  await driver.humanClick(field);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`$${ref.slice(1, 4)}`);
  await driver.humanClick(page.getByRole("option", { name: ref, exact: true }));
  await expect(field).toHaveValue(ref);
}

/**
 * The Duplicate & transform dialog, filled on camera and submitted: the
 * source body pick, the step carrying the case's own diagonal
 * ($ribStepX/$ribStepY — the world pivot this frame sits at the case's
 * min corner), zero z step, the world-z axis, the half turn
 * ($halfTurn, an angle reference), one copy. Waits the settled scene and
 * returns its volume.
 */
async function duplicateDialog(
  page: Page,
  driver: TutorialDriver,
  sourceBody: string,
): Promise<string> {
  await openFeatureDialog(page, driver, OCCT_ROOT, "duplicate");
  // The two radix selects (source, axis) ride their data-slot triggers —
  // the expression-number inputs ALSO carry role="combobox", so a
  // role-based index would land on a field, not a select.
  const selectTrigger = page
    .locator(DIALOG)
    .locator('[data-slot="select-trigger"]');
  await driver.humanClick(selectTrigger.nth(0));
  await driver.humanClick(
    page.getByRole("option", { name: sourceBody, exact: true }),
  );
  await fillExpressionField(page, driver, "Step x (mm)", "$ribStepX");
  await fillExpressionField(page, driver, "Step y (mm)", "$ribStepY");
  await fillLabeledField(page, driver, page.getByLabel("Step z (mm)"), "0");
  await driver.humanClick(selectTrigger.nth(1));
  await driver.humanClick(
    page.getByRole("option", { name: "Z axis", exact: true }),
  );
  await fillExpressionField(page, driver, "Step rotation (deg)", "$halfTurn");
  await fillLabeledField(page, driver, page.getByLabel("Copies"), "1");
  const before = await dispatchedCount(page, OCCT_ROOT);
  await driver.humanClick(
    page.locator(DIALOG).getByRole("button", { name: "Create" }),
  );
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`#${OCCT_ROOT}`)).toHaveAttribute(
    "data-scene-kind",
    "duplicate",
  );
  return waitForRootSettle(page, OCCT_ROOT, { afterDispatch: before });
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
 * reference the chapter's SIGNED helper variables — by choice since the
 * grammar also admits the negated `-$name` token: naming the sign keeps it
 * in the variable system with everything else.
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
 * Checks one boolean dialog tool checkbox through the driver and PINS the
 * toggle: the boolean's arithmetic only holds when every named tool is
 * actually checked, so the commit is gated on the checkbox's own
 * aria-checked state (a glide that lost the click to a re-render fails
 * here, loudly, instead of poisoning the volume chain).
 */
async function checkBooleanTool(
  page: Page,
  driver: TutorialDriver,
  name: string,
): Promise<void> {
  await checkBooleanToolAt(page, driver, name, 0);
}

/**
 * {@link checkBooleanTool} for a REUSED body name: the second duplicate's
 * copy is also named `copy 1` (each duplicate feature numbers its copies
 * from one), and consumed bodies stay in the dialog pools — the nth index
 * picks the live twin (document body order: the first duplicate's copy
 * indexes first).
 */
async function checkBooleanToolAt(
  page: Page,
  driver: TutorialDriver,
  name: string,
  index: number,
): Promise<void> {
  const box = page
    .locator(DIALOG)
    .getByRole("checkbox", { name, exact: true })
    .nth(index);
  await driver.humanClick(box);
  // A glide that lost the click to a mid-glide re-render retries once,
  // still on camera, before the pin makes the failure loud.
  if ((await box.getAttribute("aria-checked")) !== "true") {
    await driver.humanClick(box);
  }
  await expect(box).toHaveAttribute("aria-checked", "true");
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
