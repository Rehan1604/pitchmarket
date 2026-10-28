/**
 * Integer money arithmetic. All amounts are integer "cents" of Pitch Credits
 * (100 cents = 1 PC). Every helper asserts it stays within JS's safe-integer
 * range, so arithmetic is exact — there is no floating-point balance math.
 */

export const CENTS_PER_CREDIT = 100;

export class MoneyError extends Error {}

export function assertSafeCents(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of cents (got ${value})`);
  }
  return value;
}

export function creditsToCents(credits: number): number {
  const cents = Math.round(credits * CENTS_PER_CREDIT);
  return assertSafeCents(cents, "credits");
}

export function addCents(...values: number[]): number {
  let total = 0;
  for (const v of values) {
    assertSafeCents(v);
    total += v;
  }
  return assertSafeCents(total, "sum");
}

export function mulCents(cents: number, quantity: number): number {
  assertSafeCents(cents);
  if (!Number.isSafeInteger(quantity)) throw new MoneyError("quantity must be an integer");
  return assertSafeCents(cents * quantity, "product");
}

/**
 * Integer division with round-half-up (away from zero for positives).
 * Used for proportional cost-basis release and basis-point fees.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  assertSafeCents(numerator, "numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new MoneyError("denominator must be a positive integer");
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const q = Math.floor(abs / denominator);
  const r = abs - q * denominator;
  return sign * (r * 2 >= denominator ? q + 1 : q);
}

/** fee = gross × bps / 10_000, rounded half up. */
export function feeForGross(grossCents: number, feeBps: number): number {
  if (feeBps <= 0) return 0;
  // Split to keep intermediates small: gross*bps can exceed 2^53 for huge orders.
  const whole = Math.floor(grossCents / 10_000) * feeBps;
  const rest = divRoundHalfUp((grossCents % 10_000) * feeBps, 10_000);
  return assertSafeCents(whole + rest, "fee");
}

/** Proportional cost basis released when selling `sellQty` of `heldQty`. Exact when selling all. */
export function releasedBasis(costBasisCents: number, sellQty: number, heldQty: number): number {
  if (sellQty <= 0 || heldQty <= 0 || sellQty > heldQty) throw new MoneyError("invalid quantities for basis release");
  if (sellQty === heldQty) return costBasisCents;
  // costBasis × sellQty can overflow for extreme values; use BigInt for the intermediate.
  const n = BigInt(costBasisCents) * BigInt(sellQty);
  const d = BigInt(heldQty);
  const q = n / d;
  const r = n % d;
  const result = r * BigInt(2) >= d ? q + BigInt(1) : q;
  return assertSafeCents(Number(result), "released basis");
}

/** Basis points of change from `from` to `to` (integer, rounded). */
export function changeBps(from: number, to: number): number {
  if (from === 0) return 0;
  return Math.round(((to - from) / from) * 10_000);
}

const nf0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "12,345.67" */
export function formatCredits(cents: number, opts: { decimals?: 0 | 2; sign?: boolean } = {}): string {
  const decimals = opts.decimals ?? 2;
  const value = cents / CENTS_PER_CREDIT;
  const body = (decimals === 0 ? nf0 : nf2).format(Math.abs(value));
  const sign = value < 0 ? "−" : opts.sign && value > 0 ? "+" : "";
  return `${sign}${body}`;
}

/** Compact: 1.2k, 3.4M */
export function formatCompactCredits(cents: number): string {
  const v = cents / CENTS_PER_CREDIT;
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${nf0.format(abs)}`;
}

export function formatPct(bps: number, opts: { sign?: boolean } = { sign: true }): string {
  const v = bps / 100;
  const body = Math.abs(v).toFixed(2);
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return `${sign}${body}%`;
}
