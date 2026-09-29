import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

import {
  collectDownloads,
  COMPLETE,
  COMPLETE_ROOT,
  readTimeline,
  waitForRootSettle,
} from "../../e2e-session/helpers";

/** The volume readout the complete composition mounts (root-independent). */
const VOLUME_READOUT = "#workbench-complete-volume";

/** The hub-mount fixture's five features, in authored order. */
const HUB_MOUNT_TIMELINE = "extrude,revolve,loft,subtract,union";

/** The committed hub-mount fixture (the s26c bytes), read once per worker. */
const HUB_MOUNT_MODEL = readFileSync(
  new URL("../../e2e-session/fixtures/hub-mount.model.tsx", import.meta.url),
);

/**
 * Chapter 29 — the .tsx model exchange, this branch's headline surface.
 * A .tsx model is a JSX-authored document (parameters, sketches, features
 * — code agents write with the slopcad-cad-jsx skill); the import dialog
 * sends the committed hub-mount fixture through the real server loader,
 * the native document lands as an editable session, the TSX export
 * generates the model source back, and the held bytes re-import to the
 * identical timeline (the s26c stage, at teaching pace — it rides the
 * projects chapter's sign-in, exactly as s26c rides s26).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "tsx-exchange",
    title: "The .tsx model exchange",
    summary:
      "Import a JSX-authored model through the real dialog, watch it land as an editable document, export TSX back, and round-trip the held bytes.",
    cues: [
      {
        stepId: "boot",
        text: "The .tsx exchange: CAD models as code, compiled in the browser.",
      },
      {
        stepId: "what",
        text: "A .tsx model is a JSX document: parameters, sketches, features.",
      },
      {
        stepId: "dialog",
        text: "The import dialog takes a .tsx file beside the meshes.",
      },
      {
        stepId: "import",
        text: "Import the hub mount: authored in TypeScript, five features.",
      },
      {
        stepId: "landed",
        text: "The tree lands the mount body; the timeline reads authored order.",
      },
      {
        stepId: "settled",
        text: "The scene settles into a real solid — editable like any document.",
      },
      {
        stepId: "export",
        text: "Export TSX generates the model source — the compiler's inverse.",
      },
      {
        stepId: "skill",
        text: "The slopcad-cad-jsx skill authors these: read, edit, re-run.",
      },
      {
        stepId: "roundtrip",
        text: "Round trip: the held TSX re-imports to the identical timeline.",
      },
      {
        stepId: "recap",
        text: "One format, both directions, zero transcription loss.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    await driver.step("boot");
    const bootVolume = await driver.arriveAtWorkbench();
    expect(Number(bootVolume)).toBeGreaterThan(0);
    await driver.dwell();

    await driver.step("what");
    const plateRow = page.locator('[data-node-key="body|body_plate"]');
    await expect(plateRow).toBeVisible();
    await driver.humanPoint(plateRow);
    await driver.dwell();

    // The dialog journey rides the what cue's tail; the beat opens with
    // the dialog and its .tsx row already on screen.
    await driver.humanClick(page.getByTestId("complete-import"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "true",
    );

    await driver.step("dialog");
    const tsxRow = page.locator('[data-cad-import-format="tsx"]');
    await expect(tsxRow).toBeVisible();
    await driver.humanPoint(tsxRow);
    await driver.dwell();

    await driver.step("import");
    await page.getByTestId("cad-import-file").setInputFiles({
      buffer: HUB_MOUNT_MODEL,
      mimeType: "text/plain",
      name: "hub-mount.model.tsx",
    });
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "false",
    );

    await driver.step("landed");
    const mountBody = page.locator('[data-node-key="body|body_mount"]');
    await expect(
      page.locator('[data-node-key="feature|feat_mount"]'),
    ).toBeVisible();
    await expect(mountBody).toBeVisible();
    await expect
      .poll(async () =>
        (await readTimeline(page, COMPLETE_ROOT)).entries
          .map((entry) => entry.kind)
          .join(","),
      )
      .toBe(HUB_MOUNT_TIMELINE);
    await driver.humanPoint(mountBody);
    await driver.dwell();

    await driver.step("settled");
    const settled = await waitForRootSettle(page, COMPLETE_ROOT);
    expect(Number(settled)).toBeGreaterThan(0);
    await driver.pointAtReadout(page.locator(VOLUME_READOUT));
    await driver.dwell();

    // The export dialog journey rides the settled cue's tail.
    await driver.humanClick(page.getByTestId("complete-export"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-export-dialog-open",
      "true",
    );

    await driver.step("export");
    await driver.humanClick(page.getByTestId("cad-export-run-tsx"));
    const entry = page.locator('[data-cad-export-entry="tsx"]');
    await expect(entry).toContainText("full document round-trip");
    await driver.pointAtReadout(entry);
    await driver.dwell();

    await driver.step("skill");
    const downloads = await collectDownloads(
      page,
      () => driver.humanClick(page.getByTestId("cad-export-download-tsx")),
      1,
      15_000,
    );
    const exported = await downloads[0]?.path();
    if (exported === undefined) {
      throw new Error("the TSX export did not land");
    }
    const source = await readFile(exported, "utf8");
    expect(source).toContain("Generated by `generateTsx`");
    expect(source).toContain('from "@slopcad/cad-jsx"');
    expect(source).toContain("<Extrude");
    expect(source).toContain('feature={"feat_plate"}');
    expect(source).not.toContain("DECLINED RECORDS");
    await driver.dwell();

    // The round-trip journey rides the skill cue's tail: close the export
    // dialog, reopen import, and take the held .tsx.
    await page.keyboard.press("Escape");
    await driver.humanClick(page.getByTestId("complete-import"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "true",
    );

    await driver.step("roundtrip");
    await driver.humanClick(page.getByTestId("cad-import-held-tsx"));
    await expect(page.locator(COMPLETE)).toHaveAttribute(
      "data-import-dialog-open",
      "false",
    );
    await expect
      .poll(async () =>
        (await readTimeline(page, COMPLETE_ROOT)).entries
          .map((entry) => entry.kind)
          .join(","),
      )
      .toBe(HUB_MOUNT_TIMELINE);
    const roundTripped = await waitForRootSettle(page, COMPLETE_ROOT);
    expect(Number(roundTripped)).toBeGreaterThan(0);
    await driver.pointAtReadout(page.locator(VOLUME_READOUT));
    await driver.dwell();

    await driver.step("recap");
    await driver.dwell(1_200);
  },
};
