# Market mechanics

PITCHMARKET is a game played with **virtual Pitch Credits (PC)**. Prices are game
prices produced by the deterministic engine described here. They are not
real-world player valuations, and nothing can be deposited, withdrawn or won.

Code: `src/server/market/scoring.ts` (match scoring), `src/server/market/pricing.ts`
(price engine), `src/server/ingestion/pipeline.ts` (when prices change),
`src/server/trading/service.ts` (orders), `src/server/leaderboard/service.ts` (rankings).

## 1. Match performance score

Scoring and pricing are separate. For one player in one match the scorer
produces a points total `s`, the expected total `e` for an average player in
the same position over the same minutes, and a normalised score
`z = clamp((s − e) / σ[position], −3, +4)`.

**Missing data is never zero.** A stat the provider does not publish is
excluded from both `s` and `e`, so it can't help or hurt a player. FPL does not
publish shots, key passes, dribbles or separate interceptions/clearances; those
are simply not judged for Premier League players.

Points per unit (`WEIGHTS` in `scoring.ts`):

| Stat | GK | DEF | MID | FWD |
|---|---|---|---|---|
| Appearance (1–59′ / 60′+) | 1 / 2 | 1 / 2 | 1 / 2 | 1 / 2 |
| Goal | 6 | 6 | 5 | 4 |
| Assist | 3 | 3 | 3 | 3 |
| xG / xA (per 1.0) | 1.5 | 1.5 | 1.5 | 1.5 |
| Shot / shot on target | 0.1 / 0.3 | 0.1 / 0.3 | 0.1 / 0.3 | 0.1 / 0.3 |
| Key pass / successful dribble | 0.4 / 0.3 | 0.4 / 0.3 | 0.4 / 0.3 | 0.4 / 0.3 |
| Tackle / interception | 0.2 | 0.35 | 0.3 | 0.2 |
| Clearance | 0.05 | 0.1 | 0.05 | 0.05 |
| Clearances+blocks+interceptions (combined) | 0.05 | 0.15 | 0.15 | 0.1 |
| Recovery | 0.03 | 0.06 | 0.06 | 0.06 |
| Save | 0.5 | – | – | – |
| Clean sheet (60′+ only) | 4 | 4 | 1 | 0 |
| Goal conceded | −0.5 | −0.5 | 0 | 0 |
| Penalty saved / missed | 5 / −2 | 5 / −2 | 5 / −2 | 5 / −2 |
| Own goal | −2 | −2 | −2 | −2 |
| Yellow / red card | −1 / −3 | −1 / −3 | −1 / −3 | −1 / −3 |

The combined clearances+blocks+interceptions stat is used only when a provider
doesn't report interceptions and clearances separately (no double counting).

### Baselines (derived from real data)

`npm run data:derive` computes per-90 rates, the clean-sheet rate and σ from
**11,498 Premier League appearances in 2025-26** (FPL archive), and writes
`src/server/market/model-baselines.json`. Selected values:

| Per 90 minutes | GK | DEF | MID | FWD |
|---|---|---|---|---|
| Goals | 0.000 | 0.043 | 0.150 | 0.402 |
| Assists | 0.007 | 0.075 | 0.167 | 0.127 |
| xG | 0.000 | 0.057 | 0.153 | 0.410 |
| xA | 0.002 | 0.058 | 0.126 | 0.060 |
| Saves | 2.782 | 0 | 0 | 0 |
| Tackles | 0.032 | 1.706 | 1.839 | 0.803 |
| Clearances+blocks+interceptions | 1.229 | 5.979 | 2.316 | 1.644 |
| Recoveries | 8.152 | 3.696 | 4.421 | 2.349 |
| Goals conceded | 1.378 | 1.391 | 1.369 | 1.406 |
| Clean-sheet rate (60′+) | 0.255 | 0.272 | 0.303 | 0.318 |
| σ of (score − expected), 60′+ | 2.45 | 2.92 | 2.56 | 3.02 |

Rates for stats FPL doesn't publish (shots, key passes, dribbles, interceptions,
clearances) are provisional top-flight averages, flagged in the JSON; they only
matter for future providers that supply those stats.

## 2. Price engine

All state needed to continue a player's price path lives in `player_prices`,
so the whole history can be replayed from the recorded matches. The integration
test suite replays every player and checks it matches the stored prices exactly.

```
m          = √(min(minutes, 90) / 90)                      minutes / sample-size weight
quality    = (priorQ·priorW + Σ z·m) / (priorW + Σ m + 6)  season quality, shrunk toward average
form       = EWMA of z·m, half-life 4 matches              recent form with time decay
role       = (priorRole·priorRoleW + Σ m) / (priorRoleW + team matches)   share of minutes
fundamental F = base[pos] × e^(1.1 · (0.7·quality + 0.3·form)) × (0.6 + 0.8·role)

per match the player appeared in:
catch-up = 0.12 · ln(F_after / P_before)                  pull toward fair value
catch-up = max(0, catch-up) if z > 0,  min(0, catch-up) if z < 0,  0 if z = 0
catch-up = catch-up · min(1, |z|)                          scaled by how far past par
u       = 0.035 · z · m + catch-up
r       = u                                   if |u| ≤ 8%
r       = ±(8% + 1.5% · ln(1 + (|u| − 8%) / 1.5%))   otherwise, hard limit ±15%
P_after = clamp(round(P_before · (1 + r)), 50 PC, 15,000 PC)
```

