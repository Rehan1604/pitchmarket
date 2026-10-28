import { ArrowLeft, Radio } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataNotice } from "@/components/market/data-notice";
import { Availability, Change, Credits, PositionBadge } from "@/components/market/atoms";
import { PriceChart, type ChartPoint } from "@/components/market/price-chart";
import { TradeTicket } from "@/components/market/trade-ticket";
import { WatchButton } from "@/components/market/watch-button";
import { Badge, EmptyState, Panel } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { nowMs } from "@/lib/clock";
import { age, dateTime, kickoff, POSITION_LABEL, shortDate, timeAgo } from "@/lib/format";
import { changeBps, divRoundHalfUp, formatCredits, formatPct } from "@/lib/money";
import { rating } from "@/lib/rating";
import { requirePageUser } from "@/server/auth/current-user";
import { HttpError } from "@/server/http";
import { getPlayerDetail } from "@/server/market/queries";
import { quote } from "@/server/trading/service";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug.split("-").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ") };
}

export default async function PlayerPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requirePageUser();
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) notFound();
  let d: Awaited<ReturnType<typeof getPlayerDetail>>;
  try {
    d = await getPlayerDetail(slug, user.id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const q = await quote(user.id, d.player.id);
  const { player, price } = d;
  const fixtureById = new Map(d.matches.map((m) => [m.fixtureId, m]));
  const points: ChartPoint[] = d.history.map((h) => {
    if (h.reason === "ipo") return { t: new Date(h.effectiveAt).getTime(), price: h.priceCents, label: "Listed on the market (season open)", kind: "ipo" };
    const m = h.fixtureId ? fixtureById.get(h.fixtureId) : undefined;
    const line = m ? `${m.home ? "v" : "at"} ${m.opponent} ${m.score ?? ""}, ${m.minutes}′${m.goals ? `, ${m.goals}G` : ""}${m.assists ? `, ${m.assists}A` : ""}` : "Match settled";
    return { t: new Date(h.effectiveAt).getTime(), price: h.priceCents, label: line, kind: "match" };
  });
  for (const t of d.liveTicks) points.push({ t: new Date(t.effectiveAt).getTime(), price: t.priceCents, label: "Provisional in-play price", kind: "live" });
  if (points.length) points.push({ t: nowMs(), price: price.priceCents, label: "Now", kind: "now" });

  const v = d.viewer!;
  const avgCost = v.quantity > 0 ? divRoundHalfUp(v.costBasisCents, v.quantity) : 0;
  const positionValue = v.quantity * price.priceCents;
  const nextUp = d.nextFixtures[0];
  const yrs = age(player.birthDate);
  const formRating = rating(price.formIndex);
  const seasonRating = rating(price.qualityIndex);

  return (
    <>
      <Link href="/market" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-chalk-3 hover:text-chalk">
        <ArrowLeft className="size-3.5" aria-hidden /> Market
      </Link>
      <DataNotice />

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          <section className="panel pitch-lines overflow-hidden p-5 sm:p-7" aria-labelledby="player-name">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-chalk-3">
                  <PositionBadge position={player.position} />
                  <span>{POSITION_LABEL[player.position]}</span>
                  {player.club ? <span>{player.club.name}</span> : null}
                  {player.squadNumber ? <span className="num">No. {player.squadNumber}</span> : null}
                  {yrs ? <span>Age {yrs}</span> : null}
                  {player.nationality ? <span>{player.nationality}</span> : null}
                </p>
                <h1 id="player-name" className="scoreboard mt-3 text-5xl text-chalk sm:text-6xl">
                  {player.firstName} {player.lastName}
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Availability status={player.availability} chance={player.chanceOfPlaying} />
                  {player.availabilityNote ? <span className="text-[13px] text-chalk-3">{player.availabilityNote}</span> : null}
                  {!player.isTradable ? <Badge tone="amber">No longer listed, sell only</Badge> : null}
                  {q.inPlay ? (
                    <Badge tone="gain">
                      <Radio className="size-3" aria-hidden /> Match live
                    </Badge>
                  ) : null}
                </div>
              </div>
              <WatchButton playerId={player.id} name={player.name} watched={v.watched} withLabel />
            </div>

            <div className="mt-7 flex flex-wrap items-end gap-x-6 gap-y-2">
              <p className="scoreboard text-[72px] text-chalk sm:text-[96px]">
                {formatCredits(price.priceCents)}
                <span className="ml-2 align-top font-sans text-base font-medium text-chalk-3">PC</span>
              </p>
              <div className="pb-3">
                <Change from={price.previousPriceCents} to={price.priceCents} size="lg" />
                <p className="text-[12.5px] text-chalk-3">{price.liveFixtureId ? "provisional, while the match is live" : "since the last match"}</p>
              </div>
              <div className="pb-3">
                <Change from={price.ipoPriceCents} to={price.priceCents} size="lg" />
                <p className="text-[12.5px] text-chalk-3">since listing at {formatCredits(price.ipoPriceCents, { decimals: 0 })}</p>
              </div>
            </div>
          </section>

          <Panel title="Price history" id="history">
            <PriceChart points={points} ipoCents={price.ipoPriceCents} />
            <p className="mt-3 text-[12.5px] text-chalk-4">
              Prices change only at full time (and provisionally during live matches). Hover the line to see the match behind each move; every point is listed in the match table below.
            </p>
          </Panel>

          <Panel title="Season so far" id="season">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-6">
              <Stat label="Appearances" value={d.season.apps} />
              <Stat label="Minutes" value={d.season.minutes.toLocaleString("en-GB")} />
              <Stat label="Goals" value={d.season.goals} />
              <Stat label="Assists" value={d.season.assists} />
              <Stat label="xG" value={d.season.xg === null ? "n/a" : d.season.xg.toFixed(2)} />
              <Stat label="xA" value={d.season.xa === null ? "n/a" : d.season.xa.toFixed(2)} />
              {player.position === "GK" || player.position === "DEF" ? <Stat label="Clean sheets" value={d.season.cleanSheets} /> : null}
              {player.position === "GK" ? <Stat label="Saves" value={d.season.saves ?? "n/a"} /> : null}
              {player.position !== "GK" ? <Stat label="Tackles" value={d.season.tackles ?? "n/a"} /> : null}
              <Stat label="Recoveries" value={d.season.recoveries ?? "n/a"} />
              <Stat label="Cards" value={`${d.season.yellow}Y ${d.season.red}R`} />
            </dl>
            <p className="mt-4 text-[12.5px] text-chalk-4">
              Source: {d.matches[0]?.source === "fpl-api" ? "Fantasy Premier League API" : "FPL public archive"}. “n/a” means the source doesn’t publish that stat; it’s left out of scoring, never counted as zero. Shots, key passes and dribbles aren’t published by FPL.
            </p>
          </Panel>

          <Panel title="Match by match" id="matches">
            {d.matches.length === 0 ? (
              <EmptyState title="No matches recorded yet" body="Match stats appear here after this player’s team plays." />
            ) : (
              <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">Match-by-match performance and price changes</caption>
                  <thead>
                    <tr className="hairline-b text-left text-[12.5px] text-chalk-3">
                      <th scope="col" className="px-4 py-2 font-medium sm:px-5">Match</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Min</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">G</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">A</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">xG</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">{player.position === "GK" ? "Saves" : "Tkl"}</th>
                      <th scope="col" className="px-3 py-2 font-medium">Performance vs position</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">Price after</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.matches.map((m) => (
                      <tr key={m.fixtureId}>
                        <td className="px-4 py-2.5 sm:px-5">
                          <span className="text-chalk">
                            {m.home ? "v" : "at"} {m.opponent}
                          </span>{" "}
                          <span className="num text-chalk-3">{m.score}</span>
                          <span className="block text-xs text-chalk-4">
                            {m.round ? `GW${m.round}, ` : ""}
                            {shortDate(m.kickoffAt)}
                            {m.status === "live" ? ", live" : !m.settled ? ", not settled yet" : ""}
                          </span>
                        </td>
                        <td className="num px-2 py-2.5 text-right text-chalk-2">{m.minutes}</td>
                        <td className="num px-2 py-2.5 text-right text-chalk-2">{m.goals ?? "n/a"}</td>
                        <td className="num px-2 py-2.5 text-right text-chalk-2">{m.assists ?? "n/a"}</td>
                        <td className="num px-2 py-2.5 text-right text-chalk-2">{m.xg === null ? "n/a" : m.xg.toFixed(2)}</td>
                        <td className="num px-2 py-2.5 text-right text-chalk-2">{player.position === "GK" ? (m.saves ?? "n/a") : (m.tackles ?? "n/a")}</td>
                        <td className="px-3 py-2.5">{m.minutes > 0 && m.z !== null ? <PerfBar z={m.z} score={m.performanceScore} expected={m.expectedScore} /> : <span className="text-[12.5px] text-chalk-4">Didn’t play: price unchanged</span>}</td>
                        <td className="px-4 py-2.5 text-right sm:px-5">
                          {m.priceAfterCents !== null && m.priceBeforeCents !== null ? (
                            <>
                              <span className="num block text-chalk">{formatCredits(m.priceAfterCents)}</span>
                              <Change from={m.priceBeforeCents} to={m.priceAfterCents} className="text-xs" />
                            </>
                          ) : (
                            <span className="text-[12.5px] text-chalk-4">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <aside className="min-w-0 space-y-4">
          <Panel title="Trade" id="trade">
            <TradeTicket
              playerId={player.id}
              playerName={player.name}
              priceCents={price.priceCents}
              cashCents={q.cashCents ?? 0}
              heldQuantity={q.heldQuantity}
              avgCostCents={avgCost}
              feeBps={q.feeBps}
              maxQuantity={q.maxQuantity}
              buyBlocked={q.buyBlocked}
              sellBlocked={q.sellBlocked}
              blockMessage={q.blockMessage}
            />
          </Panel>

          <Panel title="Your position" id="position">
            {v.quantity > 0 ? (
              <dl className="space-y-2 text-sm">
                <Line label="Shares" value={v.quantity.toLocaleString("en-GB")} />
                <Line label="Average cost" value={<Credits cents={avgCost} />} />
                <Line label="Value now" value={<Credits cents={positionValue} />} />
                <Line
                  label="Unrealized"
                  value={
                    <span className={cn("num", positionValue - v.costBasisCents >= 0 ? "text-gain" : "text-loss")}>
                      {formatCredits(positionValue - v.costBasisCents, { sign: true })} ({formatPct(changeBps(v.costBasisCents, positionValue))})
                    </span>
                  }
                />
                {v.realizedCents ? <Line label="Realized so far" value={<span className="num">{formatCredits(v.realizedCents, { sign: true })}</span>} /> : null}
              </dl>
            ) : (
              <p className="text-sm text-chalk-3">You don’t hold {player.name} yet.{v.realizedCents ? ` Realized from past trades: ${formatCredits(v.realizedCents, { sign: true })} PC.` : ""}</p>
            )}
          </Panel>

          <Panel title="How this price is set" id="model">
            <dl className="space-y-2.5 text-sm">
              <Line label="Season rating" value={<span className="num">{seasonRating}</span>} hint="Quality this season, blended with last season and shrunk toward average when the sample is small." />
              <Line label="Form rating" value={<span className="num">{price.matchesPriced ? formRating : "—"}</span>} hint="Recent matches, older ones fading with a 4-match half-life." />
              <Line label="Minutes share" value={<span className="num">{Math.round(price.role * 100)}%</span>} hint="How much of the team’s football this player plays." />
              <Line label="Engine value" value={<Credits cents={price.fundamentalCents} decimals={0} />} hint="What the numbers above support. Each match the price closes 12% of the gap, never moving more than 8% in one go." />
              <Line label="Matches priced" value={<span className="num">{price.matchesPriced}</span>} />
            </dl>
            <p className="mt-3 text-[12px] text-chalk-4">Game prices for a virtual market, not real-world transfer values. Last update {timeAgo(price.updatedAt)}.</p>
          </Panel>

          <Panel title="Market" id="holders">
            <dl className="space-y-2 text-sm">
              <Line label="Managers holding" value={d.holders.managers.toLocaleString("en-GB")} />
              <Line label="Shares held" value={d.holders.shares.toLocaleString("en-GB")} />
              <Line label="Held value" value={<Credits cents={d.holders.heldValueCents} decimals={0} />} hint="Shares held by all managers × current price: this player’s market size here." />
            </dl>
          </Panel>

          <Panel title="Next up" id="next">
            {nextUp ? (
              <ul className="space-y-2 text-sm">
                {d.nextFixtures.map((f) => (
                  <li key={f.id} className="flex justify-between gap-3">
                    <span className="text-chalk">
                      {f.homeClubId === player.club?.id ? `v ${f.awayName}` : `at ${f.homeName}`}
                    </span>
                    <span className="text-chalk-3">{f.status === "live" ? "Live now" : kickoff(f.kickoffAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-chalk-3">No upcoming fixtures published.</p>
            )}
            {player.sourceUpdatedAt ? <p className="mt-3 text-[12px] text-chalk-4">Player data as of {dateTime(player.sourceUpdatedAt)}.</p> : null}
          </Panel>
        </aside>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12.5px] text-chalk-3">{label}</dt>
      <dd className="num mt-0.5 text-lg font-semibold text-chalk">{value}</dd>
    </div>
  );
}

function Line({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-chalk-3">{label}</dt>
        <dd className="text-right text-chalk">{value}</dd>
      </div>
      {hint ? <p className="mt-0.5 text-[12px] leading-snug text-chalk-4">{hint}</p> : null}
    </div>
  );
}

/** Diverging bar: performance vs what's expected for the position (z-score), centred on zero. */
function PerfBar({ z, score, expected }: { z: number; score: number | null; expected: number | null }) {
  const width = Math.min(1, Math.abs(z) / 3) * 50;
  const up = z >= 0;
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-2 w-28 rounded-full bg-pitch-700" aria-hidden>
        <span className="absolute top-[-3px] bottom-[-3px] left-1/2 w-px bg-chalk-4" />
        <span className={cn("absolute top-0 bottom-0 rounded-full", up ? "left-1/2 bg-gain" : "right-1/2 bg-loss")} style={{ width: `${width}%` }} />
      </div>
      <span className="num text-[12.5px] text-chalk-2">
        {score !== null ? score.toFixed(1) : "?"}
        <span className="text-chalk-4"> vs {expected !== null ? expected.toFixed(1) : "?"}</span>
      </span>
    </div>
  );
}
