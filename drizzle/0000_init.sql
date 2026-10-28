CREATE TYPE "public"."availability" AS ENUM('available', 'doubtful', 'injured', 'suspended', 'unavailable', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."cash_entry_kind" AS ENUM('grant', 'trade', 'reset');--> statement-breakpoint
CREATE TYPE "public"."fixture_status" AS ENUM('scheduled', 'live', 'finished', 'postponed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."friend_request_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."league_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."league_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('open', 'halted', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."position" AS ENUM('GK', 'DEF', 'MID', 'FWD');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'success', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."tick_reason" AS ENUM('ipo', 'match_live', 'match_final', 'admin');--> statement-breakpoint
CREATE TYPE "public"."trade_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('public', 'friends', 'private');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_cents" bigint NOT NULL,
	"starting_cents" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_non_negative" CHECK ("cash_accounts"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cash_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "cash_entry_kind" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"trade_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "clubs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"competition_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"season" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"has_player_stats" boolean DEFAULT false NOT NULL,
	"has_live_data" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixtures" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fixtures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"competition_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"round" integer,
	"kickoff_at" timestamp with time zone,
	"home_club_id" integer,
	"away_club_id" integer,
	"home_name" text NOT NULL,
	"away_name" text NOT NULL,
	"home_score" smallint,
	"away_score" smallint,
	"status" "fixture_status" DEFAULT 'scheduled' NOT NULL,
	"minute" smallint,
	"stats_final" boolean DEFAULT false NOT NULL,
	"settled_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"last_stats_sync_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friend_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"status" "friend_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "fr_not_self" CHECK ("friend_requests"."from_user_id" <> "friend_requests"."to_user_id")
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"user_a_id" uuid NOT NULL,
	"user_b_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_user_a_id_user_b_id_pk" PRIMARY KEY("user_a_id","user_b_id"),
	CONSTRAINT "friendships_ordered" CHECK ("friendships"."user_a_id" < "friendships"."user_b_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"provider" text NOT NULL,
	"status" "run_status" NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"rate_limited" boolean DEFAULT false NOT NULL,
	"error" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "job_locks" (
	"job" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text
);
--> statement-breakpoint
CREATE TABLE "league_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_by" uuid NOT NULL,
	"invited_user_id" uuid,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_members" (
	"league_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "league_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_members_league_id_user_id_pk" PRIMARY KEY("league_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" uuid NOT NULL,
	"visibility" "league_visibility" DEFAULT 'private' NOT NULL,
	"max_members" integer DEFAULT 50 NOT NULL,
	"members_can_invite" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "market_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"status" "market_status" DEFAULT 'open' NOT NULL,
	"status_reason" text,
	"status_set_by" text,
	"data_provider" text,
	"data_mode" text DEFAULT 'none' NOT NULL,
	"data_as_of" timestamp with time zone,
	"last_price_update_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_state_singleton" CHECK ("market_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_match_stats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"fixture_id" integer NOT NULL,
	"club_id" integer,
	"minutes" smallint NOT NULL,
	"started" boolean,
	"goals" smallint,
	"assists" smallint,
	"shots" smallint,
	"shots_on_target" smallint,
	"key_passes" smallint,
	"xg" real,
	"xa" real,
	"dribbles" smallint,
	"tackles" smallint,
	"interceptions" smallint,
	"clearances" smallint,
	"cbi" smallint,
	"recoveries" smallint,
	"saves" smallint,
	"clean_sheet" boolean,
	"goals_conceded" smallint,
	"xgc" real,
	"own_goals" smallint,
	"penalties_saved" smallint,
	"penalties_missed" smallint,
	"yellow_cards" smallint,
	"red_cards" smallint,
	"performance_score" double precision,
	"expected_score" double precision,
	"score_breakdown" jsonb,
	"is_final" boolean DEFAULT false NOT NULL,
	"stats_hash" text NOT NULL,
	"source" text NOT NULL,
	"source_updated_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_prices" (
	"player_id" integer PRIMARY KEY NOT NULL,
	"price_cents" bigint NOT NULL,
	"previous_price_cents" bigint NOT NULL,
	"ipo_price_cents" bigint NOT NULL,
	"settled_price_cents" bigint NOT NULL,
	"fundamental_cents" bigint NOT NULL,
	"form_index" double precision DEFAULT 0 NOT NULL,
	"quality_sum" double precision DEFAULT 0 NOT NULL,
	"quality_weight" double precision DEFAULT 0 NOT NULL,
	"quality_index" double precision DEFAULT 0 NOT NULL,
	"prior_quality" double precision DEFAULT 0 NOT NULL,
	"prior_weight" double precision DEFAULT 0 NOT NULL,
	"role_sum" double precision DEFAULT 0 NOT NULL,
	"role_matches" integer DEFAULT 0 NOT NULL,
	"prior_role" double precision DEFAULT 0.5 NOT NULL,
	"prior_role_weight" double precision DEFAULT 4 NOT NULL,
	"matches_priced" integer DEFAULT 0 NOT NULL,
	"live_fixture_id" integer,
	"market_version" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_prices_positive" CHECK ("player_prices"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "players_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"provider_season_ref" text,
	"slug" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"display_name" text NOT NULL,
	"club_id" integer,
	"competition_id" integer NOT NULL,
	"position" "position" NOT NULL,
	"nationality" text,
	"birth_date" text,
	"squad_number" smallint,
	"availability" "availability" DEFAULT 'unknown' NOT NULL,
	"availability_note" text,
	"chance_of_playing" smallint,
	"availability_updated_at" timestamp with time zone,
	"is_tradable" boolean DEFAULT true NOT NULL,
	"source_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"value_cents" bigint NOT NULL,
	"cash_cents" bigint NOT NULL,
	"holdings_cents" bigint NOT NULL,
	"global_rank" integer,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_snapshots_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"user_id" uuid NOT NULL,
	"player_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"cost_basis_cents" bigint NOT NULL,
	"realized_pnl_cents" bigint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_user_id_player_id_pk" PRIMARY KEY("user_id","player_id"),
	CONSTRAINT "positions_qty_non_negative" CHECK ("positions"."quantity" >= 0),
	CONSTRAINT "positions_basis_non_negative" CHECK ("positions"."cost_basis_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_ticks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"fixture_id" integer,
	"reason" "tick_reason" NOT NULL,
	"price_cents" bigint NOT NULL,
	"previous_price_cents" bigint NOT NULL,
	"performance_score" double precision,
	"z_score" double precision,
	"market_version" bigint NOT NULL,
	"stats_hash" text,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_status" (
	"provider" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_allowed_at" timestamp with time zone,
	"rate_limit_hits" integer DEFAULT 0 NOT NULL,
	"data_as_of" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"player_id" integer NOT NULL,
	"side" "trade_side" NOT NULL,
	"quantity" integer NOT NULL,
	"price_cents" bigint NOT NULL,
	"gross_cents" bigint NOT NULL,
	"fee_cents" bigint NOT NULL,
	"cash_delta_cents" bigint NOT NULL,
	"cost_basis_released_cents" bigint DEFAULT 0 NOT NULL,
	"realized_pnl_cents" bigint DEFAULT 0 NOT NULL,
	"cash_after_cents" bigint NOT NULL,
	"position_after_qty" integer NOT NULL,
	"market_version" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_qty_positive" CHECK ("trades"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"avatar_color" text DEFAULT '#3DDC97' NOT NULL,
	"bio" text,
	"portfolio_visibility" "visibility" DEFAULT 'friends' NOT NULL,
	"activity_visibility" "visibility" DEFAULT 'friends' NOT NULL,
	"show_on_global_leaderboard" boolean DEFAULT true NOT NULL,
	"notify_trades" boolean DEFAULT true NOT NULL,
	"notify_social" boolean DEFAULT true NOT NULL,
	"notify_rank" boolean DEFAULT true NOT NULL,
	"onboarded_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_format" CHECK ("users"."username" ~ '^[A-Za-z0-9_]{3,20}$' OR "users"."deleted_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"user_id" uuid NOT NULL,
	"player_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_user_id_player_id_pk" PRIMARY KEY("user_id","player_id")
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_home_club_id_clubs_id_fk" FOREIGN KEY ("home_club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_away_club_id_clubs_id_fk" FOREIGN KEY ("away_club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_invites" ADD CONSTRAINT "league_invites_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_invites" ADD CONSTRAINT "league_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_invites" ADD CONSTRAINT "league_invites_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD CONSTRAINT "player_match_stats_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD CONSTRAINT "player_match_stats_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD CONSTRAINT "player_match_stats_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_prices" ADD CONSTRAINT "player_prices_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_prices" ADD CONSTRAINT "player_prices_live_fixture_id_fixtures_id_fk" FOREIGN KEY ("live_fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_ticks" ADD CONSTRAINT "price_ticks_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_ticks" ADD CONSTRAINT "price_ticks_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_user_idx" ON "activity_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_events" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "cash_entries_user_idx" ON "cash_entries" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "clubs_provider_ref_uq" ON "clubs" USING btree ("provider","provider_ref","competition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitions_code_season_uq" ON "competitions" USING btree ("code","season");--> statement-breakpoint
CREATE UNIQUE INDEX "fixtures_provider_ref_uq" ON "fixtures" USING btree ("provider","provider_ref","competition_id");--> statement-breakpoint
CREATE INDEX "fixtures_kickoff_idx" ON "fixtures" USING btree ("kickoff_at");--> statement-breakpoint
CREATE INDEX "fixtures_status_idx" ON "fixtures" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "fr_pending_pair_uq" ON "friend_requests" USING btree (least("from_user_id", "to_user_id"),greatest("from_user_id", "to_user_id")) WHERE "friend_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "fr_to_idx" ON "friend_requests" USING btree ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "friendships_b_idx" ON "friendships" USING btree ("user_b_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_job_idx" ON "ingestion_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "ingestion_runs_started_idx" ON "ingestion_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "league_invites_code_uq" ON "league_invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "league_invites_league_idx" ON "league_invites" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "lm_user_idx" ON "league_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "leagues_owner_idx" ON "leagues" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prt_token_uq" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "prt_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pms_player_fixture_uq" ON "player_match_stats" USING btree ("player_id","fixture_id");--> statement-breakpoint
CREATE INDEX "pms_fixture_idx" ON "player_match_stats" USING btree ("fixture_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_provider_ref_uq" ON "players" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "players_slug_uq" ON "players" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "players_club_idx" ON "players" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "players_position_idx" ON "players" USING btree ("position");--> statement-breakpoint
CREATE INDEX "snapshots_day_idx" ON "portfolio_snapshots" USING btree ("day");--> statement-breakpoint
CREATE INDEX "positions_player_idx" ON "positions" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "price_ticks_player_idx" ON "price_ticks" USING btree ("player_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_ticks_final_uq" ON "price_ticks" USING btree ("player_id","fixture_id") WHERE "price_ticks"."reason" = 'match_final';--> statement-breakpoint
CREATE UNIQUE INDEX "price_ticks_ipo_uq" ON "price_ticks" USING btree ("player_id") WHERE "price_ticks"."reason" = 'ipo';--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_idempotency_uq" ON "trades" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "trades_user_idx" ON "trades" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_player_idx" ON "trades" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_uq" ON "users" USING btree (lower("username"));