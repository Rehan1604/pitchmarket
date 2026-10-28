import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { Radio } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { db, schema } from "@/db";
import { Change } from "@/components/market/atoms";
import { DataNotice } from "@/components/market/data-notice";
import { Badge, EmptyState, PageHeader, Panel } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { dateTime, kickoff, timeAgo } from "@/lib/format";
import { formatCredits } from "@/lib/money";
import { requirePageUser } from "@/server/auth/current-user";
import { fixtureMovers, listFixtures } from "@/server/market/queries";

export const metadata: Metadata = { title: "Fixtures" };

type Fx = Awaited<ReturnType<typeof listFixtures>>[number];

export default async function FixturesPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  await requirePageUser();
  const order = ["PL", "PD", "BL1", "SA", "FL1", "CL"];
  const rank = (code: string) => order.indexOf(code) + 1 || 99;
  const competitions = (await db.select().from(schema.competitions).orderBy(desc(schema.competitions.hasPlayerStats), asc(schema.competitions.name))).sort(
    (a, b) => Number(b.hasPlayerStats) - Number(a.hasPlayerStats) || rank(a.code) - rank(b.code),
  );
  const { c } = await searchParams;
  const comp = competitions.find((x) => x.code === c) ?? competitions[0];
  if (!comp) {
    return (
      <>
        <PageHeader title="Fixtures" />
        <Panel>
          <EmptyState title="No fixtures loaded yet" body="Fixtures appear after the first data sync." />
        </Panel>
      </>
    );
  }
  const now = new Date();
  const [live, upcoming, results, awaiting, provider] = await Promise.all([
    listFixtures({ competition: comp.code, status: "live", limit: 20 }),
    listFixtures({ competition: comp.code, status: "upcoming", limit: 20 }),
    listFixtures({ competition: comp.code, status: "results", limit: 20 }),
    db
      .select({ id: schema.fixtures.id, kickoffAt: schema.fixtures.kickoffAt, homeName: schema.fixtures.homeName, awayName: schema.fixtures.awayName, round: schema.fixtures.round })
      .from(schema.fixtures)
      .where(and(eq(schema.fixtures.competitionId, comp.id), eq(schema.fixtures.status, "scheduled"), lt(schema.fixtures.kickoffAt, new Date(now.getTime() - 3 * 3600_000))))
      .orderBy(asc(schema.fixtures.kickoffAt)),
    db
      .select()
      .from(schema.providerStatus)
      .where(or(eq(schema.providerStatus.provider, comp.provider === "fpl" ? "fpl-api" : "football-data.org"), eq(schema.providerStatus.provider, comp.provider === "fpl" ? "fpl-archive" : "football-data.org")))
      .orderBy(sql`${schema.providerStatus.lastSuccessAt} desc nulls last`)
      .limit(1),
  ]);
  const movers = await Promise.all(results.slice(0, 10).map((f) => (f.settledAt ? fixtureMovers(f.id, 6) : Promise.resolve([]))));

  return (
    <>
      <PageHeader title="Fixtures" description="Matches that move the market. Prices settle once the data provider marks a match’s stats as final." />
      <DataNotice context="fixtures" />
      <nav aria-label="Competition" className="mb-4 flex flex-wrap gap-2">
        {competitions.map((x) => (
          <Link key={x.id} href={`/fixtures?c=${x.code}`} aria-current={x.id === comp.id ? "page" : undefined} className={cn("inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px]", x.id === comp.id ? "border-lime/40 text-lime" : "border-line-strong text-chalk-3 hover:text-chalk")}>
            {x.name}
            {!x.hasPlayerStats ? <span className="text-[11px] text-chalk-4">results only</span> : null}
          </Link>
        ))}
      </nav>
      <p className="mb-4 text-[13px] text-chalk-3">
        {comp.hasPlayerStats ? "Players in this competition are tradable." : "This competition shows fixtures and results only: its data source has no player statistics, so its players aren’t on the market."}{" "}
        {provider[0]?.lastSuccessAt ? `Last data refresh ${timeAgo(provider[0].lastSuccessAt)}.` : ""} {comp.hasLiveData ? "Live scores update about every minute during matches." : "No live in-play data from this source."} Times are UTC.{" "}
        <span className="text-chalk-4">
          {comp.provider === "football-data"
            ? "Football data provided by the Football-Data.org API."
            : comp.provider === "espn"
              ? "Match data: ESPN (unofficial public feed). Not affiliated with ESPN, the league or UEFA."
              : "Data: Fantasy Premier League. Not affiliated with the Premier League."}
        </span>
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {live.length ? (
            <Panel title={<span className="inline-flex items-center gap-2"><Radio className="size-4 text-gain" aria-hidden /> Live now</span>}>
              <FixtureList rows={live} />
            </Panel>
          ) : null}
          {awaiting.length ? (
            <Panel title={`Awaiting data (${awaiting.length})`} id="awaiting" action={<Badge tone="amber">Not in the latest snapshot</Badge>}>
              <p className="mb-3 text-[13px] text-chalk-3">These matches have kicked off, but the data source hasn’t published their results yet. Prices for these players haven’t moved for them.</p>
              <ul className="divide-y divide-line">
                {awaiting.map((f) => (
                  <li key={f.id} className="flex justify-between gap-3 py-2 text-sm">
                    <span className="text-chalk-2">
                      {f.homeName} v {f.awayName}
                    </span>
                    <span className="text-chalk-4">
                      {f.round ? `GW${f.round}, ` : ""}
                      {kickoff(f.kickoffAt).replace(" UTC", "")}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          <Panel title="Upcoming" id="upcoming">
            {upcoming.length ? <FixtureList rows={upcoming} /> : <EmptyState title="No upcoming fixtures published" />}
          </Panel>
        </div>
        <Panel title="Results" id="results">
          {results.length === 0 ? (
            <EmptyState title="No results yet" />
          ) : (
            <ul className="divide-y divide-line">
              {results.map((f, i) => (
                <li key={f.id} className="py-3">
                  <div className="flex items-center gap-3 text-sm">
                    <span className="flex-1 text-chalk">
                      {f.homeName} <span className="num px-1 font-semibold">{f.homeScore}–{f.awayScore}</span> {f.awayName}
                    </span>
                    <span className="text-[12px] text-chalk-4">{f.round ? `GW${f.round}, ` : ""}{dateTime(f.kickoffAt).replace(/ \d{4}, /, ", ").replace(" UTC", "")}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-chalk-4">{f.settledAt ? `Prices settled ${timeAgo(f.settledAt)}` : comp.hasPlayerStats ? (f.statsFinal ? "Settling" : "Full time, waiting for final stats") : "Final"}</p>
                  {movers[i]?.length ? (
                    <details className="mt-2 group">
                      <summary className="cursor-pointer text-[13px] text-chalk-3 hover:text-chalk">Biggest price moves</summary>
                      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {movers[i].map((m) => (
                          <li key={m.slug} className="flex items-center justify-between gap-2 rounded border border-line px-2.5 py-1.5 text-[13px]">
                            <Link href={`/players/${m.slug}`} className="truncate text-chalk hover:underline">
                              {m.name} <span className="text-chalk-4">{m.club}</span>
                            </Link>
                            <span className="text-right">
                              <span className="num mr-2 text-chalk-3">{formatCredits(m.priceCents, { decimals: 0 })}</span>
                              <Change from={m.previousPriceCents} to={m.priceCents} className="text-xs" />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function FixtureList({ rows }: { rows: Fx[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((f) => (
        <li key={f.id} className="flex items-center gap-3 py-2.5 text-sm">
          <span className="w-32 shrink-0 text-[12.5px] text-chalk-3">
            {f.status === "live" ? <span className="text-gain">Live {f.minute ? `${f.minute}′` : ""}</span> : f.status === "postponed" ? <span className="text-amber">Postponed</span> : kickoff(f.kickoffAt).replace(" UTC", "")}
          </span>
          <span className="flex-1 text-chalk">
            {f.homeName} <span className="num px-1 text-chalk-3">{f.homeScore !== null ? `${f.homeScore}–${f.awayScore}` : "v"}</span> {f.awayName}
          </span>
          {f.round ? <span className="text-[12px] text-chalk-4">GW{f.round}</span> : null}
        </li>
      ))}
    </ul>
  );
}
