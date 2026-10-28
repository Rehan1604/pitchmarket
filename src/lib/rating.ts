/**
 * Player-facing 0–99 ratings derived from the engine's indices (z-score units).
 * 50 = exactly average for the position; each 0.1 of index ≈ 2.5 rating points.
 */
export function rating(index: number): number {
  return Math.round(Math.max(1, Math.min(99, 50 + 25 * index)));
}

export function ratingTone(r: number): "gain" | "loss" | "neutral" {
  if (r >= 58) return "gain";
  if (r <= 42) return "loss";
  return "neutral";
}
