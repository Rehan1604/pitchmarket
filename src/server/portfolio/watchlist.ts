import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { HttpError, notFound } from "@/server/http";

const MAX_WATCHLIST = 100;

export async function setWatched(userId: string, playerId: number, watched: boolean) {
  const [p] = await db.select({ id: schema.players.id }).from(schema.players).where(eq(schema.players.id, playerId));
  if (!p) throw notFound("Player not found.");
  if (watched) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.watchlist).where(eq(schema.watchlist.userId, userId));
    if (n >= MAX_WATCHLIST) throw new HttpError(400, "WATCHLIST_FULL", `Your watchlist is limited to ${MAX_WATCHLIST} players.`);
    await db.insert(schema.watchlist).values({ userId, playerId }).onConflictDoNothing();
  } else {
    await db.delete(schema.watchlist).where(and(eq(schema.watchlist.userId, userId), eq(schema.watchlist.playerId, playerId)));
  }
  return { watched };
}
