import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import { COMPLETE, COMPLETE_ROOT, volumeNear } from "../../e2e-session/helpers";

/**
 * The OBJ teaching file (the session s09b bytes): a closed 10 × 20 × 4
 * box as twelve triangles — real mesh text a human could have exported
 * from anywhere.
 */
const PLATE_OBJ = [
  "o plate",
  "v 0 0 0",
  "v 10 0 0",
  "v 10 20 0",
  "v 0 20 0",
  "v 0 0 4",
  "v 10 0 4",
  "v 10 20 4",
  "v 0 20 4",
  "f 1 3 2",
  "f 1 4 3",
  "f 5 6 7",
  "f 5 7 8",
  "f 1 2 6",
  "f 1 6 5",
  "f 3 4 8",
  "f 3 8 7",
  "f 2 3 7",
  "f 2 7 6",
  "f 4 1 5",
  "f 4 5 8",
  "",
].join("\n");

/**
 * Chapter 28 — the model exchange. The export dialog lists the honest
 * exporter family and the STL run holds real, sized bytes; the import
 * dialog spans six formats across browser and worker with no DWG; the
 * held STL returns as a geometry-only preview that matches the document's
 * volume; and a real OBJ file imports through the same dialog (the s09
 * and s09b stages, at teaching pace on the default route).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "io-import-export",
    title: "Import and export",
    summary:
      "The honest exporter family, STL bytes held and round-tripped as a preview, the six-format import breadth, and a real OBJ file.",
    cues: [
      {
        stepId: "boot",
        text: "Exchange: real bytes in, real bytes out. The complete workbench.",
      },
      {
        stepId: "export-dialog",
        text: "The export family is honest: STL, 3MF, GLB — no IGES promise.",
      },
      {
        stepId: "stl-hold",
        text: "STL holds real, sized bytes — the entry counts its triangles.",
      },
      {
        stepId: "formats",
        text: "Import reads six formats across browser and worker — and no DWG.",
      },
      {
        stepId: "held-stl",
        text: "The held STL returns as a preview: geometry only, not the document.",
      },
      {
        stepId: "back",
        text: "Back to model clears the preview — the document never changed.",
      },
      {
        stepId: "obj",
        text: "A real OBJ file imports the same way: twelve triangles, 800 mm³.",
      },
      {
        stepId: "recap",
        text: "Bytes out, bytes in — the exchange never fakes a format.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("boot");
    const appliedVolume = await driver.arriveAtWorkbench();
    expect(Number(appliedVolume)).toBeGreaterThan(0);
    await driver.dwell();

    // The dialog openings ride the previous cue's tail; each cue's beat
    // opens with the surface its narration describes already on screen.
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );

    await driver.step("export-dialog");
    for (const format of ["stl", "3mf", "glb"]) {
      await expect(
        page.locator(`[data-testid="cad-export-run-${format}"]`),
      ).toBeAttached();
    }
    expect(
      await page.locator('[data-testid="cad-export-run-iges"]').count(),
      "IGES export must not ship (the documented decline)",
    ).toBe(0);
    await driver.humanPoint(page.locator('[data-testid="cad-export-run-stl"]'));
    await driver.dwell();

    await driver.step("stl-hold");
    await driver.humanClick(page.getByTestId("cad-export-run-stl"));
    const entry = page.locator('[data-cad-export-entry="stl"]');
    await expect(entry).toContainText("triangles");
    const held = JSON.parse(
      (await page.locator(COMPLETE).getAttribute("data-export-held")) ?? "{}",
    ) as Record<string, number>;
    expect(held.stl).toBeGreaterThan(0);
    await driver.pointAtReadout(entry);
    await driver.dwell();

    await page.keyboard.press("Escape");
    await driver.humanClick(page.getByTestId("complete-import"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "true",
    );

    await driver.step("formats");
    for (const format of ["stl", "3mf", "obj", "step", "brep", "iges"]) {
      await expect(
        page.locator(`[data-cad-import-format="${format}"]`),
      ).toBeAttached();
    }
    expect(
      await page.locator('[data-cad-import-format="dwg"]').count(),
      "DWG import must not ship (the documented decline)",
    ).toBe(0);
    await driver.humanPoint(page.locator('[data-cad-import-format="obj"]'));
    await driver.dwell();

    await driver.step("held-stl");
    await driver.humanClick(page.getByTestId("cad-import-held-stl"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "false",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "import",
    );
    await page.waitForFunction((rootId) => {
      const root = document.getElementById(rootId);
      const volume = root?.getAttribute("data-import-volume") ?? "";
      const settle = root?.getAttribute("data-cad-imported-volume") ?? "";
      return volume !== "" && volume === settle;
    }, COMPLETE_ROOT);
    expect(
      volumeNear(
        Number(
          (await page.locator(COMPLETE).getAttribute("data-import-volume")) ??
            "0",
        ),
        Number(appliedVolume),
      ),
    ).toBe(true);
    await driver.humanPoint(page.getByText(/preview: stl mesh/));
    await driver.dwell();

    await driver.step("back");
    await driver.humanClick(page.getByTestId("complete-clear-import"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "document",
    );
    await driver.dwell();

    await driver.humanClick(page.getByTestId("complete-import"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "true",
    );

    await driver.step("obj");
    await page.getByTestId("cad-import-file").setInputFiles({
      buffer: Buffer.from(PLATE_OBJ, "utf8"),
      mimeType: "text/plain",
      name: "plate.obj",
    });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-source",
      "obj",
    );
    await expect
      .poll(async () =>
        page.locator(COMPLETE).getAttribute("data-import-triangles"),
      )
      .toBe("12");
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-volume",
      "800.000",
    );
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "import",
    );
    await driver.humanPoint(page.getByText(/preview: obj mesh/));
    await driver.dwell();

    await driver.step("recap");
    await driver.humanClick(page.getByTestId("complete-clear-import"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-viewport-showing",
      "document",
    );
    await driver.dwell(1_200);
  },
};
