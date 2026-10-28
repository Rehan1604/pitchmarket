import { expect, type Page } from "@playwright/test";

export const PASSWORD = "correct-horse-battery";

export function uniqueName(prefix: string) {
  return `${prefix}${Date.now().toString(36).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`.slice(0, 20);
}

export async function register(page: Page, username: string, opts: { next?: string } = {}) {
  await page.goto(opts.next ? `/signup?next=${encodeURIComponent(opts.next)}` : "/signup");
  await page.getByLabel("Email", { exact: true }).fill(`${username}@example.test`);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding/);
}

export async function completeOnboarding(page: Page, displayName?: string) {
  await expect(page.getByRole("heading", { name: /Pitch Credits/ })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  if (displayName) await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Start trading" }).click();
}

export async function login(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard/);
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
}

export function credits(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9.−-]/g, "").replace("−", "-"));
}
