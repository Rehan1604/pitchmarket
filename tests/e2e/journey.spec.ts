import { expect, test } from "@playwright/test";
import { completeOnboarding, credits, login, logout, register, uniqueName } from "./helpers";

test.describe.configure({ mode: "serial" });

const alice = uniqueName("alice");
const bob = uniqueName("bob");
let inviteUrl = "";
let playerPath = "";

test("1–8: register, onboard, browse the market, buy and sell with virtual credits", async ({ page }) => {
  await register(page, alice);
  await completeOnboarding(page, "Alice A");
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByText("Alice’s portfolio value")).toBeVisible();
  await expect(page.locator("p.scoreboard").first()).toContainText("100,000.00");

  // 3. Market
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Market" }).click();
  await expect(page.getByRole("heading", { name: "Market" })).toBeVisible();
  await expect(page.getByText(/Delayed data/)).toBeVisible(); // honest snapshot labelling
  const rows = page.locator("table tbody tr");
  await expect(rows.first()).toBeVisible();
  // Filter by position
  await page.getByRole("group", { name: "Position" }).getByRole("button", { name: "DEF" }).click();
  await expect(page).toHaveURL(/position=DEF/);
  await expect(page.locator("table tbody tr").first()).toContainText("DEF");

  // 4. Player page
  await page.locator("table tbody tr").first().getByRole("link").first().click();
  await page.waitForURL(/\/players\//);
  playerPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: "Price history" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Match by match" })).toBeVisible();

  // 5. Buy
  const price = credits(await page.locator("#trade").getByText("Market price").locator("..").locator("dd").textContent());
  await page.getByLabel("Shares", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Review buy order" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Confirm buy order" })).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm buy" }).click();
  await expect(dialog.getByRole("heading", { name: "Order filled" })).toBeVisible();
  await expect(dialog.getByText("Bought 3 ×")).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  // 6. Portfolio changed
  await page.goto("/portfolio");
  const holding = page.locator("#holdings table tbody tr");
  await expect(holding).toHaveCount(1);
  await expect(holding.first().locator("td").nth(1)).toHaveText("3");
  const cashText = await page.getByText("Cash", { exact: true }).locator("..").locator("p").nth(1).textContent();
  expect(credits(cashText)).toBeCloseTo(100_000 - 3 * price, -1);

  // 7. Sell one share from the portfolio
  await holding.first().getByRole("button", { name: /Sell/ }).click();
  const sellDialog = page.getByRole("dialog");
  await sellDialog.getByLabel("Shares", { exact: true }).fill("1");
  await sellDialog.getByRole("button", { name: "Review sell order" }).click();
  await page.getByRole("button", { name: "Confirm sell" }).click();
  await expect(page.getByRole("heading", { name: "Order filled" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Escape");

  // 8. Balances and history
  await page.reload();
  await expect(page.locator("#holdings table tbody tr").first().locator("td").nth(1)).toHaveText("2");
  const history = page.locator("#history table tbody tr");
  await expect(history).toHaveCount(2);
  await expect(history.first()).toContainText("Sell 1");
  await expect(history.nth(1)).toContainText("Buy 3");
});

test("9: create a private league and get an invite link", async ({ page }) => {
  await login(page, alice);
  await page.goto("/social");
  await page.getByRole("button", { name: "Create league" }).click();
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("E2E Sunday League");
  await page.getByRole("dialog").getByRole("button", { name: "Create league" }).click();
  const link = page.getByRole("dialog").getByLabel("Invite link", { exact: true });
  await expect(link).toHaveValue(/\/join\/[A-Z0-9]{10}$/);
  inviteUrl = await link.inputValue();
  await page.getByRole("button", { name: "Open league" }).click();
  await page.waitForURL(/\/leagues\//);
  await expect(page.getByRole("heading", { name: "E2E Sunday League" })).toBeVisible();
});

test("10–11: a second user joins via the link and sends a friend request", async ({ page }) => {
  const joinPath = new URL(inviteUrl).pathname;
  await page.goto(joinPath);
  await expect(page.getByRole("heading", { name: "E2E Sunday League" })).toBeVisible();
  await page.getByRole("link", { name: "Create an account to join" }).click();
  await register(page, bob, { next: joinPath });
  await completeOnboarding(page, "Bob B");
  await page.waitForURL(new RegExp(joinPath));
  await page.getByRole("button", { name: /Join E2E Sunday League/ }).click();
  await page.waitForURL(/\/leagues\//);
  await expect(page.getByRole("heading", { name: "Members (2)" })).toBeVisible();

  await page.goto("/social");
  await page.getByLabel("Find managers by username").fill(alice);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(`Friend request sent to Alice A`)).toBeVisible();
  await logout(page);
});

test("11–13: accept the request; both appear on leaderboards; data persists after reload", async ({ page }) => {
  await login(page, alice);
  await page.goto("/social");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("You and Bob B are now friends")).toBeVisible();
  await expect(page.locator("#friends-title")).toHaveText("Friends (1)");

  await page.goto("/leaderboard?scope=friends");
  const board = page.locator("table tbody tr");
  await expect(board).toHaveCount(2);
  await expect(page.getByRole("link", { name: /Alice A/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Bob B/ })).toBeVisible();

  await page.goto("/leaderboard?scope=league");
  await expect(page.locator("table tbody tr")).toHaveCount(2);

  await page.goto("/leaderboard?scope=global");
  await expect(page.getByRole("link", { name: /Alice A/ })).toBeVisible();

  // Persistence: a fresh load still shows the position bought earlier.
  await page.goto("/portfolio");
  await page.reload();
  await expect(page.locator("#holdings table tbody tr")).toHaveCount(1);
  await page.goto(playerPath);
  await expect(page.locator("#position")).toContainText("Shares");
});

test("15: error states and unauthorised requests", async ({ page, request }) => {
  // Signed out → protected pages redirect to sign-in.
  await page.goto("/portfolio");
  await expect(page).toHaveURL(/\/login\?next=%2Fportfolio/);

  // Generic sign-in error.
  await page.getByLabel("Email or username").fill(alice);
  await page.getByLabel("Password", { exact: true }).fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "don't match" })).toHaveText("That email/username and password don't match.");

  // API without a session.
  const unauth = await request.post("/api/trades", { data: { playerId: 1, side: "buy", quantity: 1, idempotencyKey: "e2e-unauth-1" }, headers: { Origin: "http://localhost:3100" } });
  expect(unauth.status()).toBe(401);
  // Cross-site POST is blocked before anything else.
  const csrf = await request.post("/api/auth/login", { data: { identifier: alice, password: "x" }, headers: { Origin: "https://evil.example" } });
  expect(csrf.status()).toBe(403);
  // Cron endpoint requires the secret.
  expect((await request.get("/api/cron/tick")).status()).toBe(401);
  expect((await request.get("/api/cron/tick", { headers: { Authorization: "Bearer e2e-cron-secret-123456" } })).status()).toBe(200);

  // Signed in: unaffordable order is blocked in the ticket.
  await login(page, alice);
  await page.goto(playerPath);
  await page.getByLabel("Shares", { exact: true }).fill("4000");
  await expect(page.getByText(/You can afford up to|Orders are limited/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review buy order" })).toBeDisabled();

  // Forged price in the API is rejected and nothing executes.
  const forged = await page.request.post("/api/trades", {
    data: { playerId: 1, side: "buy", quantity: 1, idempotencyKey: "e2e-forged-price-1", expectedPriceCents: 1 },
    headers: { Origin: "http://localhost:3100" },
  });
  expect(forged.status()).toBe(409);
  expect((await forged.json()).error.code).toBe("PRICE_CHANGED");

  // Someone else's private league is invisible; a bad invite is explained.
  await page.goto("/leagues/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Out of play" })).toBeVisible();
  await page.goto("/join/NOTAREALCODE");
  await expect(page.getByRole("heading", { name: "Invite not valid" })).toBeVisible();

  // Non-admins can't reach admin.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/dashboard/);
  expect((await page.request.get("/api/admin/diagnostics")).status()).toBe(403);
});
