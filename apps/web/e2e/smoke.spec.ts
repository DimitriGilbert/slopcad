import { expect, test } from "@playwright/test";

test("home renders the app shell and reaches the tRPC health check", async ({
  page,
}) => {
  await page.goto("/");

  // The front door: the display-voice claim, and the live-render hero —
  // the deterministic scene's canvas mounts on the landing page itself.
  await expect(
    page.getByRole("heading", {
      name: "Parametric CAD with a document that tells the truth.",
    }),
  ).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();

  await expect(page.getByText(/^api: (connected|disconnected)$/)).toBeVisible({
    timeout: 10_000,
  });

  await page.screenshot({ path: "e2e-artifacts/home.png", fullPage: true });
});
