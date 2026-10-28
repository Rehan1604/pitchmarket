/**
 * Cross-feed identity matching (pure, unit-tested).
 *
 * When a Premier League club plays in the Champions League, ESPN reports the
 * match with ESPN athlete ids while the player's market identity comes from FPL.
 * We link them by club + date of birth (unique within a squad except twins),
 * then by name. Anything ambiguous stays unlinked — an unlinked player's
 * Champions League match is simply not priced, which is safer than a wrong link.
 */

export interface PersonLike {
  ref: string;
  firstName: string;
  lastName: string;
  displayName: string;
  birthDate: string | null;
}

export function normName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/[đð]/gi, "d")
    .replace(/ł/gi, "l")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

function tokens(p: PersonLike): Set<string> {
  return new Set(
    [p.firstName, p.lastName, p.displayName]
      .flatMap((x) => normName(x).split(" "))
      .filter((t) => t.length >= 2),
  );
}

function nameScore(a: PersonLike, b: PersonLike): number {
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared;
}

const dob = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/**
 * Link `feed` people to `local` people of the same club. Returns feed ref →
 * local ref with the method used. One-to-one: a local person claimed twice is
 * dropped from both claims.
 */
export function linkSquad(feed: PersonLike[], local: PersonLike[]): Map<string, { localRef: string; method: string }> {
  const byDob = new Map<string, PersonLike[]>();
  for (const l of local) {
    const d = dob(l.birthDate);
    if (d) byDob.set(d, [...(byDob.get(d) ?? []), l]);
  }
  const claims = new Map<string, { localRef: string; method: string }>();
  for (const f of feed) {
    const d = dob(f.birthDate);
    const sameDob = d ? (byDob.get(d) ?? []) : [];
    if (sameDob.length === 1 && nameScore(f, sameDob[0]) >= 1) {
      claims.set(f.ref, { localRef: sameDob[0].ref, method: "dob+name" });
      continue;
    }
    if (sameDob.length === 1 && !nameDisagrees(f, sameDob[0])) {
      claims.set(f.ref, { localRef: sameDob[0].ref, method: "dob" });
      continue;
    }
    if (sameDob.length > 1) {
      const best = pickUniqueBest(f, sameDob);
      if (best) claims.set(f.ref, { localRef: best.ref, method: "dob+name" });
      continue;
    }
    // No usable date of birth: names only, and only with two shared name tokens
    // (or one when either side is a mononym like "Pedri").
    const candidates = local.filter((l) => !dob(l.birthDate) || !d);
    const best = pickUniqueBest(f, candidates, mononym(f) ? 1 : 2);
    if (best) claims.set(f.ref, { localRef: best.ref, method: "name" });
  }
  // Enforce one-to-one.
  const count = new Map<string, number>();
  for (const c of claims.values()) count.set(c.localRef, (count.get(c.localRef) ?? 0) + 1);
  for (const [k, c] of claims) if ((count.get(c.localRef) ?? 0) > 1) claims.delete(k);
  return claims;
}

function mononym(p: PersonLike) {
  return normName(p.displayName).split(" ").filter(Boolean).length === 1;
}

/** Same birthday but clearly different people (e.g. no shared name token and different initials). */
function nameDisagrees(a: PersonLike, b: PersonLike) {
  const ia = normName(a.firstName || a.displayName).charAt(0);
  const ib = normName(b.firstName || b.displayName).charAt(0);
  return ia !== "" && ib !== "" && ia !== ib;
}

function pickUniqueBest(f: PersonLike, candidates: PersonLike[], minScore = 1): PersonLike | null {
  let best: PersonLike | null = null;
  let bestScore = 0;
  let tie = false;
  for (const c of candidates) {
    const s = nameScore(f, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
      tie = false;
    } else if (s === bestScore && s > 0) tie = true;
  }
  return best && !tie && bestScore >= minScore ? best : null;
}

/**
 * Which local club (if any) is this feed squad? Decided by how many players
 * share a date of birth — names of clubs differ between feeds ("Man City" vs
 * "Manchester City"), birthdays don't.
 */
export function matchClubBySquad<K>(feed: PersonLike[], localByClub: Map<K, PersonLike[]>): K | null {
  const feedDobs = new Set(feed.map((f) => dob(f.birthDate)).filter((d): d is string => d !== null));
  if (feedDobs.size === 0) return null;
  let best: K | null = null;
  let bestN = 0;
  let second = 0;
  for (const [club, players] of localByClub) {
    const n = players.filter((p) => {
      const d = dob(p.birthDate);
      return d !== null && feedDobs.has(d);
    }).length;
    if (n > bestN) {
      second = bestN;
      bestN = n;
      best = club;
    } else if (n > second) second = n;
  }
  const needed = Math.max(6, Math.ceil(feedDobs.size * 0.4));
  return bestN >= needed && bestN >= second * 2 ? best : null;
}
