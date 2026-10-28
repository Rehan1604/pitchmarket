# Data sources, licensing and attribution

PITCHMARKET only uses data sources it can identify and attribute, and it labels
data provenance and freshness in the interface.

## Providers evaluated (October 2026)

| Provider | Free tier | Player match stats | Current season | Verdict |
|---|---|---|---|---|
| **Fantasy Premier League API** (fantasy.premierleague.com/api) | No key | Yes: minutes, goals, assists, xG, xA, saves, clean sheets, tackles, CBI, recoveries, cards; availability | Yes, live in-play | **Primary for the Premier League.** Unofficial, see risks below. |
| **FPL public archive** (github.com/vaastav/Fantasy-Premier-League) | No key | Same fields, per fixture | Yes, delayed by days | **Fallback / snapshot mode.** Repository is MIT-licensed; the data originates from FPL. |
| football-data.org v4 | Free key, 10 req/min, 12 competitions | **No** (lineups, cards, squads and stats need paid add-ons) | Yes, scores delayed on the free tier | **Optional, results only** for La Liga, Bundesliga, Serie A, Ligue 1, Champions League. |
| API-Football (api-sports.io) | 100 req/day | Yes (rich per-fixture stats) | **Not on the free plan** (paid from ~$19/mo) | Not implemented. The adapter interface supports it if you buy a plan (see below). |
| Sportmonks | Free plan: Danish Superliga and Scottish Premiership only | Yes | Yes | Not suitable for the free target leagues. |

The free market therefore covers Premier League players. The other major
competitions appear on the Fixtures screen as results-only when a
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
* No player photos, club crests or league logos are used, because their licensing
  isn't covered by these sources. Players are shown with initials, clubs with
  short names.
* No website is scraped. Only JSON/CSV endpoints intended for programmatic access are called.

## Attribution shown in the product

* Footer and data banners name the source: "Fantasy Premier League", plus "via
  the public FPL archive on GitHub" in snapshot mode.
* "Not affiliated with or endorsed by the Premier League."
* football-data.org fixtures: "Football data provided by the Football-Data.org API"
  (stored on the provider adapter for use where its fixtures are displayed).

## Adding a licensed provider

Implement `MarketDataProvider` in `src/server/ingestion/providers/` (see
`fpl.ts`). Map the provider's stats to `MatchStats`, using `null` for anything it
doesn't supply. Register it in `registry.ts`. Scoring baselines for stats FPL
doesn't publish are already in `model-baselines.json` (marked provisional).