* **The match sets the direction.** The catch-up toward fair value only adds to
  a move that already goes the way the match went. A below-par match (z < 0)
  can't raise a price, even when the price lags far below fair value, and an
  above-par match can't lower one.
* **How far past par sets how much catch-up applies.** The catch-up is full for a
  clearly good or bad match (|z| ≥ 1, about one goal for a forward), a sliver for
  one just either side of par, and zero for an exactly average one. The move is
  continuous and never smaller after a better match, so there is no cliff at par.
* **History.** Before 29 Oct 2026 the catch-up applied in full and in either
  direction. Lamine Yamal rose 4.55% after a 2.5-vs-4.4 game against Real
  Madrid, because his price (2,230) was far below his fair value (4,030). Under
  the current rule that match is −2.55%. Under the first fix (direction only), a
  goalless 8-shot, 6-on-target game (4.6 vs 4.4) would still have given him
  +5.95%; now it gives +0.72%. Moves settled before these changes were not
  re-priced. Holdings, cash, trades and price history are untouched.

* **Base price (demand assumption):** GK 800, DEF 900, MID 1,050, FWD 1,150 PC.
  Attackers carry a modest premium because they're the most sought-after shares.
* **Initial price (IPO):** `P0 = F` at season open, using last season's quality and
  minutes share from `data/priors/fpl-2025-26.json` (keyed by the stable FPL
  `code`). Last season's quality weight is halved and capped at 15 matches, so a
  new season can change a player's value quickly. Players without Premier League
  history start at the positional base with a neutral role. At launch prices
  range from about 460 to 2,330 PC (Haaland and Bruno Fernandes at the top).
* **Did not play:** no price step. Only the role count advances, so a long
  absence can lower fundamental value, which reaches the price gradually through
  later below-par matches. Absence never crashes a price.
* **Soft cap:** a move of up to 8% counts in full. Beyond 8% the excess is compressed
  logarithmically, so a bigger match always moves the price more, with diminishing
  returns, never more than ±15%. Hard price bounds are 50 and 15,000 PC. Before
  31 Oct 2026 this was a hard ±8% cap, which made 2, 3, 4 or 5 goal involvements
  (and a defender's brace versus a forward's) all the same +8%.
* **Match rating range:** the rating (z) runs from −6 to 12 so a bigger haul always
  rates higher. Season quality and form, which set fair value, still use z clamped
  to [−3, 4], so one freak match can't run away with a player's fair value.
* **Positions:** the same goal involvements rate higher for defenders and goalkeepers
  (a goal is 6 points, against 5 for midfielders and 4 for forwards, and they are
  expected to score less), clean sheets add for GK/DEF (and 1 point for MID), and
  goals conceded subtract for GK/DEF. Forwards aren't docked when the defence
  concedes. For a player at fair value, 90 minutes, basic (ESPN) stats:

  | Match | GK | DEF | MID | FWD |
  |---|---|---|---|---|
  | 1 goal, 1 assist, clean sheet | +11.7% | +11.4% | +10.8% | +9.1% |
  | 1 goal, 1 assist, conceded 2 | +10.9% | +10.3% | +10.5% | +9.1% |
  | 2 goals, clean sheet | +12.1% | +11.8% | +11.4% | +10.1% |
  | 2 goals, conceded 2 | +11.5% | +11.2% | +11.2% | +10.1% |
  | 2 goals, 2 assists, conceded 2 | +12.2% | +11.9% | +12.0% | +11.5% |

  Every one of these was +8% under the old hard cap.
* All constants live in `PRICING` (`pricing.ts`). Change them, rerun the tests,
  and replay to see the effect.

### Feeds with fewer stats (ESPN leagues)

La Liga, Bundesliga, Serie A, Ligue 1 and Champions League matches (ESPN feed,
opt-in) report goals, assists, shots, shots on target, saves, goals conceded
while the player was on the pitch, own goals and cards. There is no xG, no
defensive work and no injury news. Scoring is unchanged: missing stats are left
out of both score and expected score. Because fewer stats means less natural
spread, these matches use **σ for the basic profile** (`sigmaLimited`, derived
from the same 2025-26 appearances with the richer stats removed: GK 2.43, DEF 2.79,
MID 2.33, FWD 2.60), so a brace moves a La Liga striker by about as much as it
moves a Premier League one.

* **Minutes** come from the match sheet: starters from 0′, substitutes from their
  substitution minute, until they are substituted, sent off, or full time (90′, or
  120′ after extra time). Stoppage time folds into the base minute (a 90′+4′ cameo
  is 1 minute), like FPL.
