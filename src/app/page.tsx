import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { db, schema } from "@/db";
import { Change, PositionBadge } from "@/components/market/atoms";
import { ButtonLink } from "@/components/ui/button";
import { Wordmark } from "@/components/shell/wordmark";
import { dateTime } from "@/lib/format";
import { formatCredits, formatPct, changeBps } from "@/lib/money";
import { getCurrentUser } from "@/server/auth/current-user";
import { env } from "@/server/env";
import { dataStatus, topMovers } from "@/server/market/queries";

async function board() {
  return db
    .select({
      slug: schema.players.slug,
      name: schema.players.displayName,
      position: schema.players.position,
      club: schema.clubs.shortName,
      priceCents: schema.playerPrices.priceCents,
      previousPriceCents: schema.playerPrices.previousPriceCents,
    })
    .from(schema.playerPrices)
    .innerJoin(schema.players, eq(schema.players.id, schema.playerPrices.playerId))
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.players.clubId))
    .where(eq(schema.players.isTradable, true))
    .orderBy(desc(schema.playerPrices.priceCents))
    .limit(8);
}

async function example() {
  const res = await db.execute<{ name: string; slug: string; price: string; prev: string; home: string; away: string; hs: number; as: number; goals: number | null; assists: number | null; cs: boolean | null; minutes: number; position: string }>(sql`
    SELECT p.display_name AS name, p.slug, t.price_cents AS price, t.previous_price_cents AS prev, f.home_name AS home, f.away_name AS away,
           f.home_score AS hs, f.away_score AS as, s.goals, s.assists, s.clean_sheet AS cs, s.minutes, p.position
    FROM price_ticks t
    JOIN players p ON p.id = t.player_id
    JOIN fixtures f ON f.id = t.fixture_id
    JOIN player_match_stats s ON s.player_id = t.player_id AND s.fixture_id = t.fixture_id
    WHERE t.reason = 'match_final'
    ORDER BY t.effective_at DESC, (t.price_cents - t.previous_price_cents)::float / t.previous_price_cents DESC
    LIMIT 1`);
  return res.rows[0] ?? null;
}

