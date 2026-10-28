import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DataNotice } from "@/components/market/data-notice";
import { Availability, Change, PlayerMark, PositionBadge, Sparkline } from "@/components/market/atoms";
import { MarketFilters } from "@/components/market/filters";
import { WatchButton } from "@/components/market/watch-button";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { cn } from "@/lib/cn";
import { formatCredits } from "@/lib/money";
import { rating, ratingTone } from "@/lib/rating";
import { requirePageUser } from "@/server/auth/current-user";
import { listClubs, listMarket, marketFilterSchema } from "@/server/market/queries";

export const metadata: Metadata = { title: "Market" };

export default async function MarketPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser();
  const raw = await searchParams;
  const flat = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = marketFilterSchema.safeParse(flat);
  const filter = parsed.success ? parsed.data : marketFilterSchema.parse({});
  const [market, clubs] = await Promise.all([listMarket(filter, user.id), listClubs()]);
  const hrefFor = (page: number) => {
    const p = new URLSearchParams(flat as Record<string, string>);
    p.set("page", String(page));
    return `/market?${p.toString()}`;
  };
  const offset = (filter.page - 1) * filter.pageSize;

  return (
    <>
      <PageHeader title="Market" description="Every Premier League player with a price. Changes are since each player’s last match; ratings are 50 for an average player in that position." />
      <DataNotice />
      <Suspense>
        <MarketFilters clubs={clubs.map((c) => ({ id: c.id, name: c.name }))} />
      </Suspense>

      {market.rows.length === 0 ? (
        <div className="panel">
          <EmptyState title={filter.watchlist ? "No players on your watchlist match" : "No players match these filters"} body="Try a different search or clear the filters." />
        </div>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="panel relative hidden overflow-x-auto md:block">
            <table className="w-full min-w-[900px] text-sm">
              <caption className="sr-only">Players, sorted by {filter.sort}</caption>
              <thead>
                <tr className="hairline-b text-left text-[12.5px] text-chalk-3">
                  <th scope="col" className="w-12 px-4 py-3 font-medium">#</th>
                  <th scope="col" className="px-3 py-3 font-medium">Player</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Price (PC)</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Last match</th>
                  <th scope="col" className="px-3 py-3 font-medium">Trend</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Form</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Season</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Shares held</th>
                  <th scope="col" className="w-12 px-3 py-3 font-medium"><span className="sr-only">Watch</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {market.rows.map((p, i) => {
                  const form = rating(p.formIndex);
                  const season = rating(p.qualityIndex);
                  return (
                    <tr key={p.id} className="group hover:bg-pitch-800/60">
                      <td className="num px-4 py-2.5 text-chalk-4">{offset + i + 1}</td>
                      <td className="px-3 py-2.5">
                        <Link href={`/players/${p.slug}`} className="flex items-center gap-3">
                          <PlayerMark name={p.name} position={p.position} size={34} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-2 font-medium text-chalk group-hover:underline">
                              {p.name}
                              <Availability status={p.availability} chance={p.chanceOfPlaying} compact />
                              {p.liveFixtureId ? <Lock className="size-3.5 text-amber" aria-label="In play" /> : null}
                              {!p.isTradable ? <span className="text-[11px] text-chalk-4">sell only</span> : null}
                            </span>
                            <span className="flex items-center gap-1.5 text-xs text-chalk-3">
                              <PositionBadge position={p.position} />
                              {p.clubName}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="num px-3 py-2.5 text-right text-[15px] font-medium text-chalk">{formatCredits(p.priceCents)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <Change from={p.previousPriceCents} to={p.priceCents} />
                      </td>
                      <td className="px-3 py-2.5">
                        <Sparkline values={p.spark} />
                      </td>
                      <td className={cn("num px-3 py-2.5 text-right", tone(form))}>{p.matchesPriced ? form : "—"}</td>
                      <td className={cn("num px-3 py-2.5 text-right", tone(season))}>{season}</td>
                      <td className="num px-3 py-2.5 text-right text-chalk-2">{p.sharesHeld.toLocaleString("en-GB")}</td>
                      <td className="px-3 py-2.5 text-right">
                        <WatchButton playerId={p.id} name={p.name} watched={p.watched} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {market.rows.map((p) => (
              <li key={p.id} className="panel flex items-center gap-3 p-3">
                <Link href={`/players/${p.slug}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <PlayerMark name={p.name} position={p.position} size={38} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate font-medium text-chalk">
                      {p.name}
                      <Availability status={p.availability} chance={p.chanceOfPlaying} compact />
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-chalk-3">
                      <PositionBadge position={p.position} /> {p.club}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="num block font-medium text-chalk">{formatCredits(p.priceCents)}</span>
                    <Change from={p.previousPriceCents} to={p.priceCents} className="text-xs" />
                  </span>
                </Link>
                <WatchButton playerId={p.id} name={p.name} watched={p.watched} />
              </li>
            ))}
          </ul>
          <Pagination page={market.page} pageSize={market.pageSize} total={market.total} hrefFor={hrefFor} />
        </>
      )}
    </>
  );
}

function tone(r: number) {
  const t = ratingTone(r);
  return t === "gain" ? "text-gain" : t === "loss" ? "text-loss" : "text-chalk-2";
}
