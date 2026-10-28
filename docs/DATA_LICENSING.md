# Data sources, licensing and attribution

PITCHMARKET only uses data sources it can identify and attribute, and it labels
data provenance and freshness in the interface.

## Providers evaluated (October 2026)

| Provider | Free tier | Player match stats | Current season | Verdict |
|---|---|---|---|---|
| **Fantasy Premier League API** (fantasy.premierleague.com/api) | No key | Yes: minutes, goals, assists, xG, xA, saves, clean sheets, tackles, CBI, recoveries, cards; availability | Yes, live in-play | **Primary for the Premier League.** Unofficial, see risks below. |
| **FPL public archive** (github.com/vaastav/Fantasy-Premier-League) | No key | Same fields, per fixture | Yes, delayed by days | **Fallback / snapshot mode.** Repository is MIT-licensed; the data originates from FPL. |
| football-data.org v4 | Free key, 10 req/min, 12 competitions | **No** (lineups, cards, squads and stats need paid add-ons) | Yes, scores delayed on the free tier | **Optional, results only** for La Liga, Bundesliga, Serie A, Ligue 1, Champions League. |
| **ESPN site feed** (site.api.espn.com) | No key | Yes: minutes (derived), goals, assists, shots, shots on target, saves, goals conceded on the pitch, own goals, cards. No xG, no defensive stats, no injury news | Yes, live in-play | **Opt-in (`ESPN_ENABLED=true`) for La Liga, Bundesliga, Serie A, Ligue 1 and the Champions League.** Against ESPN's terms; see risks below. |
| API-Football (api-sports.io) | 100 req/day | Yes (rich per-fixture stats) | **Not on the free plan** (developers report the free plan rejects season 2026; paid from ~$19/mo) | Not implemented. The legitimate upgrade path for the ESPN leagues (see below). |
| Sportmonks | Free plan: Danish Superliga and Scottish Premiership only | Yes | Yes | Not suitable for the free target leagues. |
| Sorare API | Free key | Yes | Yes | **No.** Its API licence only covers applications that interact with the Sorare platform. |
| Understat | No key | Yes (no Champions League) | Yes, after matches | **No.** robots.txt disallows all automated access. |
| FBref (Sports Reference) | — | Yes | Yes | **No.** Its data-use policy forbids building websites or tools from scraped data. |

The Premier League is always tradable. With `ESPN_ENABLED=true` La Liga, the
Bundesliga, Serie A, Ligue 1 and the Champions League are tradable too;
without it they can appear on the Fixtures screen as results-only when a
football-data.org key is configured.

## Risks you should know about

* **The FPL API is unofficial and undocumented.** The Premier League doesn't
  publish terms for third-party use of these endpoints, and the endpoints can
  change shape, rate-limit or block cloud IP ranges without notice. FPL's site
  terms restrict use of its content to personal, non-commercial purposes.
  PITCHMARKET is a free, non-commercial game. Before any commercial use, obtain a
  licensed feed (Opta/Stats Perform, Sportmonks, API-Football paid plans…).
* The archive mirrors FPL data. Its MIT license covers the repository's code and
  compilation, not the Premier League's underlying rights.
* **The ESPN feed breaks ESPN's terms.** It is undocumented, and the Disney terms
  of use that cover ESPN forbid accessing or extracting their services with a
  robot, script or other automated means without written permission. There was no
  free, terms-compliant source of current-season per-player stats for these
  competitions (see the table), so the operator chose to accept this risk for a
  free, non-commercial game. Consequences to expect: the feed can change shape,
  rate-limit or block this server at any time, and ESPN could ask you to stop. To
  limit load, PITCHMARKET makes few requests (squads twice a day, the season's
  fixtures four times a day, today's matches about every minute and a half only
  around kickoffs, one match sheet per live match per minute), caches league
  metadata, and backs off on errors. **To stop using it, set `ESPN_ENABLED=false`**:
  those players stay listed at their last price (prices stop moving), and nothing
  else changes. For anything commercial, replace it with a
  licensed feed: implement `MarketDataProvider` with the same `espn` competitions
  (for example API-Football's paid plan).
* The GitHub "Market wake-up" workflow also reads ESPN's daily scoreboards (a
  handful of requests per hour) to know when to wake the server. Set the repository
  variable `ESPN_LEAGUES=none` to stop that.
* No player photos, club crests or league logos are used, because their licensing
  isn't covered by these sources. Players are shown with initials, clubs with
  short names.
* No website is scraped. Only JSON/CSV endpoints intended for programmatic access are called.

## Attribution shown in the product

* Footer and data banners name the source: "Fantasy Premier League", plus "via
  the public FPL archive on GitHub" in snapshot mode, and "ESPN (unofficial public
  feed)" for the other leagues (landing footer, Fixtures screen, each player's
  match table).
* "Not affiliated with or endorsed by the Premier League."
* football-data.org fixtures: "Football data provided by the Football-Data.org API"
  (stored on the provider adapter for use where its fixtures are displayed).

## Adding a licensed provider

Implement `MarketDataProvider` in `src/server/ingestion/providers/` (see
`fpl.ts`). Map the provider's stats to `MatchStats`, using `null` for anything it
doesn't supply. Register it in `registry.ts`. Scoring baselines for stats FPL
doesn't publish are already in `model-baselines.json` (marked provisional).
