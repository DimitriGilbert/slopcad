import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TutorialDriver } from "../driver";
import type { ChapterModule } from "../narration";

/** The motion fixture's root (the session s20 machine surface). */
const MOTION_ROOT = "#assembly-motion-root";

/**
 * Chapter 23 — the assembly motion workbench. Component patterns and a
 * mirror stamp ordinary occurrences (with the id dedupe that makes a
 * second click a no-op), the explode state authors and scrubs
 * deterministically, the revolute joint swings inside its limits beside a
 * live clearance floor, the drag declines honestly, and the staleness
 * strip walks the cross-document revision rule (the s20 stage, at
 * teaching pace).
 */
export const chapter: ChapterModule = {
  definition: {
    id: "assembly-motion",
    title: "Assembly motion",
    summary:
      "Patterns and mirror stamps, the explode scrub, the revolute joint, the clearance floor, and the staleness rule.",
    cues: [
      {
        stepId: "boot",
        text: "Motion: patterns, explode, joints. Two plates to start.",
      },
      {
        stepId: "linear",
        text: "Linear pattern stamps three copies along the row — five plates.",
      },
      {
        stepId: "circular",
        text: "Circular pattern rings six more around the axis — eleven total.",
      },
      {
        stepId: "again",
        text: "Click it again: nothing double-stamps. Pattern ids refuse duplicates.",
      },
      {
        stepId: "mirror",
        text: "Mirror stamps one reflected copy across the plane — twelve.",
      },
      {
        stepId: "explode",
        text: "Author explode state: offsets for every instance, one record.",
      },
      {
        stepId: "quarter",
        text: "Scrub to a quarter: the copies separate proportionally.",
      },
      {
        stepId: "full",
        text: "Full factor restores the authored explode — deterministic, every time.",
      },
      {
        stepId: "joint",
        text: "The revolute joint swings its member — thirty degrees, in limits.",
      },
      {
        stepId: "joint-home",
        text: "Back to zero: the joint's home position.",
      },
      {
        stepId: "clearance",
        text: "The clearance floor measures the closest pair — always a number.",
      },
      {
        stepId: "decline",
        text: "Try joint drag: an honest decline — the solver owns motion.",
      },
      {
        stepId: "stale",
        text: "Edit the source part: the assembly goes STALE until regenerated.",
      },
      {
        stepId: "regenerate",
        text: "Regenerate: revisions agree again — up to date.",
      },
    ],
  },

  async run(page: Page, driver: TutorialDriver): Promise<void> {
    const root = page.locator(MOTION_ROOT);

    await driver.step("boot");
    await page.goto("/workbench-assembly-motion");
    await expect(root).toHaveAttribute("data-cad-hydrated", "true");
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "2");
    await expect(root).toHaveAttribute("data-cad-pattern-count", "0");
    await driver.dwell();

    await driver.step("linear");
    await driver.humanClick(page.getByTestId("motion-linear-pattern"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "5");

    await driver.step("circular");
    await driver.humanClick(page.getByTestId("motion-circular-pattern"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "11");

    await driver.step("again");
    await driver.humanClick(page.getByTestId("motion-circular-pattern"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "11");
    await driver.dwell();

    await driver.step("mirror");
    await driver.humanClick(page.getByTestId("motion-mirror"));
    await expect(root).toHaveAttribute("data-cad-occurrence-count", "12");
    await driver.dwell();

    await driver.step("explode");
    await driver.humanClick(page.getByTestId("motion-explode-author"));
    await expect(root).toHaveAttribute("data-cad-explode-active", "true");
    const authoredStamp = await root.getAttribute("data-cad-explode-scene");
    await driver.humanPoint(page.getByTestId("motion-explode-scrub"));
    await driver.dwell();

    await driver.step("quarter");
    const scrub = page.getByTestId("motion-explode-scrub");
    await scrub.fill("0.25");
    await expect(root).toHaveAttribute("data-cad-explode-factor", "0.25");
    const quarterStamp = await root.getAttribute("data-cad-explode-scene");
    expect(quarterStamp).not.toEqual(authoredStamp);
    await driver.dwell();

    await driver.step("full");
    await scrub.fill("1");
    await expect(root).toHaveAttribute(
      "data-cad-explode-scene",
      authoredStamp ?? "",
    );
    await driver.dwell();

    await driver.step("joint");
    const jointScrub = page.getByTestId("motion-joint-scrub");
    await driver.humanPoint(jointScrub);
    await jointScrub.fill("30");
    await expect(root).toHaveAttribute("data-cad-motion-parameter", "30.0");
    const motionAt30 = await root.getAttribute("data-cad-motion-scene");
    await driver.dwell();

    await driver.step("joint-home");
    await jointScrub.fill("0");
    await expect(root).toHaveAttribute("data-cad-motion-parameter", "0.0");
    const motionAt0 = await root.getAttribute("data-cad-motion-scene");
    expect(motionAt0).not.toEqual(motionAt30);
    await driver.dwell();

    await driver.step("clearance");
    const clearance = await root.getAttribute("data-cad-clearance-mm");
    expect(clearance ?? "").toMatch(/^\d+(\.\d+)?$/);
    await driver.pointAtReadout(page.getByTestId("motion-clearance"));
    await driver.dwell();

    await driver.step("decline");
    await driver.humanClick(page.getByTestId("motion-drag-decline"));
    await expect(page.getByTestId("motion-drag-decline-text")).toContainText(
      "mate solver",
    );
    await driver.dwell();

    await driver.step("stale");
    await expect(root).toHaveAttribute("data-cad-stale", "false");
    await driver.humanClick(page.getByTestId("motion-edit-source"));
    await expect(page.getByTestId("motion-stale-badge")).toHaveText("STALE");
    await driver.dwell();

    await driver.step("regenerate");
    await driver.humanClick(page.getByTestId("motion-regenerate"));
    await expect(page.getByTestId("motion-stale-badge")).toHaveText(
      "up to date",
    );
    await driver.pointAtReadout(page.getByTestId("motion-stale-badge"));
    await driver.dwell();
  },
};
