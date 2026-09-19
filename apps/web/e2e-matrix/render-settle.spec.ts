import { expect, test } from "@playwright/test";

import { waitForSettledScene } from "../e2e-render/helpers";

/**
 * Phase 35.3 browser compatibility matrix — the WebGL render-stamp
 * battery: the deterministic scene must SETTLE (the R3F frame stamp
 * `data-cad-rendered-volume` agreeing with the worker's volume) and
 * re-settle after parametric edits, on every engine that has software
 * WebGL headlessly.
 *
 * Chromium (SwiftShader) and WebKit (its own software WebGL) qualify.
 * Firefox is an EXPLICIT, reasoned skip — not a silent one: headless
 * Firefox creates no WebGL context on this host (no GPU, no Xvfb to
 * virtualize one, no sudo to install it), so its coverage is the
 * DOM-level battery in `workflows.spec.ts`, which runs on all three
 * engines and proves the same parametric model without the rendered
 * frame.
 */

const ROOT = "workbench-complete-root";

// The skip below is deliberately loud: every run's report carries it.
test.skip(
  ({ browserName }) => browserName === "firefox",
  "headless Firefox has no WebGL on this machine (no GPU, no Xvfb, no sudo); the DOM-level battery in workflows.spec.ts carries Firefox coverage",
);

test("the scene settles with the render stamp agreeing with the volume", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  const volume = await waitForSettledScene(page, ROOT);
  expect(Number(volume)).toBeGreaterThan(0);
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-cad-rendered-volume",
    volume,
  );
  // No screenshot artifact here, by design: this battery's terminal visual
  // state is byte-identical to the workflows battery's fresh-open capture
  // (both park the pointer at (4,4), blur, wait 300ms over the same settled
  // deterministic software-WebGL scene — proven identical when both were
  // captured), so the artifact set carries it once, under the
  // `<engine>-fresh-open.png` name that exists for every engine. The
  // assertion above (render stamp == worker volume) is this test's real
  // deliverable.
});

test("a parametric edit re-settles the scene at the new volume", async ({
  page,
}) => {
  await page.goto("/workbench-complete");
  const bootVolume = await waitForSettledScene(page, ROOT);

  await page.getByLabel("holeDiameter", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(`#${ROOT}`)).toHaveAttribute(
    "data-hole-diameter",
    "10",
  );
  const editedVolume = await waitForSettledScene(page, ROOT);
  expect(editedVolume).not.toBe(bootVolume);
});
