/**
 * ESPN competitions: fixtures and squads for La Liga, Bundesliga, Serie A,
 * Ligue 1 (league squads) and the Champions League.
 *
 * Champions League squads are handled per club:
 *   - a club already listed through an ESPN league → nothing to add (same ESPN ids);
 *   - a Premier League club → ESPN athletes are linked to the FPL-listed players
 *     (club recognised by squad birthdays, players by birthday + name);
 *   - any other club (Benfica, PSV, Galatasaray…) → its squad is listed under
 *     the Champions League and trades like everyone else.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { log } from "@/server/log";
import { linkSquad, matchClubBySquad, type PersonLike } from "./linking";
import { applyReferenceBundle, syncFixtures, syncReference, withRun } from "./pipeline";
import { ESPN_ENTITY, normaliseEspnAthlete, type EspnAthlete, type EspnProvider } from "./providers/espn";
import { FPL_ENTITY } from "./providers/fpl";
import type { NormPlayer } from "./providers/types";

export async function syncEspnFixtures(providers: EspnProvider[], window: "full" | "recent", trigger: string) {
  let worst = "success";
  for (const p of providers) {
    const r = await withRun(`fixtures:${p.code}`, ESPN_ENTITY, trigger, () => syncFixtures(p, { window }));
    if (r.status === "failed") worst = "partial";
  }
  return { status: worst };
}

export async function syncEspnReference(providers: EspnProvider[], trigger: string) {
  let worst = "success";
  const leagues = providers.filter((p) => !p.isCup);
  const cups = providers.filter((p) => p.isCup);
  for (const p of leagues) {
    const r = await withRun(`reference:${p.code}`, ESPN_ENTITY, trigger, () => syncReference(p));
    if (r.status === "failed") worst = "partial";
  }
  for (const cup of cups) {
    const r = await withRun(`reference:${cup.code}`, ESPN_ENTITY, trigger, () => syncCupReference(cup, leagues.map((l) => l.code)));
    if (r.status === "failed") worst = "partial";
  }
  return { status: worst };
}

async function syncCupReference(cup: EspnProvider, leagueCodes: string[]) {
  const teams = await cup.fetchTeams();
  // Clubs already covered by an ESPN league squad sync (same ESPN team ids).
  const covered = new Set(
    leagueCodes.length
      ? (
          await db
            .select({ ref: schema.clubs.providerRef })
            .from(schema.clubs)
            .innerJoin(schema.competitions, eq(schema.competitions.id, schema.clubs.competitionId))
            .innerJoin(schema.players, eq(schema.players.clubId, schema.clubs.id))
            .where(and(eq(schema.clubs.provider, ESPN_ENTITY), inArray(schema.competitions.code, leagueCodes)))
            .groupBy(schema.clubs.providerRef)
        ).map((r) => r.ref)
      : [],
  );

  // FPL-listed squads, for recognising Premier League clubs.
  const fpl = await db
    .select({ id: schema.players.id, clubId: schema.players.clubId, firstName: schema.players.firstName, lastName: schema.players.lastName, displayName: schema.players.displayName, birthDate: schema.players.birthDate })
    .from(schema.players)
    .where(and(eq(schema.players.provider, FPL_ENTITY), eq(schema.players.isTradable, true)));
  const fplByClub = new Map<number, PersonLike[]>();
  for (const p of fpl) {
    if (!p.clubId) continue;
    fplByClub.set(p.clubId, [...(fplByClub.get(p.clubId) ?? []), { ref: String(p.id), firstName: p.firstName, lastName: p.lastName, displayName: p.displayName, birthDate: p.birthDate }]);
  }

  const players: NormPlayer[] = [];
  let linkedPlayers = 0;
  let unlinked = 0;
  const linkedClubs: string[] = [];
  for (const team of teams) {
    if (covered.has(team.providerRef)) continue;
    let athletes: EspnAthlete[];
    try {
      athletes = await cup.fetchRoster(team.providerRef);
    } catch (e) {
      log.warn("ESPN cup roster failed", { team: team.name, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const feed: PersonLike[] = athletes.map((a) => ({ ref: String(a.id), firstName: a.firstName ?? "", lastName: a.lastName ?? "", displayName: a.displayName ?? "", birthDate: a.dateOfBirth ? a.dateOfBirth.slice(0, 10) : null }));
    const plClub = fplByClub.size ? matchClubBySquad(feed, fplByClub) : null;
    if (plClub !== null) {
      const links = linkSquad(feed, fplByClub.get(plClub)!);
      await db
        .insert(schema.entityLinks)
        .values({ kind: "club", provider: ESPN_ENTITY, providerRef: team.providerRef, localId: plClub, method: "squad-birthdays" })
        .onConflictDoUpdate({ target: [schema.entityLinks.kind, schema.entityLinks.provider, schema.entityLinks.providerRef], set: { localId: plClub, method: "squad-birthdays" } });
      for (const [ref, l] of links) {
        await db
          .insert(schema.entityLinks)
          .values({ kind: "player", provider: ESPN_ENTITY, providerRef: ref, localId: Number(l.localRef), method: l.method })
          .onConflictDoUpdate({ target: [schema.entityLinks.kind, schema.entityLinks.provider, schema.entityLinks.providerRef], set: { localId: Number(l.localRef), method: l.method } });
      }
      linkedPlayers += links.size;
      unlinked += feed.length - links.size;
      linkedClubs.push(team.name);
      continue;
    }
    for (const a of athletes) {
      const n = normaliseEspnAthlete(a, team.providerRef);
      if (n) players.push(n);
    }
  }
  const competition = await cup.competition();
  const res = await applyReferenceBundle(cup, { competition, clubs: teams, players, dataAsOf: new Date() });
  return { ...res, details: { ...res.details, cupOnlyPlayers: players.length, linkedClubs, linkedPlayers, unlinked, coveredClubs: covered.size } };
}

/** How many ESPN athletes are linked to FPL players (admin diagnostics). */
export async function linkStats() {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.entityLinks).where(and(eq(schema.entityLinks.kind, "player"), eq(schema.entityLinks.provider, ESPN_ENTITY)));
  return row?.n ?? 0;
}