export default async function Landing() {
  const [user, rows, status, movers, ex] = await Promise.all([getCurrentUser(), board(), dataStatus(), topMovers(3), example()]);
  const e = env();
  const credits = e.STARTING_BALANCE_CREDITS.toLocaleString("en-GB");
  const live = status.dataMode === "live";

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-16 max-w-[1240px] items-center gap-4 px-5 sm:px-8">
        <Wordmark name={e.APP_NAME} />
        <nav className="ml-auto flex items-center gap-2" aria-label="Account">
          {user ? (
            <ButtonLink href="/dashboard" variant="primary" size="sm">
              Open dashboard
            </ButtonLink>
          ) : (
            <>
              <ButtonLink href="/login" variant="ghost" size="sm">
                Sign in
              </ButtonLink>
              <ButtonLink href="/signup" variant="primary" size="sm">
                Create account
              </ButtonLink>
            </>
          )}
        </nav>
      </header>

      <main id="main">
        <section className="pitch-lines mx-auto grid max-w-[1240px] gap-10 px-5 pt-10 pb-16 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
          <div>
            <h1 className="scoreboard text-[76px] leading-[0.86] text-chalk sm:text-[104px] lg:text-[92px] xl:text-[104px]">
              Buy the form.
              <br />
              Sell the slump.
            </h1>
            <p className="mt-7 max-w-xl text-[17px] leading-relaxed text-chalk-2">
              A stock market where the stocks are Premier League footballers. Prices move after every match from what players actually did. Start with {credits} virtual Pitch Credits, build a squad of shares, and beat your friends in private leagues.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href={user ? "/market" : "/signup"} variant="primary" size="lg">
                {user ? "Go to the market" : "Start with " + credits + " credits"}
              </ButtonLink>
              <ButtonLink href="#how" variant="secondary" size="lg">
                How prices move
              </ButtonLink>
            </div>
            <p className="mt-6 max-w-lg text-[13px] text-chalk-3">
              Virtual money only. There are no deposits, withdrawals, prizes or bets, and prices are game prices, not real transfer values.
            </p>
          </div>

          <div className="panel overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <p className="text-sm font-medium text-chalk">The board</p>
              <p className={live ? "text-[12.5px] text-gain" : "text-[12.5px] text-amber"}>
                {live ? "Live from the FPL feed" : status.dataAsOf ? `Snapshot, matches to ${dateTime(status.dataAsOf).replace(/, \d\d:\d\d UTC/, "")}` : "No data yet"}
              </p>
            </div>
            {rows.length === 0 ? (
              <p className="p-6 text-sm text-chalk-3">The market hasn’t been seeded yet.</p>
            ) : (
              <ol className="grid grid-cols-2 gap-px bg-line">
                {rows.map((r) => (
                  <li key={r.slug} className="bg-pitch-850 px-4 py-4 sm:px-5">
                    <p className="flex items-center gap-2 text-[12px] text-chalk-3">
                      <PositionBadge position={r.position} />
                      {r.club}
                    </p>
                    <p className="mt-1.5 truncate text-[15px] font-medium text-chalk">{r.name}</p>
                    <p className="scoreboard mt-2 text-[40px] text-chalk">{formatCredits(r.priceCents, { decimals: 0 })}</p>
                    <Change from={r.previousPriceCents} to={r.priceCents} className="mt-1" />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        <section id="how" className="border-y border-line bg-pitch-950/40">
          <div className="mx-auto max-w-[1240px] px-5 py-16 sm:px-8">
            <h2 className="scoreboard text-5xl text-chalk sm:text-6xl">How a price moves</h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3">
              {[
                ["The match is played", "Minutes, goals, assists, expected goals and assists, saves, clean sheets, tackles and recoveries come in from the data feed."],
                ["Performance is judged by position", "A defender’s clean sheet counts like a striker’s goal. Each stat is compared with what’s normal for that position over the minutes played. Stats the feed doesn’t publish are left out, never counted as zero."],
                ["The price steps, within limits", "Strong games lift the price, poor ones lower it, and long-term quality pulls it back toward fair value. One match moves a price by at most 8%. Sitting out never costs a player anything."],
              ].map(([title, body], i) => (
                <li key={title}>
                  <span className="scoreboard text-5xl text-lime">{i + 1}</span>
                  <p className="mt-3 text-lg font-medium text-chalk">{title}</p>
                  <p className="mt-2 text-[15px] leading-relaxed text-chalk-3">{body}</p>
                </li>
              ))}
            </ol>
            {ex ? (
              <div className="panel mt-12 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
                <p className="text-sm text-chalk-3 sm:w-40">Latest real example</p>
                <p className="flex-1 text-[15px] text-chalk-2">
                  <Link href={user ? `/players/${ex.slug}` : "/signup"} className="font-medium text-chalk hover:underline">
                    {ex.name}
                  </Link>{" "}
                  played {ex.minutes} minutes in {ex.home} {ex.hs}–{ex.as} {ex.away}
                  {ex.goals ? `, scored ${ex.goals}` : ""}
                  {ex.assists ? `, assisted ${ex.assists}` : ""}
                  {ex.cs && ex.minutes >= 60 && (ex.position === "DEF" || ex.position === "GK") ? ", kept a clean sheet" : ""}.
                </p>
                <p className="scoreboard text-4xl text-chalk">
                  {formatCredits(Number(ex.prev), { decimals: 0 })} <span className="text-chalk-4">→</span> {formatCredits(Number(ex.price), { decimals: 0 })}
                </p>
                <p className={Number(ex.price) >= Number(ex.prev) ? "num text-lg text-gain" : "num text-lg text-loss"}>
                  {Number(ex.price) >= Number(ex.prev) ? "▲" : "▼"} {formatPct(changeBps(Number(ex.prev), Number(ex.price)))}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mx-auto grid max-w-[1240px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-2">
          <div>
            <h2 className="scoreboard text-5xl text-chalk sm:text-6xl">Your friends are the market</h2>
            <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-chalk-2">
              Create a private league, share the invite link in the group chat, and watch the standings move every matchday. Friends see your rank; you decide who sees your holdings.
            </p>
            <ul className="mt-6 space-y-2 text-[15px] text-chalk-2">
              <li>Global, friends and league leaderboards, by season, week or day</li>
              <li>Invite links you can cap, expire or revoke</li>
              <li>An activity feed of your friends’ trades, if they choose to share them</li>
            </ul>
          </div>
          <div className="panel p-5">
            <p className="text-sm font-medium text-chalk">Moving right now</p>
            <ul className="mt-3 divide-y divide-line">
              {[...movers.risers, ...movers.fallers].slice(0, 5).map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="truncate text-sm text-chalk">
                    {m.name} <span className="text-chalk-3">{m.club}</span>
                  </span>
                  <Change from={m.previousPriceCents} to={m.priceCents} />
                </li>
              ))}
              {movers.risers.length + movers.fallers.length === 0 ? <li className="py-3 text-sm text-chalk-3">No price moves yet.</li> : null}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-3 px-5 py-8 text-[12.5px] text-chalk-4 sm:px-8 md:flex-row md:justify-between">
          <p>{e.APP_NAME} is a free game played with virtual credits. It is not gambling, investment or financial advice.</p>
          <p>
            Player data: Fantasy Premier League{status.dataProvider === "fpl-archive" ? " via the public FPL archive on GitHub" : ""}. Not affiliated with or endorsed by the Premier League.
          </p>
        </div>
      </footer>
    </div>
  );
}
