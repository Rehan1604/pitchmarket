/**
 * PITCHMARKET database schema (PostgreSQL, Drizzle ORM).
 *
 * Money convention: every monetary amount and share price is an INTEGER number
 * of "cents" (1 Pitch Credit = 100 cents), stored as Postgres BIGINT and handled
 * in JS as a safe integer (guarded in src/lib/money.ts). No floating point is
 * ever persisted for balances, prices or P/L.
 *
 * Authoritative sources (see docs/ARCHITECTURE.md):
 *  - cash:        cash_entries (immutable ledger). cash_accounts.balance_cents is a
 *                 locked, transactionally-maintained running total of it.
 *  - holdings:    trades (immutable ledger). positions is the transactionally
 *                 maintained aggregate of it.
 *  - prices:      price_ticks (append-only history). player_prices holds the latest.
 *  - football:    competitions/clubs/players/fixtures/player_match_stats, each row
 *                 carrying provider + provider_ref + source timestamps.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ---------------------------------------------------------------- enums
export const userRole = pgEnum("user_role", ["user", "admin"]);
export const visibility = pgEnum("visibility", ["public", "friends", "private"]);
export const friendRequestStatus = pgEnum("friend_request_status", ["pending", "accepted", "declined", "cancelled"]);
export const leagueRole = pgEnum("league_role", ["owner", "admin", "member"]);
export const leagueVisibility = pgEnum("league_visibility", ["private", "public"]);
export const position = pgEnum("position", ["GK", "DEF", "MID", "FWD"]);
export const availability = pgEnum("availability", [
  "available",
  "doubtful",
  "injured",
  "suspended",
  "unavailable",
  "unknown",
]);
export const fixtureStatus = pgEnum("fixture_status", ["scheduled", "live", "finished", "postponed", "cancelled"]);
export const marketStatus = pgEnum("market_status", ["open", "halted", "maintenance"]);
export const tradeSide = pgEnum("trade_side", ["buy", "sell"]);
export const tickReason = pgEnum("tick_reason", ["ipo", "match_live", "match_final", "admin"]);
export const cashEntryKind = pgEnum("cash_entry_kind", ["grant", "trade", "reset"]);
export const runStatus = pgEnum("run_status", ["running", "success", "partial", "failed", "skipped"]);

// ---------------------------------------------------------------- identity
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("user"),
    isDemo: boolean("is_demo").notNull().default(false),
    avatarColor: text("avatar_color").notNull().default("#3DDC97"),
    bio: text("bio"),
    portfolioVisibility: visibility("portfolio_visibility").notNull().default("friends"),
    activityVisibility: visibility("activity_visibility").notNull().default("friends"),
    showOnGlobalLeaderboard: boolean("show_on_global_leaderboard").notNull().default(true),
    notifyTrades: boolean("notify_trades").notNull().default(true),
    notifySocial: boolean("notify_social").notNull().default(true),
    notifyRank: boolean("notify_rank").notNull().default(true),
    onboardedAt: ts("onboarded_at"),
    lastActiveAt: ts("last_active_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_username_lower_uq").on(sql`lower(${t.username})`),
    check("users_username_format", sql`${t.username} ~ '^[A-Za-z0-9_]{3,20}$' OR ${t.deletedAt} IS NOT NULL`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256(token) — the raw token only ever exists in the user's cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prt_token_uq").on(t.tokenHash), index("prt_user_idx").on(t.userId)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_user_idx").on(t.userId, t.createdAt), index("audit_action_idx").on(t.action, t.createdAt)],
);

// ---------------------------------------------------------------- social
export const friendRequests = pgTable(
  "friend_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: friendRequestStatus("status").notNull().default("pending"),
    createdAt: createdAt(),
    respondedAt: ts("responded_at"),
  },
  (t) => [
    uniqueIndex("fr_pending_pair_uq")
      .on(sql`least(${t.fromUserId}, ${t.toUserId})`, sql`greatest(${t.fromUserId}, ${t.toUserId})`)
      .where(sql`${t.status} = 'pending'`),
    index("fr_to_idx").on(t.toUserId, t.status),
    check("fr_not_self", sql`${t.fromUserId} <> ${t.toUserId}`),
  ],
);

/** One row per friendship, stored with user_a_id < user_b_id. */
export const friendships = pgTable(
  "friendships",
  {
    userAId: uuid("user_a_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userBId: uuid("user_b_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userAId, t.userBId] }),
    index("friendships_b_idx").on(t.userBId),
    check("friendships_ordered", sql`${t.userAId} < ${t.userBId}`),
  ],
);

