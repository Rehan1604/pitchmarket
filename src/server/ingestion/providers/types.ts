/**
 * Provider adapter contract. The trading engine and price engine only ever see
 * these normalised shapes, so another data source can be added by writing one
 * adapter — no changes to trading, pricing, or the UI.
 */
import type { MatchStats, Position } from "@/server/market/scoring";

export type Availability = "available" | "doubtful" | "injured" | "suspended" | "unavailable" | "unknown";
export type FixtureState = "scheduled" | "live" | "finished" | "postponed" | "cancelled";

export interface ProviderCapabilities {
  /** Per-player per-match statistics (required for a tradable market). */
  playerMatchStats: boolean;
  /** In-play updates during matches. */
  live: boolean;
  /** Expected goals / assists. */
  expectedStats: boolean;
  /** Injury / suspension / availability flags. */
  availability: boolean;
  /** Typical delay between real events and data availability, for UI honesty. */
  typicalDelay: string;
}

export interface NormCompetition {
  code: string;
  name: string;
  country: string | null;
  season: string;
  providerRef: string;
}

export interface NormClub {
  providerRef: string;
  name: string;
  shortName: string;
}

export interface NormPlayer {
  /** Stable identity (survives seasons where the provider supports it). */
  providerRef: string;
  /** Season-scoped id used by match feeds. */
  seasonRef: string;
  firstName: string;
  lastName: string;
  displayName: string;
  clubRef: string | null;
  position: Position;
  nationality: string | null;
  birthDate: string | null;
  squadNumber: number | null;
  availability: Availability;
  availabilityNote: string | null;
  chanceOfPlaying: number | null;
  availabilityUpdatedAt: Date | null;
  /** False when the provider no longer lists the player as active in the competition. */
  active: boolean;
}

export interface NormFixture {
  providerRef: string;
  round: number | null;
  kickoffAt: Date | null;
  homeRef: string | null;
  awayRef: string | null;
  homeName: string;
  awayName: string;
  homeScore: number | null;
  awayScore: number | null;
  status: FixtureState;
  minute: number | null;
  /** The provider has finalised the match statistics. */
  statsFinal: boolean;
  sourceUpdatedAt: Date | null;
}

export interface NormPlayerMatch {
  playerSeasonRef: string;
  fixtureRef: string;
  clubRef: string | null;
  stats: MatchStats & { started: boolean | null; xgc: number | null };
  isFinal: boolean;
  sourceUpdatedAt: Date | null;
}

export interface ReferenceBundle {
  competition: NormCompetition;
  clubs: NormClub[];
  players: NormPlayer[];
  dataAsOf: Date | null;
}

export interface FixtureBundle {
  competition: NormCompetition;
  clubs: NormClub[];
  fixtures: NormFixture[];
  dataAsOf: Date | null;
}

/** A provider for one competition with tradable players. */
export interface MarketDataProvider {
  /** Entity namespace written to provider columns (shared by adapters of the same upstream ids). */
  entityProvider: string;
  /** The concrete source (e.g. `fpl-api`, `fpl-archive`) recorded on stats rows. */
  source: string;
  label: string;
  mode: "live" | "snapshot";
  attribution: string;
  capabilities: ProviderCapabilities;
  /**
   * The primary feed (Premier League via FPL) drives the market-wide data status
   * shown in the UI. Secondary feeds (ESPN leagues) must not overwrite it.
   */
  primary?: boolean;
  /**
   * After a match is final, give every listed squad player of both clubs a
   * 0-minute row if the feed only reports the matchday squad, so the minutes-share
   * (role) model sees matches a player missed.
   */
  fillSquadOnFinal?: boolean;
  fetchReference(): Promise<ReferenceBundle>;
  /** `recent` lets feeds with large calendars fetch only the window around now. */
  fetchFixtures(opts?: { window?: "full" | "recent" }): Promise<FixtureBundle>;
  /** Player stats for the given fixtures (live or finished). */
  fetchMatchStats(fixtures: NormFixture[]): Promise<NormPlayerMatch[]>;
}

/** A provider that only supplies fixtures/results (no player-level data). */
export interface FixtureOnlyProvider {
  entityProvider: string;
  source: string;
  label: string;
  attribution: string;
  capabilities: ProviderCapabilities;
  fetchCompetitionFixtures(code: string): Promise<FixtureBundle>;
}
