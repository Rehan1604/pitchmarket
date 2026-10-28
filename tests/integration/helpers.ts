import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { signup } from "@/server/auth/accounts";

let counter = 0;

export async function makeUser(prefix = "u") {
  counter += 1;
  const tag = `${prefix}${Date.now().toString(36).slice(-5)}${counter}`.slice(0, 20);
  const { userId } = await signup({ email: `${tag}@example.test`, username: tag, password: "correct-horse-battery", acceptTerms: true });
  await db.update(schema.users).set({ onboardedAt: new Date() }).where(eq(schema.users.id, userId));
  return { id: userId, username: tag, email: `${tag}@example.test` };
}

export async function anyPlayer(opts: { minPrice?: number; offset?: number } = {}) {
  const rows = await db
    .select({ id: schema.players.id, price: schema.playerPrices.priceCents, slug: schema.players.slug, clubId: schema.players.clubId })
    .from(schema.players)
    .innerJoin(schema.playerPrices, eq(schema.playerPrices.playerId, schema.players.id))
    .where(sql`${schema.players.isTradable} = true AND ${schema.playerPrices.liveFixtureId} IS NULL`)
    .orderBy(schema.players.id)
    .limit(1)
    .offset(opts.offset ?? 0);
  return rows[0];
}

export async function cash(userId: string) {
  const [a] = await db.select().from(schema.cashAccounts).where(eq(schema.cashAccounts.userId, userId));
  return a.balanceCents;
}

export async function position(userId: string, playerId: number) {
  const [p] = await db.select().from(schema.positions).where(sql`${schema.positions.userId} = ${userId} AND ${schema.positions.playerId} = ${playerId}`);
  return p ?? null;
}

export const key = () => `test-${randomUUID()}`;

export async function setMarket(status: "open" | "halted" | "maintenance", reason: string | null = null) {
  await db.update(schema.marketState).set({ status, statusReason: reason, statusSetBy: "admin" }).where(eq(schema.marketState.id, 1));
}
