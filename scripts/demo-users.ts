/**
 * Clearly-labelled demo accounts for demo instances (APP_MODE=demo only).
 * They are flagged is_demo = true and shown with a "Demo account" badge
 * everywhere, so nobody mistakes them for real managers. Each one holds a
 * deterministic portfolio bought through the real trading engine.
 *
 *   npm run db:seed -- --demo-users
 */
import "dotenv/config";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { signup } from "@/server/auth/accounts";
import { env } from "@/server/env";
import { createLeague, joinByCode } from "@/server/social/leagues";
import { executeTrade } from "@/server/trading/service";

const DEMO = [
  { username: "demo_gaffer", displayName: "The Gaffer", color: "#D4F55C", style: "stars" },
  { username: "demo_scout", displayName: "Moneyball Scout", color: "#7CC6FE", style: "value" },
  { username: "demo_keeper", displayName: "Clean Sheet Club", color: "#F2B544", style: "defence" },
  { username: "demo_winger", displayName: "Wing Wizard", color: "#FF8A7A", style: "form" },
] as const;

async function pick(style: (typeof DEMO)[number]["style"]) {
  const conds = [eq(schema.players.isTradable, true), sql`${schema.playerPrices.liveFixtureId} IS NULL`, sql`${schema.playerPrices.matchesPriced} >= 2`];
  if (style === "defence") conds.push(sql`${schema.players.position} IN ('GK','DEF')`);
  const order =
    style === "stars"
      ? desc(schema.playerPrices.priceCents)
      : style === "value"
        ? desc(sql`${schema.playerPrices.fundamentalCents}::float / ${schema.playerPrices.priceCents}`)
        : style === "defence"
          ? desc(schema.playerPrices.qualityIndex)
          : desc(schema.playerPrices.formIndex);
  return db
    .select({ id: schema.players.id, price: schema.playerPrices.priceCents })
    .from(schema.players)
    .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
    .where(and(...conds))
    .orderBy(order)
    .limit(style === "stars" ? 5 : 6);
}

export async function createDemoUsers() {
  if (env().APP_MODE !== "demo") {
    console.log(JSON.stringify({ msg: "skipping demo users: APP_MODE is not demo" }));
    return;
  }
  const ids: string[] = [];
  for (const d of DEMO) {
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.username}) = ${d.username}`);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const { userId } = await signup({ email: `${d.username}@demo.pitchmarket.invalid`, username: d.username, password: `demo-${crypto.randomUUID()}`, acceptTerms: true });
    await db.update(schema.users).set({ isDemo: true, displayName: d.displayName, avatarColor: d.color, onboardedAt: new Date(), portfolioVisibility: "public", activityVisibility: "public" }).where(eq(schema.users.id, userId));
    const picks = await pick(d.style);
    const budget = 9_000_000; // spend ~90% of the starting balance, evenly
    for (const p of picks) {
      const qty = Math.floor(budget / picks.length / p.price);
      if (qty > 0) await executeTrade({ userId, playerId: p.id, side: "buy", quantity: qty, idempotencyKey: `demo-seed-${d.username}-${p.id}` });
    }
    ids.push(userId);
  }
  const [hasLeague] = await db.select({ id: schema.leagues.id }).from(schema.leagues).where(eq(schema.leagues.name, "Demo League"));
  if (!hasLeague) {
    const { invite } = await createLeague(ids[0], { name: "Demo League", description: "Sample league of demo accounts. Join it to see how standings work.", visibility: "public", maxMembers: 100, membersCanInvite: true });
    for (const id of ids.slice(1)) await joinByCode(id, invite.code);
  }
  console.log(JSON.stringify({ msg: "demo users ready", count: ids.length }));
}

if (process.argv[1]?.endsWith("demo-users.ts")) {
  createDemoUsers()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => (await import("@/db")).closeDb());
}
