import { expect, test } from "@playwright/test";
import { completeOnboarding, register, uniqueName } from "./helpers";

test("14: mobile layout and core navigation", async ({ page }) => {
  const user = uniqueName("mob");
  await register(page, user);
  await completeOnboarding(page);
  await page.waitForURL(/\/dashboard/);

  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeVisible();
  // Desktop side rail is hidden; the bottom bar is the navigation.
  await expect(nav.getByRole("link", { name: "Market" })).toBeVisible();
  await nav.getByRole("link", { name: "Market" }).click();
  await page.waitForURL(/\/market/);
  // Cards, not the wide table, on small screens.
  await expect(page.locator("table").first()).toBeHidden();
  const firstCard = page.locator("ul li.panel").first();
  await expect(firstCard).toBeVisible();
  await firstCard.getByRole("link").first().click();
  await page.waitForURL(/\/players\//);
  await expect(page.getByRole("button", { name: "Review buy order" })).toBeVisible();

  await nav.getByRole("link", { name: "Portfolio" }).click();
  await page.waitForURL(/\/portfolio/);
  await nav.getByRole("link", { name: "Leaderboard" }).click();
  await page.waitForURL(/\/leaderboard/);
  await nav.getByRole("link", { name: "Social" }).click();
  await page.waitForURL(/\/social/);

  // No horizontal overflow on the main pages.
  for (const path of ["/dashboard", "/market", "/portfolio", "/leaderboard", "/social", "/fixtures"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});
