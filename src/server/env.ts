import "server-only";
import { z } from "zod";

/**
 * Centralised, validated server configuration. Nothing in here is ever sent to
 * the browser. Public values the UI needs are exposed through explicit API
 * responses, never by importing this module from client code.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_NAME: z.string().min(1).default("PITCHMARKET"),
  /** `production` = real competition. `demo` = demo banner, demo accounts allowed, self-service portfolio reset. */
  APP_MODE: z.enum(["production", "demo"]).default("production"),

  STARTING_BALANCE_CREDITS: z.coerce.number().int().positive().max(10_000_000).default(100_000),
  TRADING_FEE_BPS: z.coerce.number().int().min(0).max(500).default(0),
  MAX_SHARES_PER_ORDER: z.coerce.number().int().positive().max(1_000_000).default(5_000),
  /** `halt` blocks trading in a player while their match is live (fair play against delayed feeds). */
  LIVE_TRADING_POLICY: z.enum(["halt", "allow"]).default("halt"),
  /** Trading auto-halts if a live match has had no successful data refresh for this long. */
  STALE_LIVE_DATA_HALT_MINUTES: z.coerce.number().int().positive().default(15),

  /** `auto` tries the official FPL feed and falls back to the public GitHub snapshot. */
  DATA_PROVIDER: z.enum(["auto", "fpl", "fpl-archive"]).default("auto"),
  FPL_BASE_URL: z.string().url().default("https://fantasy.premierleague.com/api"),
  FPL_ARCHIVE_BASE_URL: z
    .string()
    .url()
    .default("https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"),
  FPL_SEASON: z.string().regex(/^\d{4}-\d{2}$/).default("2026-27"),
  /** Optional local directory holding the archive CSVs (offline seeding / tests). */
  FPL_ARCHIVE_LOCAL_DIR: z.string().optional(),
  LIVE_POLL_SECONDS: z.coerce.number().int().min(30).default(60),
  /**
   * Tradable La Liga, Bundesliga, Serie A, Ligue 1 and Champions League players
   * from ESPN's public site feed. Unofficial: ESPN/Disney terms forbid automated
   * access, so this is opt-in and the risk is documented in docs/DATA_LICENSING.md.
   */
  ESPN_ENABLED: bool(false),
  ESPN_LEAGUES: z.string().default("esp.1,ger.1,ita.1,fra.1,uefa.champions"),
  ESPN_BASE_URL: z.string().url().default("https://site.api.espn.com/apis/site/v2/sports/soccer"),
  FOOTBALL_DATA_API_KEY: z.string().optional(),
  FOOTBALL_DATA_COMPETITIONS: z.string().default("PD,BL1,SA,FL1,CL"),
  API_FOOTBALL_KEY: z.string().optional(),
  API_FOOTBALL_LEAGUES: z.string().default(""),
  API_FOOTBALL_SEASON: z.coerce.number().int().optional(),

  CRON_SECRET: z.string().min(16).optional(),
  /**
   * Run the scheduler inside the web server process (single-instance hosts such
   * as Render). Ticks adapt to the fixture list: every LIVE_POLL_SECONDS around
   * matches, at most every SCHEDULER_IDLE_SECONDS otherwise, so a scale-to-zero
   * database can sleep between match days.
   */
  ENABLE_INPROCESS_SCHEDULER: bool(false),
  SCHEDULER_IDLE_SECONDS: z.coerce.number().int().min(300).max(6 * 3600).default(3600),
  /**
   * Public URL the server pings (GET /api/health, no database) only while a
   * match is live, imminent or settling, so sleep-on-idle hosts stay awake for
   * live pricing and still sleep the rest of the week. Defaults to Render's
   * RENDER_EXTERNAL_URL. Set KEEP_AWAKE_DURING_MATCHES=false to disable.
   */
  KEEP_AWAKE_DURING_MATCHES: bool(true),
  KEEPALIVE_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("PITCHMARKET <no-reply@pitchmarket.local>"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Lower-case name of the one header to trust for the client IP (rate limits), e.g. `true-client-ip` on Render. */
  CLIENT_IP_HEADER: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).optional(),
  SECURE_COOKIES: bool(process.env.NODE_ENV === "production"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // `KEY=` (empty) means "not set", so a copied .env.example with blank optional keys is valid.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached env so tests can change process.env. */
export function resetEnvCache() {
  cached = null;
}
