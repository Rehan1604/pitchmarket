import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http";
import { getMarketState } from "@/server/market/state";
import { failingJobs, recentRuns } from "@/server/ingestion/scheduler";

/**
 * Ledger invariants. In a healthy system every check returns zero offending rows:
 *  - cash_accounts.balance = Σ cash_entries.amount (per user)
 *  - positions.quantity = Σ buys − Σ sells (per user, player)
 *  - each trade's cash delta has a matching cash entry
 */
export async function invariantReport() {
  const cash = await db.execute<{ user_id: string; balance: string; ledger: string }>(sql`
    SELECT ca.user_id, ca.balance_cents AS balance, COALESCE(SUM(ce.amount_cents), 0) AS ledger
    FROM cash_accounts ca LEFT JOIN cash_entries ce ON ce.user_id = ca.user_id
    GROUP BY ca.user_id, ca.balance_cents
    HAVING ca.balance_cents <> COALESCE(SUM(ce.amount_cents), 0)`);
  const positions = await db.execute<{ user_id: string; player_id: number }>(sql`
    SELECT p.user_id, p.player_id FROM positions p
    LEFT JOIN (
      SELECT user_id, player_id, SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END) AS qty
      FROM trades GROUP BY user_id, player_id
    ) t ON t.user_id = p.user_id AND t.player_id = p.player_id
    WHERE p.quantity <> COALESCE(t.qty, 0)`);
  const orphanTrades = await db.execute<{ id: string }>(sql`
    SELECT t.id FROM trades t LEFT JOIN cash_entries ce ON ce.trade_id = t.id
    WHERE ce.id IS NULL OR ce.amount_cents <> t.cash_delta_cents`);
  return {
    cashMismatches: cash.rows.length,
    positionMismatches: positions.rows.length,
    tradesWithoutCashEntry: orphanTrades.rows.length,
    healthy: cash.rows.length === 0 && positions.rows.length === 0 && orphanTrades.rows.length === 0,
  };
}

export async function diagnostics() {
  const market = await getMarketState();
  const providers = await db.select().from(schema.providerStatus).orderBy(schema.providerStatus.provider);
  const runs = await recentRuns(40);
  const failures = await failingJobs(24);
  const counts = await db.execute<Record<string, number>>(sql`
    SELECT
      (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,
      (SELECT count(*)::int FROM users WHERE deleted_at IS NULL AND last_active_at > now() - interval '24 hours') AS active_24h,
      (SELECT count(*)::int FROM trades) AS trades,
      (SELECT count(*)::int FROM trades WHERE created_at > now() - interval '24 hours') AS trades_24h,
      (SELECT count(*)::int FROM players) AS players,
      (SELECT count(*)::int FROM players WHERE is_tradable) AS tradable_players,
      (SELECT count(*)::int FROM fixtures WHERE status = 'live') AS live_fixtures,
      (SELECT count(*)::int FROM fixtures WHERE status = 'finished' AND settled_at IS NULL) AS unsettled_fixtures,
      (SELECT count(*)::int FROM fixtures WHERE settled_at IS NOT NULL) AS settled_fixtures,
      (SELECT count(*)::int FROM leagues WHERE archived_at IS NULL) AS leagues,
      (SELECT count(*)::int FROM ingestion_runs WHERE rate_limited AND started_at > now() - interval '24 hours') AS rate_limited_24h`);
  const audits = await db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.createdAt)).limit(25);
  return { market, providers, runs, failures, counts: counts.rows[0], invariants: await invariantReport(), audits };
}

export async function setMarketStatus(adminId: string, status: "open" | "halted" | "maintenance", reason: string | null) {
  await getMarketState();
  await db
    .update(schema.marketState)
    .set({ status, statusReason: status === "open" ? null : reason || "Trading is paused by an administrator.", statusSetBy: "admin", updatedAt: new Date() })
    .where(eq(schema.marketState.id, 1));
  await audit({ userId: adminId, actor: "admin", action: "market.status_changed", metadata: { status, reason } });
}

export async function grantAdmin(email: string) {
  const res = await db
    .update(schema.users)
    .set({ role: "admin" })
    .where(sql`lower(${schema.users.email}) = ${email.toLowerCase()} AND ${schema.users.deletedAt} IS NULL`)
    .returning({ id: schema.users.id });
  if (res.length === 0) throw new HttpError(404, "NOT_FOUND", "No active user with that email.");
  await audit({ userId: res[0].id, actor: "system", action: "user.admin_granted" });
  return res[0].id;
}
