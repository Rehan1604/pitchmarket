import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/server/env";
import { dataStatus, topMovers } from "@/server/market/queries";
import { unreadCount } from "@/server/social/profiles";

export const getShellData = cache(async (userId: string) => {
  const [acc] = await db.select({ cash: schema.cashAccounts.balanceCents }).from(schema.cashAccounts).where(eq(schema.cashAccounts.userId, userId));
  const [status, unread, movers] = await Promise.all([dataStatus(), unreadCount(userId), topMovers(8)]);
  const e = env();
  return {
    appName: e.APP_NAME,
    appMode: e.APP_MODE,
    cashCents: acc?.cash ?? 0,
    unread,
    status: {
      marketStatus: status.marketStatus,
      marketReason: status.marketReason,
      marketVersion: status.marketVersion,
      dataMode: status.dataMode,
      dataProvider: status.dataProvider,
      dataAsOf: status.dataAsOf?.toISOString() ?? null,
      lastPriceUpdateAt: status.lastPriceUpdateAt?.toISOString() ?? null,
      lastSuccessAt: status.lastSuccessAt?.toISOString() ?? null,
      liveMatches: status.liveMatches,
    },
    ticker: [...movers.risers, ...movers.fallers].map((m) => ({ slug: m.slug, name: m.name, club: m.club, priceCents: m.priceCents, previousPriceCents: m.previousPriceCents })),
  };
});

export type ShellStatus = Awaited<ReturnType<typeof getShellData>>["status"];
