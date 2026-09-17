/**
 * The STEP fixture generator (Phase 21.3): writes the committed
 * `fixtures/plate-with-hole.step` by building the Phase 21 plate-with-hole
 * scene with the real OpenCascade binding and exporting it through the
 * binding's own `STEPControl_Writer` — 21.4's exporter does not exist yet,
 * so the generator uses the writer directly (the plan's sanctioned route).
 *
 * The fixture is the /io source plate EXACTLY: a 30×20×10 box with a ⌀8
 * through-bore at (15, 10) — the same scene `PLATE_WITH_HOLE` describes and
 * the same geometry the Phase 1.6/18/21 fixtures render — so a browser STEP
 * import is directly comparable against the settled source solid.
 *
 * Self-checking: before the bytes are written to disk the in-memory solid's
 * BREP volume must match the analytic box-minus-cylinder value inside the
 * exact band, and its topology must count 7 faces / 30 edges / 60 vertices
 * (the pre-spike's probed counts). A generator that produced wrong geometry
 * refuses to write the fixture rather than committing it.
 *
 * Run: `pnpm --filter @slopcad/cad-kernel-occt write-step-fixture`
 * (Node executes the TypeScript source directly through type stripping).
 * The generator runs outside vitest because its output is a committed
 * artifact, not a test result; it touches only its fixture path.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import init from "replicad-opencascadejs";
import type { TopoDS_Shape } from "replicad-opencascadejs";

/** The committed fixture's path, relative to this package's root. */
const FIXTURE_URL = new URL(
  "../fixtures/plate-with-hole.step",
  import.meta.url,
);

/** The plate-with-hole dimensions (canonical millimetres). */
const WIDTH_MM = 30;
const DEPTH_MM = 20;
const HEIGHT_MM = 10;
const BORE_RADIUS_MM = 4;
const BORE_CENTER_X_MM = 15;
const BORE_CENTER_Y_MM = 10;

/** The analytic plate-minus-bore volume (mm³). */
const ANALYTIC_VOLUME_MM3 =
  WIDTH_MM * DEPTH_MM * HEIGHT_MM - Math.PI * BORE_RADIUS_MM ** 2 * HEIGHT_MM;

/** The exact band OCCT's BREP integration holds (probed at 0 relative error). */
const EXACT_VOLUME_REL_TOLERANCE = 1e-9;

/** The probed topology counts of the drilled plate. */
const EXPECTED_FACES = 7;
const EXPECTED_EDGES = 30;
const EXPECTED_VERTICES = 60;

/** The emscripten MEMFS path the writer emits to (see occt-step-import). */
const MEMFS_PATH = "/slopcad-write-step-fixture.step";

function countTopo(
  oc: Awaited<ReturnType<typeof init>>,
  shape: TopoDS_Shape,
  kind: Parameters<InstanceType<(typeof oc)["TopExp_Explorer"]>["Init"]>[1],
): number {
  const explorer = new oc.TopExp_Explorer(shape, kind);
  let count = 0;
  while (explorer.More()) {
    count += 1;
    explorer.Next();
  }
  explorer.delete();
  return count;
}

const oc = await init();

const box = new oc.BRepPrimAPI_MakeBox(WIDTH_MM, DEPTH_MM, HEIGHT_MM).Shape();
const bore = new oc.BRepPrimAPI_MakeCylinder(BORE_RADIUS_MM, HEIGHT_MM).Shape();
const toCenter = new oc.gp_Trsf();
toCenter.SetTranslation(new oc.gp_Vec(BORE_CENTER_X_MM, BORE_CENTER_Y_MM, 0));
const placedBore = new oc.BRepBuilderAPI_Transform(
  bore,
  toCenter,
  false,
  true,
).Shape();
const plate = new oc.BRepAlgoAPI_Cut(box, placedBore).Shape();

const props = new oc.GProp_GProps();
oc.BRepGProp.VolumeProperties(plate, props, true, false, false);
const volume = props.Mass();
props.delete();

const volumeError = Math.abs(volume - ANALYTIC_VOLUME_MM3);
if (volumeError > ANALYTIC_VOLUME_MM3 * EXACT_VOLUME_REL_TOLERANCE) {
  throw new Error(
    `Generated plate volume ${volume} misses the analytic ${ANALYTIC_VOLUME_MM3} beyond the exact band.`,
  );
}
const faces = countTopo(oc, plate, oc.TopAbs_ShapeEnum.TopAbs_FACE);
const edges = countTopo(oc, plate, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
const vertices = countTopo(oc, plate, oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
if (
  faces !== EXPECTED_FACES ||
  edges !== EXPECTED_EDGES ||
  vertices !== EXPECTED_VERTICES
) {
  throw new Error(
    `Generated plate topology ${faces}/${edges}/${vertices} (f/e/v) misses the probed ${EXPECTED_FACES}/${EXPECTED_EDGES}/${EXPECTED_VERTICES}.`,
  );
}

const writer = new oc.STEPControl_Writer();
const transfer = writer.Transfer(
  plate,
  oc.STEPControl_StepModelType.STEPControl_AsIs,
  true,
  new oc.Message_ProgressRange(),
);
if (transfer !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
  throw new Error(`The STEP transfer failed: ${String(transfer)}.`);
}
const write = writer.Write(MEMFS_PATH);
writer.delete();
if (write !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
  throw new Error(`The STEP write failed: ${String(write)}.`);
}

const bytes = oc.FS.readFile(MEMFS_PATH);
oc.FS.unlink(MEMFS_PATH);

await writeFile(fileURLToPath(FIXTURE_URL), bytes);

console.log(
  `wrote ${fileURLToPath(FIXTURE_URL)} (${bytes.length} bytes, volume ${volume} mm³, topology ${faces}/${edges}/${vertices})`,
);
