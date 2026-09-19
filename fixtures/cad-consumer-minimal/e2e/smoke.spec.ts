import { expect, test } from "@playwright/test";

/**
 * The minimal consumer's browser smoke (Phase 35.4): the installed
 * `nema17-mount` builds through the Manifold kernel in the page, the
 * installed `CadViewport` renders it, and the settled frame fires — the
 * smallest end-to-end proof the minimal install set is complete.
 */

test("the minimal consumer builds and settles the installed mount", async ({
  page,
}) => {
  await page.goto("/");

  const root = page.locator("#minimal-root");
  await expect(root).toHaveAttribute("data-status", "ok", { timeout: 60_000 });
  await expect(root).toHaveAttribute("data-volume", /\d+(\.\d+)? mm³/u);
  // The viewport's first settled demand frame for the built projection.
  await expect(root).toHaveAttribute("data-settled", /[1-9]\d*/u, {
    timeout: 60_000,
  });
  const volume = await root.getAttribute("data-volume");
  if (volume === null || Number.parseFloat(volume) <= 0) {
    throw new Error(`The mount volume is not a positive number: ${volume}`);
  }
});
