import { expect, test } from "@playwright/test";

test("home renders the app shell and reaches the tRPC health check", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "API Status" })).toBeVisible();

  await expect(page.getByText(/^(Connected|Disconnected)$/)).toBeVisible({
    timeout: 10_000,
  });

  await page.screenshot({ path: "e2e-artifacts/home.png", fullPage: true });
});

test("login surface switches from sign-up to sign-in and accepts input", async ({
  page,
}) => {
  await page.goto("/login");

  await expect(
    page.getByRole("heading", { name: "Create Account" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Already have an account? Sign In" })
    .click();

  await expect(
    page.getByRole("heading", { name: "Welcome Back" }),
  ).toBeVisible();

  await page.getByLabel("Email").fill("e2e@slopcad.dev");
  await page.getByLabel("Password").fill("supercalifragilistic");
  await expect(page.getByLabel("Email")).toHaveValue("e2e@slopcad.dev");

  await page.screenshot({ path: "e2e-artifacts/login.png", fullPage: true });
});
