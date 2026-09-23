import { expect, test } from "@playwright/test";

/**
 * The Phase 56 exchange-import journeys (the import surface the block
 * wires):
 *
 * 1. OBJ rides the workbench import dialog (the mesh path): the file
 *    imports in the browser, the outcome readout settles (triangles,
 *    volume, extents), and the viewport shows the imported mesh under the
 *    preview chip.
 * 2. DXF rides the SKETCH path: from the sketch workspace's own import
 *    control the file's entities enter the ACTIVE sketch as one
 *    transaction — the entity count settles and the outcome readout names
 *    the source file.
 *
 * The machine surfaces (data-import-*, data-sketch-import,
 * data-sketch-entities) carry the assertions; the screenshots are the
 * visual confirmation.
 */

const ROOT = "#workbench-complete-root";

/** A 10 × 20 × 4 mm plate as ASCII OBJ: 8 vertices, 12 outward triangles. */
const PLATE_OBJ = `o plate
v 0 0 0
v 10 0 0
v 10 20 0
v 0 20 0
v 0 0 4
v 10 0 4
v 10 20 4
v 0 20 4
f 1 3 2
f 1 4 3
f 5 6 7
f 5 7 8
f 1 2 6
f 1 6 5
f 3 4 8
f 3 8 7
f 2 3 7
f 2 7 6
f 4 1 5
f 4 5 8
`;

/** One line plus one circle on the outline layer (R12-class ASCII DXF). */
const SKETCH_DXF =
  "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" +
  "0\nLINE\n5\n2AF\n8\noutline\n10\n0\n20\n0\n11\n30\n21\n40\n" +
  "0\nCIRCLE\n5\n2B0\n8\noutline\n10\n15\n20\n20\n40\n5\n" +
  "0\nENDSEC\n0\nEOF\n";

test("imports an OBJ through the dialog: mesh visible, volume settles", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await expect(page.locator(ROOT)).toHaveAttribute("data-settled", "1");
  await expect(page.locator("canvas").first()).toBeVisible();

  // The dialog path: the command menu's Import command (reachable at every
  // width), then the file input.
  await page.getByTestId("complete-command-menu-trigger").click();
  await page.locator('[data-cad-command-id="import"]').click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-import-dialog-open",
    "true",
  );
  await page.getByTestId("cad-import-file").setInputFiles({
    buffer: Buffer.from(PLATE_OBJ, "utf8"),
    mimeType: "text/plain",
    name: "plate.obj",
  });

  // The success readout: the outcome exists, names the source, and the
  // geometry numbers settle (a real parse, not a pending state).
  await expect(page.locator(ROOT)).toHaveAttribute("data-import-source", "obj");
  await expect
    .poll(async () => page.locator(ROOT).getAttribute("data-import-triangles"))
    .toBe("12");
  // The plate's exact volume: 10 × 20 × 4 mm = 800 mm³, settled.
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-import-volume",
    "800.000",
  );
  // The viewport shows the IMPORT under the truth-telling chip, and the
  // successful import closed the dialog.
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-viewport-showing",
    "import",
  );
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-import-dialog-open",
    "false",
  );
  await expect(page.locator("canvas").first()).toBeVisible();

  await page.screenshot({ path: "e2e-artifacts/import-obj.png" });
});

test("imports a DXF into the active sketch: entities appear, count settles", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await expect(page.locator(ROOT)).toHaveAttribute("data-settled", "1");

  // Enter the sketch workspace (the empty XY session).
  await page.getByTestId("complete-command-menu-trigger").click();
  await page.locator('[data-cad-command-id="sketch"]').click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-sketch-mode",
    "sketch",
  );
  await expect(page.locator("#sketch-root")).toBeVisible();
  await expect(page.locator("#sketch-root")).toHaveAttribute(
    "data-sketch-entities",
    "[]",
  );

  // The sketch-entry import control: the DXF entities commit as ONE
  // transaction into the ACTIVE session.
  await page.getByTestId("sketch-import-file").setInputFiles({
    buffer: Buffer.from(SKETCH_DXF, "utf8"),
    mimeType: "text/plain",
    name: "outline.dxf",
  });

  // The outcome readout names the file and the import; the sketch holds
  // exactly the imported entities (the count settles at 2 and stays).
  const sketchRoot = page.locator("#sketch-root");
  await expect(sketchRoot).toHaveAttribute(
    "data-sketch-import",
    /"status":"imported"/,
  );
  await expect(sketchRoot).toHaveAttribute(
    "data-sketch-import",
    /outline\.dxf: imported 2 entities/,
  );
  const countEntities = async (): Promise<number> => {
    const raw = await sketchRoot.getAttribute("data-sketch-entities");
    return (JSON.parse(raw ?? "[]") as unknown[]).length;
  };
  await expect.poll(countEntities).toBe(2);
  // Settled: a second read after the paint agrees.
  await expect.poll(countEntities).toBe(2);
  await expect(page.getByTestId("sketch-import-outcome")).toContainText(
    "outline.dxf: imported 2 entities",
  );

  // The imported geometry is INK on the canvas — both entities render as
  // shapes carrying their entity ids.
  await expect(
    page.locator("#sketch-root [data-sketch-entity-id]"),
  ).toHaveCount(2);

  await page.screenshot({ path: "e2e-artifacts/import-dxf-sketch.png" });
});

test("declines a DXF picked from the model-mode dialog: no active sketch", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  await expect(page.locator(ROOT)).toHaveAttribute("data-settled", "1");

  // The model-mode import dialog has no active sketch to enter — the
  // structured decline says where the file CAN go instead of guessing.
  await page.getByTestId("complete-command-menu-trigger").click();
  await page.locator('[data-cad-command-id="import"]').click();
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-import-dialog-open",
    "true",
  );
  await page.getByTestId("cad-import-file").setInputFiles({
    buffer: Buffer.from(SKETCH_DXF, "utf8"),
    mimeType: "text/plain",
    name: "outline.dxf",
  });
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-import-error",
    /sketch-import\/no-active-sketch/,
  );
  // The error stays on the dialog's alert region; nothing imported.
  await expect(page.locator(ROOT)).toHaveAttribute(
    "data-import-dialog-open",
    "true",
  );
  await expect(page.locator(ROOT)).toHaveAttribute("data-import-source", "");
  await expect(page.locator("[data-cad-import-error]")).toContainText(
    "enter sketch mode",
  );
});
