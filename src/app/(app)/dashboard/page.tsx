import { and, desc, eq } from "drizzle-orm";
import { ArrowDownRight, ArrowUpRight, Eye, Radio } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { db, schema } from "@/db";
import { DataNotice } from "@/components/market/data-notice";
import { Change, Credits, PlayerMark, PositionBadge, Sparkline } from "@/components/market/atoms";
import { ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState, Panel, StatTile } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { nowMs } from "@/lib/clock";
import { kickoff, timeAgo } from "@/lib/format";
import { changeBps, formatCredits } from "@/lib/money";
import { requirePageUser } from "@/server/auth/current-user";
import { rankOf } from "@/server/leaderboard/service";
import { listFixtures, listMarket, marketFilterSchema, topMovers } from "@/server/market/queries";
import { getPortfolio, getTrades, isoDay } from "@/server/portfolio/valuation";
import { listMyLeagues } from "@/server/social/leagues";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requirePageUser();
  const [portfolio, movers, live, upcoming, watch, trades, global, friends, leagues, sod] = await Promise.all([
    getPortfolio(user.id),
    topMovers(5),
    listFixtures({ status: "live", limit: 10 }),
    listFixtures({ status: "upcoming", limit: 6 }),
    listMarket(marketFilterSchema.parse({ watchlist: "1", pageSize: 10, sort: "change" }), user.id),
    getTrades(user.id, { limit: 6 }),
    user.showOnGlobalLeaderboard ? rankOf({ kind: "global" }, user.id) : Promise.resolve(null),
    rankOf({ kind: "friends", userId: user.id }, user.id),
    listMyLeagues(user.id),
    db
      .select({ value: schema.portfolioSnapshots.valueCents })
      .from(schema.portfolioSnapshots)
      .where(and(eq(schema.portfolioSnapshots.userId, user.id), eq(schema.portfolioSnapshots.day, isoDay(new Date()))))
      .orderBy(desc(schema.portfolioSnapshots.takenAt))
      .limit(1),
  ]);
  const leagueRanks = await Promise.all(leagues.slice(0, 4).map(async (l) => ({ ...l, rank: await rankOf({ kind: "league", leagueId: l.id }, user.id) })));
  if (!portfolio) return null;
  const startOfDay = sod[0]?.value ?? null;
  const todayBps = startOfDay ? changeBps(startOfDay, portfolio.totalValueCents) : null;
  const firstName = user.displayName.split(" ")[0];

  return (
    <>
      <DataNotice />
      <section aria-labelledby="value-title" className="mb-6 grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="panel pitch-lines relative overflow-hidden p-5 sm:p-7">
          <p id="value-title" className="text-sm text-chalk-3">
            {firstName}’s portfolio value
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2">
            <p className="scoreboard text-[56px] text-chalk sm:text-[76px]">
              {formatCredits(portfolio.totalValueCents)}
              <span className="ml-2 align-top font-sans text-base font-medium text-chalk-3">PC</span>
            </p>
            <div className="pb-2">
              <Change bps={portfolio.returnBps} size="lg" />
              <p className="text-[12.5px] text-chalk-3">since you started with {formatCredits(portfolio.startingCents, { decimals: 0 })} PC</p>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-5 border-t border-line pt-5 sm:grid-cols-4">
            <StatTile label="Today" value={todayBps === null ? "—" : <Change bps={todayBps} size="lg" />} sub={todayBps === null ? "Starts after the first daily snapshot" : "vs start of day (UTC)"} />
            <StatTile label="Cash" value={<Credits cents={portfolio.cashCents} decimals={0} />} sub="Ready to trade" />
            <StatTile label="In players" value={<Credits cents={portfolio.holdingsValueCents} decimals={0} />} sub={`${portfolio.holdings.length} holding${portfolio.holdings.length === 1 ? "" : "s"}`} />
            <StatTile
              label="Unrealized"
              value={<Credits cents={portfolio.unrealizedCents} decimals={0} sign />}
              tone={portfolio.unrealizedCents > 0 ? "gain" : portfolio.unrealizedCents < 0 ? "loss" : null}
              sub={`Realized ${formatCredits(portfolio.realizedCents, { decimals: 0, sign: true })} PC`}
            />
          </div>
        </div>

        <Panel title="Where you stand" id="standing" action={<Link href="/leaderboard" className="text-[13px] text-chalk-3 hover:text-chalk">Leaderboard</Link>}>
          <dl className="divide-y divide-line">
            <RankRow label="Global" rank={global} hint={user.showOnGlobalLeaderboard ? undefined : "Hidden by your privacy settings"} />
            <RankRow label="Friends" rank={friends} hint={friends && friends.total <= 1 ? "Add friends to compare" : undefined} />
            {leagueRanks.map((l) => (
              <RankRow key={l.id} label={l.name} href={`/leagues/${l.id}`} rank={l.rank} />
            ))}
          </dl>
          {leagues.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-line-strong p-3 text-[13px] text-chalk-3">
              Private leagues are where it gets personal. <Link href="/social" className="text-lime hover:underline">Create one</Link> and send the invite link to your friends.
            </div>
          ) : null}
        </Panel>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <MoversPanel title="Biggest risers" icon={<ArrowUpRight className="size-4 text-gain" aria-hidden />} rows={movers.risers} empty="No player has risen since their last match yet." />
        <MoversPanel title="Biggest fallers" icon={<ArrowDownRight className="size-4 text-loss" aria-hidden />} rows={movers.fallers} empty="No player has fallen since their last match yet." />

        <Panel title="Matches" id="matches" action={<Link href="/fixtures" className="text-[13px] text-chalk-3 hover:text-chalk">All fixtures</Link>}>
          {live.length + upcoming.length === 0 ? (
            <EmptyState title="No upcoming fixtures loaded" body="Fixtures appear here once the data provider publishes them." />
          ) : (
            <ul className="divide-y divide-line">
              {[...live, ...upcoming].slice(0, 7).map((f) => {
                const awaiting = f.status === "scheduled" && f.kickoffAt && new Date(f.kickoffAt).getTime() < nowMs();
                return (
                  <li key={f.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="w-28 shrink-0 text-[12.5px] text-chalk-3">
                      {f.status === "live" ? (
                        <span className="inline-flex items-center gap-1.5 text-gain">
                          <Radio className="size-3.5" aria-hidden /> Live {f.minute ? `${f.minute}′` : ""}
                        </span>
                      ) : awaiting ? (
                        <span className="text-amber">Awaiting data</span>
                      ) : (
                        kickoff(f.kickoffAt).replace(" UTC", "")
                      )}
                    </span>
                    <span className="flex-1 truncate text-chalk">
                      {f.homeName} <span className="num px-1 text-chalk-3">{f.homeScore !== null ? `${f.homeScore}–${f.awayScore}` : "v"}</span> {f.awayName}
                    </span>
                    <Badge>{f.competition}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Watchlist" id="watchlist" action={<Link href="/market?watchlist=1" className="text-[13px] text-chalk-3 hover:text-chalk">Open in market</Link>}>
          {watch.rows.length === 0 ? (
            <EmptyState icon={<Eye className="size-6" />} title="Nothing on your watchlist" body="Star players in the market to track their price here." action={<ButtonLink href="/market" size="sm">Browse the market</ButtonLink>} />
          ) : (
            <ul className="divide-y divide-line">
              {watch.rows.map((p) => (
                <li key={p.id}>
                  <Link href={`/players/${p.slug}`} className="flex items-center gap-3 py-2 hover:bg-pitch-800/50">
                    <PlayerMark name={p.name} position={p.position} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-chalk">{p.name}</span>
                      <span className="text-xs text-chalk-3">{p.club}</span>
                    </span>
                    <Sparkline values={p.spark} width={64} height={22} />
                    <span className="w-24 text-right">
                      <span className="num block text-sm text-chalk">{formatCredits(p.priceCents)}</span>
                      <Change from={p.previousPriceCents} to={p.priceCents} className="text-xs" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Recent trades" id="trades" className="mt-4" action={<Link href="/portfolio#history" className="text-[13px] text-chalk-3 hover:text-chalk">Full history</Link>}>
        {trades.length === 0 ? (
          <EmptyState title="You haven't traded yet" body="Pick a player whose form you believe in and buy your first shares." action={<ButtonLink href="/market" variant="primary" size="sm">Find a player</ButtonLink>} />
        ) : (
          <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-[12.5px] text-chalk-3">
                  <th className="px-4 py-2 font-medium sm:px-5">Order</th>
                  <th className="px-3 py-2 font-medium">Player</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 text-right font-medium sm:px-5">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-2.5 sm:px-5">
                      <Badge tone={t.side === "buy" ? "sky" : "amber"}>
                        {t.side === "buy" ? "Bought" : "Sold"} {t.quantity}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link href={`/players/${t.playerSlug}`} className="text-chalk hover:underline">
                        {t.playerName}
                      </Link>{" "}
                      <PositionBadge position={t.position} className="ml-1" />
                    </td>
                    <td className="num px-3 py-2.5 text-right text-chalk-2">{formatCredits(t.priceCents)}</td>
                    <td className={cn("num px-3 py-2.5 text-right", t.cashDeltaCents < 0 ? "text-chalk" : "text-chalk")}>{formatCredits(t.cashDeltaCents, { sign: true })}</td>
                    <td className="px-4 py-2.5 text-right text-chalk-3 sm:px-5">{timeAgo(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function RankRow({ label, rank, href, hint }: { label: string; rank: { rank: number; total: number } | null; href?: string; hint?: string }) {
  const body = (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="truncate text-sm text-chalk-2">{label}</dt>
      <dd className="text-right">
        {rank ? (
          <span className="text-sm">
            <span className="scoreboard text-2xl text-chalk">#{rank.rank}</span>
            <span className="ml-1.5 text-chalk-3">of {rank.total}</span>
          </span>
        ) : (
          <span className="text-[12.5px] text-chalk-3">{hint ?? "—"}</span>
        )}
        {rank && hint ? <span className="block text-[11.5px] text-chalk-4">{hint}</span> : null}
      </dd>
    </div>
  );
  return href ? (
    <Link href={href} className="block hover:bg-pitch-800/50">
      {body}
    </Link>
  ) : (
    body
  );
}

function MoversPanel({ title, icon, rows, empty }: { title: string; icon: React.ReactNode; rows: Awaited<ReturnType<typeof topMovers>>["risers"]; empty: string }) {
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          {icon}
          {title}
        </span>
      }
      action={<span className="text-[12px] text-chalk-4">since each player’s last match</span>}
    >
      {rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ol className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/players/${r.slug}`} className="flex items-center gap-3 py-2 hover:bg-pitch-800/50">
                <PlayerMark name={r.name} position={r.position} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-chalk">{r.name}</span>
                  <span className="flex items-center gap-1.5 text-xs text-chalk-3">
                    <PositionBadge position={r.position} />
                    {r.club}
                  </span>
                </span>
                <span className="text-right">
                  <span className="num block text-sm text-chalk">{formatCredits(r.priceCents)}</span>
                  <Change from={r.previousPriceCents} to={r.priceCents} className="text-xs" />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
