import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { LeagueSelect } from "@/components/social/league-select";
import { Standings } from "@/components/social/standings";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { cn } from "@/lib/cn";
import { dateTime } from "@/lib/format";
import { requirePageUser } from "@/server/auth/current-user";
import { HttpError } from "@/server/http";
import { getLeaderboard, rankOf, type Scope } from "@/server/leaderboard/service";
import { dataStatus } from "@/server/market/queries";
import { getLeagueForViewer, listMyLeagues } from "@/server/social/leagues";

export const metadata: Metadata = { title: "Leaderboard" };

const qs = z.object({
  scope: z.enum(["global", "friends", "league"]).catch("global"),
  period: z.enum(["season", "week", "day"]).catch("season"),
  leagueId: z.uuid().optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePageUser();
  const q = qs.parse(await searchParams);
  const leagues = await listMyLeagues(user.id);
  let leagueId = q.leagueId ?? (q.scope === "league" ? leagues[0]?.id : undefined);
  let leagueName: string | null = null;
  if (q.scope === "league" && leagueId) {
    try {
      leagueName = (await getLeagueForViewer(leagueId, user.id)).league.name;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      leagueId = undefined;
    }
  }
  const scope: Scope | null =
    q.scope === "friends" ? { kind: "friends", userId: user.id } : q.scope === "league" ? (leagueId ? { kind: "league", leagueId } : null) : { kind: "global" };
  const pageSize = 50;
  const [board, status, mine] = await Promise.all([
    scope ? getLeaderboard(scope, { period: q.period, limit: pageSize, offset: (q.page - 1) * pageSize }) : Promise.resolve(null),
    dataStatus(),
    scope ? rankOf(scope, user.id) : Promise.resolve(null),
  ]);
  const href = (patch: Partial<{ scope: string; period: string; leagueId: string | undefined; page: number }>) => {
    const p = new URLSearchParams();
    const next = { scope: q.scope, period: q.period, leagueId, page: 1, ...patch };
    p.set("scope", next.scope);
    p.set("period", next.period);
    if (next.scope === "league" && next.leagueId) p.set("leagueId", next.leagueId);
    if (next.page > 1) p.set("page", String(next.page));
    return `/leaderboard?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Leaderboard"
        description="Ranked by portfolio value: cash plus shares at current prices. Everyone starts with the same balance and there are no deposits, so value and return rank identically. Ties share a rank."
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Leaderboard scope" className="flex rounded-md border border-line-strong p-0.5">
          {(["global", "friends", "league"] as const).map((s) => (
            <Link key={s} href={href({ scope: s, page: 1 })} aria-current={q.scope === s ? "page" : undefined} className={cn("h-8 rounded px-3.5 text-[13px] leading-8 font-medium capitalize", q.scope === s ? "bg-pitch-700 text-chalk" : "text-chalk-3 hover:text-chalk")}>
              {s === "league" ? "Leagues" : s}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          {q.scope === "league" && leagues.length > 0 ? <LeagueSelect leagues={leagues.map((l) => ({ id: l.id, name: l.name }))} value={leagueId ?? null} period={q.period} /> : null}
          <nav aria-label="Period" className="flex rounded-md border border-line-strong p-0.5">
            {(["season", "week", "day"] as const).map((p) => (
              <Link key={p} href={href({ period: p, page: 1 })} aria-current={q.period === p ? "page" : undefined} className={cn("h-8 rounded px-3 text-[13px] leading-8 font-medium capitalize", q.period === p ? "bg-pitch-700 text-chalk" : "text-chalk-3 hover:text-chalk")}>
                {p === "season" ? "Season" : p === "week" ? "Week" : "Today"}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <Panel
        title={q.scope === "global" ? "Global" : q.scope === "friends" ? "You and your friends" : (leagueName ?? "Leagues")}
        action={mine ? <span className="text-[13px] text-chalk-3">You’re #{mine.rank} of {mine.total}</span> : null}
      >
        {q.scope === "league" && !scope ? (
          <div className="py-8 text-center">
            <p className="font-medium text-chalk">You’re not in a league yet</p>
            <p className="mt-1 text-sm text-chalk-3">Create one and invite your friends, or join with an invite code.</p>
            <ButtonLink href="/social" variant="primary" size="sm" className="mt-4">
              Create or join a league
            </ButtonLink>
          </div>
        ) : board ? (
          <>
            <Standings
              rows={board.rows}
              viewerId={user.id}
              period={q.period}
              emptyTitle={q.scope === "global" ? "No managers on the global board yet" : "No one to compare with yet"}
              emptyBody={q.scope === "friends" ? <Link href="/social" className="text-lime hover:underline">Add friends</Link> : undefined}
            />
            {q.scope === "global" && !user.showOnGlobalLeaderboard ? <p className="mt-3 text-[12.5px] text-chalk-4">You’ve hidden yourself from the global board in Settings. You still appear to friends and in your leagues.</p> : null}
            <Pagination page={q.page} pageSize={pageSize} total={board.total} hrefFor={(p) => href({ page: p })} />
          </>
        ) : null}
        <p className="mt-4 text-[12.5px] text-chalk-4">
          Computed {dateTime(board?.computedAt ?? new Date())} from persisted portfolios and server prices. Last price update {dateTime(status.lastPriceUpdateAt)}. Week and today compare with start-of-day (UTC) snapshots; rank arrows show movement since the start of today.
        </p>
      </Panel>
    </>
  );
}