* **Clean sheet** = 60+ minutes and no goals conceded while on the pitch.
* **Squad zero-rows:** ESPN only lists the matchday squad. When a match is final,
  every other listed player of both clubs gets a 0-minute row, so the minutes-share
  (role) factor sees matches a player missed, as it does with FPL.
* **Settlement timing:** ESPN has no "stats final" flag, so a match settles 165
  minutes after kickoff (about 45–55 minutes after full time). Until then its
  prices are provisional, like a live match.
* **Starting prices:** there are no prior-season priors for these leagues, so every
  player lists at the position-average price on season open; this season's matches
  are replayed in order on first sync, which separates them quickly. A
  competition's first listing is dated to season open while none of its matches
  has been settled; players added later are listed at the time they appear.

### One player, two feeds

ESPN athlete ids are the same in every ESPN competition, so a Real Madrid
player's La Liga and Champions League matches move one price. A Premier League
club playing in the Champions League appears in ESPN's feed with ESPN ids; its
squad is linked to the FPL-listed players (club recognised by squad birthdays,
players by birthday then name; ambiguous cases stay unlinked). A linked player's
Champions League match moves his FPL-listed price.

**Price paths are strictly chronological.** A match older than the player's
latest priced match (for example a backfilled Champions League tie arriving after
a later league match was already priced) is stored but not priced, and the player
page says so ("Recorded, not priced"). Replaying every path from stored stats
still reproduces every price exactly.

## 3. When prices change (market integrity)

| Event | What happens |
|---|---|
| IPO | Exactly once per player (unique `ipo` tick). Initial listings are dated to season open. |
| Live match | Each stats refresh recomputes a **provisional** price from the last *settled* state plus the current live stats. Re-polling identical stats changes nothing (no compounding). A `match_live` tick is recorded when something happens (goal, shot, card, substitution), not for the minute-by-minute drift, which keeps the append-only history small. |
| Full time, stats final | Exactly one `match_final` step per player per fixture (unique index), applied from the settled base. Becomes the new settled state. Fixtures are locked and marked `settled_at` in the same transaction. |
| Stat corrections after settlement | Not applied. Settled fixtures aren't re-fetched, so a settled price is final, like a closing price. |
| Halt | Admin (manual) or automatic when a live match (kicked off within the last 4 hours) has no fresh data for `STALE_LIVE_DATA_HALT_MINUTES`. Automatic halts lift themselves when data recovers; manual ones never auto-lift. A fixture stuck as "live" for longer is treated as a feed glitch: its players stay locked, the rest of the market trades. |

* **In-play lock (`LIVE_TRADING_POLICY=halt`, default):** a player can't be traded
  while their team's match is live, in any competition. For players who played it
  stays locked until the match is settled (~45–60 minutes after full time), because
  until then their price is still provisional (the club's league and
  Champions League rows, and a Premier League club's linked ESPN row, count as one club). Match feeds arrive after TV, so in-play
  trading would reward whoever watches the fastest stream. Portfolio values still
  move live.
* Every price change bumps `market_state.version`. All price writers lock
  `market_state` first and then `player_prices` (one global lock order, so no deadlocks).

## 4. Orders

* Market orders only, **whole shares only**, at most `MAX_SHARES_PER_ORDER` per order.
* Fee: `TRADING_FEE_BPS` basis points of gross (default 0), rounded half-up, added to
  cost basis on buys and deducted from proceeds on sales.
* The client sends player, side, quantity, an idempotency key and, optionally, the
  price it displayed. The server reads the price inside the transaction. If the
  displayed price is stale, the order is rejected with the new price (HTTP 409
  `PRICE_CHANGED`) and the user confirms again. No client-supplied price, balance
  or P/L is ever trusted.
* One transaction: share-lock `market_state` → lock the cash account (serialises a
  user's orders) → share-lock the price → lock the position → append to `trades`
  and `cash_entries` → update `cash_accounts` and `positions`.
* `(user_id, idempotency_key)` is unique: retries and double-clicks return the
  original receipt; reusing a key for a different order is rejected.
* Each trade stores execution price, quantity, gross, fee, cash delta, realised
  P/L, cash and position after, the **market version** it executed against, and a timestamp.
* Average entry price = cost basis ÷ shares. On a sale the released basis is
  `basis × sold ÷ held` (exact when closing), so realised P/L = proceeds − released basis.

## 5. Leaderboards

* **Ranking formula:** total portfolio value = cash + Σ shares × current price.
  Everyone starts with the same balance and there are no deposits or bonuses, so
  value and return on starting capital rank identically.
* **Periods:** season (vs starting balance), week and day (vs the user's
  start-of-day UTC snapshot 7 / 1 days ago, or the starting balance if they
  joined later).
* **Ties** share a rank (1, 2, 2, 4) and are listed by username, which is deterministic.
* **Movement** arrows compare the current rank with the rank implied by today's
  start-of-day snapshots within the same group.
* Scopes: global (users can opt out in Settings), friends, and each league.
  All are computed on read from persisted data, never cached client-side.
* **Resets** exist only in `APP_MODE=demo` or by an admin. They close holdings at
  current prices through real (fee-free) ledger trades and restore the starting
  balance with an audited `reset` cash entry.
