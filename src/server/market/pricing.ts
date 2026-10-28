/**
 * Price engine — pure and deterministic. Converts per-match z-scores (scoring.ts)
 * into virtual share prices. All state needed to continue a price path lives in
 * `PlayerMarketState`, so the full history can be replayed from recorded matches.
 *
 * Fundamental value
 *   F = base[pos] × e^(κ · blend) × roleFactor
 *   blend      = (1 − formMix) · quality + formMix · form
 *   quality    = (priorQ·priorW + Σ z·m) / (priorW + Σ m + shrink)   — season quality, shrunk to average
 *   form       = EWMA of z·m with a half-life in matches              — recent form, time-decayed
 *   roleFactor = roleFloor + roleSpan · role
 *   role       = (priorRole·priorRoleW + Σ m) / (priorRoleW + team matches)  — share of minutes
 *   m          = √(min(minutes, 90)/90)                               — minutes / sample-size weight
 *
 * Price step for a match the player appeared in
 *   r = clamp(β · z · m + γ · ln(F_after / P_before), ±maxStep)
 *   P_after = clamp(round(P_before · (1 + r)), minPrice, maxPrice)
 *
 * When prices change (market integrity rules):
 *  1. IPO: once per player, P0 = F with last season's carried priors.
 *  2. Live: while a player's match is in play, a provisional price is computed
 *     from the CURRENT live stats applied to the last settled state. Repeated
 *     polls never compound — each live tick recomputes from the settled base.
 *  3. Settlement: when the provider marks the match final, one step is applied
 *     exactly once per player per fixture and becomes the new settled base.
 *  4. Did not play (0 minutes): no price step. Only the role count advances, which
 *     can lower fundamental value gradually via later mean reversion — absence
 *     never crashes a price.
 * Completed trades are never re-priced.
 */
import type { Position } from "./scoring";

export const PRICING = {
  /** Base price (credits) for an average-quality, half-time-role player. Position premium = demand assumption. */
  baseCredits: { GK: 800, DEF: 900, MID: 1050, FWD: 1150 } as Record<Position, number>,
  /** Elasticity of fundamental value to quality/form: e^(κ·blend). */
  kappa: 1.1,
  /** Shrinkage toward average quality, in minutes-weighted match equivalents. */
  shrinkMatches: 6,
  /** Fraction of last season's quality weight carried in, and its cap. */
  priorCarry: 0.5,
  priorMaxWeight: 15,
  /** Role: carried prior weight (matches) for players with/without last-season data. */
  priorRoleMaxWeight: 8,
  unknownPriorRole: 0.5,
  unknownPriorRoleWeight: 4,
  roleFloor: 0.6,
  roleSpan: 0.8,
  /** Immediate reaction to a single match's z-score. */
  beta: 0.035,
  /** Mean reversion toward fundamental value per priced match. */
  gamma: 0.12,
  /** Maximum move per match (±), applied to both live and settled steps. */
  maxStep: 0.08,
  /** Recent-form EWMA half-life, in matches played. */
  formHalfLifeMatches: 4,
  formMix: 0.3,
  minPriceCents: 50_00,
  maxPriceCents: 15_000_00,
} as const;

export type PricingConfig = typeof PRICING;

export interface PlayerMarketState {
  position: Position;
  priceCents: number;
  priorQuality: number;
  priorWeight: number;
  qualitySum: number;
  qualityWeight: number;
  formIndex: number;
  priorRole: number;
  priorRoleWeight: number;
  roleSum: number;
  roleMatches: number;
  matchesPriced: number;
}

/** Minutes weighting: a full match is full signal, a cameo much less. */
export function minutesWeight(minutes: number): number {
  if (minutes <= 0) return 0;
  return Math.sqrt(Math.min(minutes, 90) / 90);
}

export function qualityIndex(
  s: Pick<PlayerMarketState, "priorQuality" | "priorWeight" | "qualitySum" | "qualityWeight">,
  cfg: PricingConfig = PRICING,
): number {
  const num = s.priorQuality * s.priorWeight + s.qualitySum;
  const den = s.priorWeight + s.qualityWeight + cfg.shrinkMatches;
  return den > 0 ? num / den : 0;
}

export function roleShare(s: Pick<PlayerMarketState, "priorRole" | "priorRoleWeight" | "roleSum" | "roleMatches">): number {
  const den = s.priorRoleWeight + s.roleMatches;
  if (den <= 0) return 0.5;
  return Math.max(0, Math.min(1, (s.priorRole * s.priorRoleWeight + s.roleSum) / den));
}