export const leagues = pgTable(
  "leagues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    visibility: leagueVisibility("visibility").notNull().default("private"),
    maxMembers: integer("max_members").notNull().default(50),
    /** Members may invite others (owner/admins always can). */
    membersCanInvite: boolean("members_can_invite").notNull().default(true),
    createdAt: createdAt(),
    archivedAt: ts("archived_at"),
  },
  (t) => [index("leagues_owner_idx").on(t.ownerId)],
);

export const leagueMembers = pgTable(
  "league_members",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: leagueRole("role").notNull().default("member"),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.userId] }), index("lm_user_idx").on(t.userId)],
);

export const leagueInvites = pgTable(
  "league_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Set when the invite targets one specific friend. */
    invitedUserId: uuid("invited_user_id").references(() => users.id, { onDelete: "cascade" }),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("league_invites_code_uq").on(t.code), index("league_invites_league_idx").on(t.leagueId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const activityEvents = pgTable(
  "activity_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("activity_user_idx").on(t.userId, t.createdAt), index("activity_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------- football data
export const competitions = pgTable(
  "competitions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    country: text("country"),
    season: text("season").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    /** True when the provider supplies per-player match stats, i.e. players are tradable. */
    hasPlayerStats: boolean("has_player_stats").notNull().default(false),
    hasLiveData: boolean("has_live_data").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("competitions_code_season_uq").on(t.code, t.season)],
);

export const clubs = pgTable(
  "clubs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    competitionId: integer("competition_id")
      .notNull()
      .references(() => competitions.id),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    name: text("name").notNull(),
    shortName: text("short_name").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("clubs_provider_ref_uq").on(t.provider, t.providerRef, t.competitionId)],
);

export const players = pgTable(
  "players",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    provider: text("provider").notNull(),
    /** Stable cross-season identity from the provider (FPL "code"). */
    providerRef: text("provider_ref").notNull(),
    /** Provider's per-season id (FPL "element" id). */
    providerSeasonRef: text("provider_season_ref"),
    slug: text("slug").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    displayName: text("display_name").notNull(),
    clubId: integer("club_id").references(() => clubs.id),
    competitionId: integer("competition_id")
      .notNull()
      .references(() => competitions.id),
    position: position("position").notNull(),
    nationality: text("nationality"),
    birthDate: text("birth_date"),
    squadNumber: smallint("squad_number"),
    availability: availability("availability").notNull().default("unknown"),
    availabilityNote: text("availability_note"),
    chanceOfPlaying: smallint("chance_of_playing"),
    availabilityUpdatedAt: ts("availability_updated_at"),
    isTradable: boolean("is_tradable").notNull().default(true),
    sourceUpdatedAt: ts("source_updated_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("players_provider_ref_uq").on(t.provider, t.providerRef),
    uniqueIndex("players_slug_uq").on(t.slug),
    index("players_club_idx").on(t.clubId),
    index("players_position_idx").on(t.position),
  ],
);

export const fixtures = pgTable(
  "fixtures",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    competitionId: integer("competition_id")
      .notNull()
      .references(() => competitions.id),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    round: integer("round"),
    kickoffAt: ts("kickoff_at"),
    homeClubId: integer("home_club_id").references(() => clubs.id),
    awayClubId: integer("away_club_id").references(() => clubs.id),
    homeName: text("home_name").notNull(),
    awayName: text("away_name").notNull(),
    homeScore: smallint("home_score"),
    awayScore: smallint("away_score"),
    status: fixtureStatus("status").notNull().default("scheduled"),
    minute: smallint("minute"),
    /** Provider says the result/stats are final (FPL `finished`). Settlement only happens then. */
    statsFinal: boolean("stats_final").notNull().default(false),
    settledAt: ts("settled_at"),
    sourceUpdatedAt: ts("source_updated_at"),
    lastStatsSyncAt: ts("last_stats_sync_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fixtures_provider_ref_uq").on(t.provider, t.providerRef, t.competitionId),
    index("fixtures_kickoff_idx").on(t.kickoffAt),
    index("fixtures_status_idx").on(t.status),
  ],
);

/**
 * Per-player, per-fixture statistics. A NULL column means "the provider does not
 * supply this stat for this match" — it is NOT zero and is excluded from scoring.
 */
