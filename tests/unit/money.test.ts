import { describe, expect, it } from "vitest";
import {
  addCents,
  assertSafeCents,
  changeBps,
  creditsToCents,
  divRoundHalfUp,
  feeForGross,
  formatCompactCredits,
  formatCredits,
  formatPct,
  MoneyError,
  mulCents,
  releasedBasis,
} from "@/lib/money";

describe("integer money arithmetic", () => {
  it("converts credits to integer cents without float drift", () => {
    expect(creditsToCents(100_000)).toBe(10_000_000);
    expect(creditsToCents(0.1 + 0.2)).toBe(30);
    expect(creditsToCents(1234.565)).toBe(123457);
  });

  it("rejects unsafe or fractional cents", () => {
    expect(() => assertSafeCents(1.5)).toThrow(MoneyError);
    expect(() => assertSafeCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
    expect(() => mulCents(Number.MAX_SAFE_INTEGER, 2)).toThrow(MoneyError);
    expect(() => mulCents(100, 1.5)).toThrow(MoneyError);
  });

  it("adds and multiplies exactly", () => {
    expect(addCents(1, 2, 3)).toBe(6);
    expect(mulCents(123_456, 789)).toBe(97_406_784);
  });

  it("rounds half up in integer division", () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(4, 3)).toBe(1);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    expect(divRoundHalfUp(10, 4)).toBe(3);
    expect(() => divRoundHalfUp(1, 0)).toThrow(MoneyError);
  });

  it("computes basis-point fees exactly, including for large orders", () => {
    expect(feeForGross(100_000, 0)).toBe(0);
    expect(feeForGross(100_000, 25)).toBe(250);
    expect(feeForGross(9_999, 25)).toBe(25); // 24.9975 → 25
    expect(feeForGross(10_001, 1)).toBe(1);
    const huge = 9_000_000_000_000;
    expect(feeForGross(huge, 500)).toBe(450_000_000_000);
  });

  it("releases proportional cost basis and is exact when closing a position", () => {
    expect(releasedBasis(10_000, 1, 3)).toBe(3_333);
    expect(releasedBasis(10_000, 2, 3)).toBe(6_667);
    expect(releasedBasis(10_001, 3, 3)).toBe(10_001);
    expect(() => releasedBasis(100, 4, 3)).toThrow(MoneyError);
    // Sum of partial releases + remainder equals the original basis.
    const basis = 123_457;
    const first = releasedBasis(basis, 7, 13);
    const second = releasedBasis(basis - first, 6, 6);
    expect(first + second).toBe(basis);
  });

  it("formats credits, compact values and percentages", () => {
    expect(formatCredits(123_456)).toBe("1,234.56");
    expect(formatCredits(-50, { sign: true })).toBe("−0.50");
    expect(formatCredits(5000, { sign: true, decimals: 0 })).toBe("+50");
    expect(formatCompactCredits(12_345_600)).toBe("123.5k");
    expect(formatCompactCredits(250_000_000)).toBe("2.50M");
    expect(formatPct(1234)).toBe("+12.34%");
    expect(formatPct(-5)).toBe("−0.05%");
    expect(changeBps(10_000, 11_000)).toBe(1000);
    expect(changeBps(0, 5)).toBe(0);
  });
});

import { initials, slugify } from "@/lib/text";

describe("text helpers", () => {
  it("builds initials from words that start with a letter or digit", () => {
    expect(initials("Erling Haaland")).toBe("EH");
    expect(initials("The Gaffer (demo)")).toBe("TG");
    expect(initials("Bruno")).toBe("BR");
    expect(initials("  ")).toBe("?");
  });
  it("slugifies accented names", () => {
    expect(slugify("Martin Ødegaard")).toBe("martin-odegaard");
    expect(slugify("Joško Gvardiol")).toBe("josko-gvardiol");
  });
});