export function clampPrice(cents: number, cfg: PricingConfig = PRICING): number {
  return Math.min(cfg.maxPriceCents, Math.max(cfg.minPriceCents, cents));
}

export function fundamentalCents(state: PlayerMarketState, cfg: PricingConfig = PRICING): number {
  const q = qualityIndex(state, cfg);
  const blend = (1 - cfg.formMix) * q + cfg.formMix * state.formIndex;
  const role = roleShare(state);
  const value = cfg.baseCredits[state.position] * 100 * Math.exp(cfg.kappa * blend) * (cfg.roleFloor + cfg.roleSpan * role);
  return clampPrice(Math.round(value), cfg);
}

export interface PriorInput {
  /** Last season's minutes-weighted mean z (raw, unshrunk). */
  quality: number;
  /** Last season's Σ m. */
  weight: number;
  /** Last season's share of minutes (Σ m / team matches registered). */
  role: number;
  /** Team matches the player was registered for last season. */
  roleMatches: number;
}

export function ipoState(position: Position, prior: PriorInput | null, cfg: PricingConfig = PRICING): PlayerMarketState {
  const s: PlayerMarketState = {
    position,
    priceCents: 0,
    priorQuality: prior && Number.isFinite(prior.quality) ? prior.quality : 0,
    priorWeight: prior ? Math.min(cfg.priorMaxWeight, Math.max(0, prior.weight * cfg.priorCarry)) : 0,
    qualitySum: 0,
    qualityWeight: 0,
    formIndex: 0,
    priorRole: prior ? Math.max(0, Math.min(1, prior.role)) : cfg.unknownPriorRole,
    priorRoleWeight: prior ? Math.min(cfg.priorRoleMaxWeight, prior.roleMatches * 0.25) : cfg.unknownPriorRoleWeight,
    roleSum: 0,
    roleMatches: 0,
    matchesPriced: 0,
  };
  s.priceCents = fundamentalCents(s, cfg);
  return s;
}

export interface StepResult {
  state: PlayerMarketState;
  /** Applied return after the cap, e.g. 0.031 = +3.1%. */
  ret: number;
  uncappedRet: number;
  fundamentalCents: number;
  quality: number;
  played: boolean;
}

/**
 * Apply one finished (or in-play, for provisional pricing) team match to a
 * player's state. Input state is not mutated. minutes = 0 → no price step.
 */
export function applyMatch(state: PlayerMarketState, z: number, minutes: number, cfg: PricingConfig = PRICING): StepResult {
  const m = minutesWeight(minutes);
  if (m === 0) {
    const next = { ...state, roleMatches: state.roleMatches + 1 };
    return { state: next, ret: 0, uncappedRet: 0, fundamentalCents: fundamentalCents(next, cfg), quality: qualityIndex(next, cfg), played: false };
  }
  const lambda = 1 - Math.pow(0.5, 1 / cfg.formHalfLifeMatches);
  const next: PlayerMarketState = {
    ...state,
    qualitySum: state.qualitySum + z * m,
    qualityWeight: state.qualityWeight + m,
    formIndex: state.formIndex * (1 - lambda) + z * m * lambda,
    roleSum: state.roleSum + m,
    roleMatches: state.roleMatches + 1,
    matchesPriced: state.matchesPriced + 1,
  };
  const f = fundamentalCents(next, cfg);
  const uncapped = cfg.beta * z * m + cfg.gamma * Math.log(f / state.priceCents);
  const ret = Math.max(-cfg.maxStep, Math.min(cfg.maxStep, uncapped));
  next.priceCents = clampPrice(Math.round(state.priceCents * (1 + ret)), cfg);
  return { state: next, ret, uncappedRet: uncapped, fundamentalCents: f, quality: qualityIndex(next, cfg), played: true };
}

/** Provisional in-play price: settled base + the step implied by current live stats. */
export function livePrice(settled: PlayerMarketState, liveZ: number, liveMinutes: number, cfg: PricingConfig = PRICING): number {
  if (liveMinutes <= 0) return settled.priceCents;
  return applyMatch(settled, liveZ, liveMinutes, cfg).state.priceCents;
}

/** Replay a full price path from IPO over a sequence of (z, minutes) team matches. */
export function replay(initial: PlayerMarketState, matches: { z: number; minutes: number }[], cfg: PricingConfig = PRICING) {
  const path: number[] = [initial.priceCents];
  let s = initial;
  for (const mt of matches) {
    s = applyMatch(s, mt.z, mt.minutes, cfg).state;
    path.push(s.priceCents);
  }
  return { final: s, path };
}