export const playerMatchStats = pgTable(
  "player_match_stats",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixtures.id),
    clubId: integer("club_id").references(() => clubs.id),
    minutes: smallint("minutes").notNull(),
    started: boolean("started"),
    goals: smallint("goals"),
    assists: smallint("assists"),
    shots: smallint("shots"),
    shotsOnTarget: smallint("shots_on_target"),
    keyPasses: smallint("key_passes"),
    xg: real("xg"),
    xa: real("xa"),
    dribbles: smallint("dribbles"),
    tackles: smallint("tackles"),
    interceptions: smallint("interceptions"),
    clearances: smallint("clearances"),
    /** Combined clearances+blocks+interceptions where the provider only reports the sum. */
    cbi: smallint("cbi"),
    recoveries: smallint("recoveries"),
    saves: smallint("saves"),
    cleanSheet: boolean("clean_sheet"),
    goalsConceded: smallint("goals_conceded"),
    xgc: real("xgc"),
    ownGoals: smallint("own_goals"),
    penaltiesSaved: smallint("penalties_saved"),
    penaltiesMissed: smallint("penalties_missed"),
    yellowCards: smallint("yellow_cards"),
    redCards: smallint("red_cards"),
    performanceScore: doublePrecision("performance_score"),
    expectedScore: doublePrecision("expected_score"),
    scoreBreakdown: jsonb("score_breakdown").$type<Record<string, number>>(),
    isFinal: boolean("is_final").notNull().default(false),
    statsHash: text("stats_hash").notNull(),
    source: text("source").notNull(),
    sourceUpdatedAt: ts("source_updated_at"),
    ingestedAt: ts("ingested_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pms_player_fixture_uq").on(t.playerId, t.fixtureId),
    index("pms_fixture_idx").on(t.fixtureId),
  ],
);

// ---------------------------------------------------------------- market
export const marketState = pgTable(
  "market_state",
  {
    id: smallint("id").primaryKey().default(1),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    status: marketStatus("status").notNull().default("open"),
    statusReason: text("status_reason"),
    /** Who set the status: `admin` (manual) or `system` (automatic outage halt). */
    statusSetBy: text("status_set_by"),
    dataProvider: text("data_provider"),
    /** `live` (provider feed reachable), `snapshot` (delayed public snapshot), `none`. */
    dataMode: text("data_mode").notNull().default("none"),
    dataAsOf: ts("data_as_of"),
    lastPriceUpdateAt: ts("last_price_update_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("market_state_singleton", sql`${t.id} = 1`)],
);

export const playerPrices = pgTable(
  "player_prices",
  {
    playerId: integer("player_id")
      .primaryKey()
      .references(() => players.id),
    priceCents: money("price_cents").notNull(),
    /** Price immediately before the most recent movement (for "% change since last match"). */
    previousPriceCents: money("previous_price_cents").notNull(),
    ipoPriceCents: money("ipo_price_cents").notNull(),
    /** Last settled (end-of-match) price; live ticks are applied on top of this. */
    settledPriceCents: money("settled_price_cents").notNull(),
    fundamentalCents: money("fundamental_cents").notNull(),
    formIndex: doublePrecision("form_index").notNull().default(0),
    /** Σ(z·m) over priced matches this season. */
    qualitySum: doublePrecision("quality_sum").notNull().default(0),
    /** Σ(m) over priced matches this season (minutes-weighted match count). */
    qualityWeight: doublePrecision("quality_weight").notNull().default(0),
    qualityIndex: doublePrecision("quality_index").notNull().default(0),
    priorQuality: doublePrecision("prior_quality").notNull().default(0),
    priorWeight: doublePrecision("prior_weight").notNull().default(0),
    /** Role (minutes share): Σm this season, team matches this season, and the carried prior. */
    roleSum: doublePrecision("role_sum").notNull().default(0),
    roleMatches: integer("role_matches").notNull().default(0),
    priorRole: doublePrecision("prior_role").notNull().default(0.5),
    priorRoleWeight: doublePrecision("prior_role_weight").notNull().default(4),
    matchesPriced: integer("matches_priced").notNull().default(0),
    liveFixtureId: integer("live_fixture_id").references(() => fixtures.id),
    marketVersion: bigint("market_version", { mode: "number" }).notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("player_prices_positive", sql`${t.priceCents} > 0`)],
);

export const priceTicks = pgTable(
  "price_ticks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    fixtureId: integer("fixture_id").references(() => fixtures.id),
    reason: tickReason("reason").notNull(),
    priceCents: money("price_cents").notNull(),
    previousPriceCents: money("previous_price_cents").notNull(),
    performanceScore: doublePrecision("performance_score"),
    zScore: doublePrecision("z_score"),
    marketVersion: bigint("market_version", { mode: "number" }).notNull(),
    statsHash: text("stats_hash"),
    /** When the movement happened in football time (match end for settlements). */
    effectiveAt: ts("effective_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("price_ticks_player_idx").on(t.playerId, t.effectiveAt),
    uniqueIndex("price_ticks_final_uq")
      .on(t.playerId, t.fixtureId)
      .where(sql`${t.reason} = 'match_final'`),
    uniqueIndex("price_ticks_ipo_uq").on(t.playerId).where(sql`${t.reason} = 'ipo'`),
  ],
);

// ---------------------------------------------------------------- portfolios
export const cashAccounts = pgTable(
  "cash_accounts",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    balanceCents: money("balance_cents").notNull(),
    startingCents: money("starting_cents").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("cash_non_negative", sql`${t.balanceCents} >= 0`)],
);

export const cashEntries = pgTable(
  "cash_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: cashEntryKind("kind").notNull(),
    amountCents: money("amount_cents").notNull(),
    balanceAfterCents: money("balance_after_cents").notNull(),
    tradeId: uuid("trade_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("cash_entries_user_idx").on(t.userId, t.id)],
);

export const positions = pgTable(
  "positions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    quantity: integer("quantity").notNull(),
    costBasisCents: money("cost_basis_cents").notNull(),
    realizedPnlCents: money("realized_pnl_cents").notNull().default(0),
    openedAt: ts("opened_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.playerId] }),
    index("positions_player_idx").on(t.playerId),
    check("positions_qty_non_negative", sql`${t.quantity} >= 0`),
    check("positions_basis_non_negative", sql`${t.costBasisCents} >= 0`),
  ],
);

/** Immutable trade ledger (UPDATE/DELETE blocked by a trigger, see migration). */
export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    side: tradeSide("side").notNull(),
    quantity: integer("quantity").notNull(),
    priceCents: money("price_cents").notNull(),
    grossCents: money("gross_cents").notNull(),
    feeCents: money("fee_cents").notNull(),
    /** Signed change to cash: negative for buys, positive for sells. */
    cashDeltaCents: money("cash_delta_cents").notNull(),
    costBasisReleasedCents: money("cost_basis_released_cents").notNull().default(0),
    realizedPnlCents: money("realized_pnl_cents").notNull().default(0),
    cashAfterCents: money("cash_after_cents").notNull(),
    positionAfterQty: integer("position_after_qty").notNull(),
    marketVersion: bigint("market_version", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("trades_idempotency_uq").on(t.userId, t.idempotencyKey),
    index("trades_user_idx").on(t.userId, t.createdAt),
    index("trades_player_idx").on(t.playerId, t.createdAt),
    check("trades_qty_positive", sql`${t.quantity} > 0`),
  ],
);

export const watchlist = pgTable(
  "watchlist",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.playerId] })],
);

