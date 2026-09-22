import { expect, test } from "@playwright/test";

/**
 * The /docs documentation application's browser gate (Phase 34): every
 * live example on the page must reach `ok` with the SAME measured values
 * the workspace suite asserts (the page runs the identical code from
 * `@slopcad/docs-examples`), the Manifold-backed render must settle, the
 * capability matrix and format table must render their ground truths,
 * and the interactive React example must edit a real parameter. A
 * full-page screenshot lands in `e2e-artifacts/docs/`.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/docs");
});

test("every live example reaches ok with the documented values", async ({
  page,
}) => {
  const statuses = page.getByTestId("docs-example-status");
  // Phase 36 added the sketch-vocabulary card: nine live examples today.
  await expect(statuses).toHaveCount(9);
  // The async cards boot the real Manifold WASM kernel in-process; every
  // card — sync and async — must end at "ok".
  for (let index = 0; index < 9; index += 1) {
    await expect(statuses.nth(index)).toHaveText("ok", { timeout: 30_000 });
  }
});

test("the document and units example reports the guide's numbers", async ({
  page,
}) => {
  await expect(page.getByTestId("docs-fact-hole-diameter")).toHaveText(
    "10 → 12.5 mm",
  );
  await expect(
    page.getByTestId("docs-fact-volume-hint-hole-diameter-2"),
  ).toHaveText("20 → 25");
  await expect(page.getByTestId("docs-fact-1-inch")).toHaveText("25.4 mm");
});

test("the kernel example measures real Manifold geometry", async ({ page }) => {
  await expect(page.getByTestId("docs-fact-backend")).toHaveText("manifold");
  await expect(page.getByTestId("docs-fact-box-volume")).toHaveText(
    "6000.00 mm³",
  );
  await expect(page.getByTestId("docs-fact-box-area")).toHaveText(
    "2200.00 mm²",
  );
  await expect(page.getByTestId("docs-fact-union-half-overlap")).toHaveText(
    "9000.00 mm³",
  );
});

test("the feature regeneration example executes the box → hole chain", async ({
  page,
}) => {
  await expect(page.getByTestId("docs-fact-feature-kinds")).toHaveText(
    "box → hole",
  );
  const hole = page.getByTestId("docs-fact-volume-after-d8-hole");
  await expect(hole).toContainText("5799");
  const edited = page.getByTestId("docs-fact-volume-after-d10-edit");
  await expect(edited).toContainText("mm³");
  const holeText = (await hole.textContent()) ?? "";
  const editedText = (await edited.textContent()) ?? "";
  const holeVolume = Number.parseFloat(holeText);
  const editedVolume = Number.parseFloat(editedText);
  expect(Number.isFinite(holeVolume)).toBe(true);
  expect(Number.isFinite(editedVolume)).toBe(true);
  expect(editedVolume).toBeLessThan(holeVolume);
  await expect(page.getByTestId("docs-fact-states-after-edit")).toHaveText(
    "valid, valid",
  );
});

test("the component example builds the shipped NEMA 17 mount", async ({
  page,
}) => {
  await expect(page.getByTestId("docs-fact-bodies-built")).toHaveText("1");
  const volume = page.getByTestId("docs-fact-nema17-volume");
  const edited = page.getByTestId("docs-fact-plate-size-mm-46-52");
  await expect(volume).toContainText("mm³");
  await expect(edited).toContainText("mm³");
  const defaultText = (await volume.textContent()) ?? "";
  const editedText = (await edited.textContent()) ?? "";
  expect(editedText).not.toBe(defaultText);
});

test("the mesh example round-trips deterministic bytes", async ({ page }) => {
  await expect(page.getByTestId("docs-fact-stl-bytes-12-triangles")).toHaveText(
    "684",
  );
  await expect(page.getByTestId("docs-fact-stl-deterministic")).toHaveText(
    "yes",
  );
  await expect(page.getByTestId("docs-fact-3-mf-bytes-unit")).toContainText(
    "millimeter",
  );
});

test("the sketch example solves to zero degrees of freedom", async ({
  page,
}) => {
  await expect(page.getByTestId("docs-fact-dof-before-constraints")).toHaveText(
    "12",
  );
  await expect(page.getByTestId("docs-fact-dof-after")).toHaveText("0");
  await expect(page.getByTestId("docs-fact-ab-solved")).toContainText("50");
  await expect(page.getByTestId("docs-fact-profile-signed-area")).toContainText(
    "600",
  );
});

test("the native format example keeps the full history", async ({ page }) => {
  await expect(page.getByTestId("docs-fact-replayed-transactions")).toHaveText(
    "3",
  );
  await expect(page.getByTestId("docs-fact-reopened-hole-diameter")).toHaveText(
    "12 mm",
  );
  await expect(page.getByTestId("docs-fact-resave-identical")).toHaveText(
    "yes",
  );
  await expect(page.getByTestId("docs-fact-validator-issues")).toHaveText("0");
});

test("the Manifold-rendered viewport settles", async ({ page }) => {
  await expect(page.getByTestId("docs-render-status")).toHaveText("settled", {
    timeout: 30_000,
  });
});

test("the interactive React example edits a real parameter", async ({
  page,
}) => {
  const value = page.getByTestId("guide-hole-value");
  await expect(value).toHaveText("10");
  // Hydration gate: SSR paints the same "10", so the text alone cannot
  // prove the button's onClick is attached — a click landing inside the
  // hydrating window is silently lost (observed under full-battery load).
  // A live example reaching "ok" is client-only output (useEffect flips
  // "running" → "ok") from the same hydration root, so it proves the
  // client has committed and the listener is live before the click.
  await expect(page.getByTestId("docs-example-status").first()).toHaveText(
    "ok",
    { timeout: 30_000 },
  );
  // Even past the hydration gate a click can still be lost under full
  // 10-harness concurrency (the event's landing races the last hydrating
  // commit), so the click itself carries a bounded verify-and-retry: click,
  // poll for the parameter change, and click again only when a short
  // deadline proves the click never landed — three attempts, then the
  // ordinary assertion reports the honest failure.
  const widen = page.getByRole("button", { name: "Widen the hole" });
  await expect(widen).toBeEnabled();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await widen.click();
    try {
      await expect(value).toHaveText("12", { timeout: 1_500 });
      break;
    } catch {
      // The value never moved: the click was lost — click again.
    }
  }
  await expect(value).toHaveText("12");
});

test("the capability matrix renders the kernels' declared flags", async ({
  page,
}) => {
  await expect(page.locator('[data-flag="manifold:sweep"]')).toHaveText(/—/);
  await expect(
    page.locator('[data-flag="manifold:persistentTopology"]'),
  ).toHaveText(/—/);
  await expect(page.locator('[data-flag="opencascade:fillet"]')).toHaveText(
    /✓/,
  );
  await expect(page.locator('[data-flag="jscad:loft"]')).toHaveText(/✓/);
  await expect(page.locator('[data-flag="fake:shell"]')).toHaveText(/✓/);
});

test("the format table marks exactly the native format as history-preserving", async ({
  page,
}) => {
  await expect(page.getByTestId("docs-format-native")).toHaveText("preserved");
  for (const format of ["step", "occt", "iges", "stl", "3mf", "glb"]) {
    await expect(page.getByTestId(`docs-format-${format}`)).toHaveText("—");
  }
});

test("the topic map lists every documented topic", async ({ page }) => {
  const sidebar = page.getByRole("navigation", {
    name: "Documentation topics",
  });
  // 25 topic links plus the 7 group-section links.
  await expect(sidebar.getByRole("link")).toHaveCount(32);
});

test("captures the page", async ({ page }) => {
  await expect(page.getByTestId("docs-render-status")).toHaveText("settled", {
    timeout: 30_000,
  });
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await page.screenshot({
    path: "e2e-artifacts/docs/docs.png",
    fullPage: true,
  });
});