/** Point-in-time portfolio valuations for daily/weekly leaderboards and charts. */
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** UTC day bucket (YYYY-MM-DD) — one snapshot per user per day. */
    day: text("day").notNull(),
    valueCents: money("value_cents").notNull(),
    cashCents: money("cash_cents").notNull(),
    holdingsCents: money("holdings_cents").notNull(),
    globalRank: integer("global_rank"),
    takenAt: ts("taken_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] }), index("snapshots_day_idx").on(t.day)],
);

// ---------------------------------------------------------------- operations
export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    job: text("job").notNull(),
    provider: text("provider").notNull(),
    status: runStatus("status").notNull(),
    trigger: text("trigger").notNull().default("schedule"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    itemsProcessed: integer("items_processed").notNull().default(0),
    rateLimited: boolean("rate_limited").notNull().default(false),
    error: text("error"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("ingestion_runs_job_idx").on(t.job, t.startedAt), index("ingestion_runs_started_idx").on(t.startedAt)],
);

export const providerStatus = pgTable("provider_status", {
  provider: text("provider").primaryKey(),
  lastSuccessAt: ts("last_success_at"),
  lastErrorAt: ts("last_error_at"),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /** Backoff / rate-limit gate: do not call the provider before this instant. */
  nextAllowedAt: ts("next_allowed_at"),
  rateLimitHits: integer("rate_limit_hits").notNull().default(0),
  dataAsOf: ts("data_as_of"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Advisory scheduler bookkeeping so concurrent cron invocations do not double-run jobs. */
export const jobLocks = pgTable("job_locks", {
  job: text("job").primaryKey(),
  lockedUntil: ts("locked_until").notNull(),
  lastRunAt: ts("last_run_at"),
  lastStatus: text("last_status"),
});
