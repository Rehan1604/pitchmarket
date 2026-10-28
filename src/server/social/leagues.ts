/**
 * Private leagues. Every read and write is authorised on the server:
 *  - private leagues are invisible to non-members (404, not 403, to avoid leaking existence)
 *  - invite codes are 10 characters from a 32-symbol alphabet (~1.1×10^15 combinations),
 *    revocable, optionally expiring / capped / bound to one invited friend
 *  - membership changes are transactional and capped at the league's max size
 */
import { randomInt } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db";
import { audit } from "@/server/audit";
import { env } from "@/server/env";
import { conflict, forbidden, HttpError, notFound } from "@/server/http";
import { areFriends } from "./friends";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function generateInviteCode(length = 10): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function normaliseCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const leagueSettingsSchema = z.object({
  name: z.string().trim().min(3, "Use at least 3 characters.").max(40),
  description: z.string().trim().max(240).optional().nullable(),
  visibility: z.enum(["private", "public"]).default("private"),
  maxMembers: z.number().int().min(2).max(500).default(50),
  membersCanInvite: z.boolean().default(true),
});

type Role = "owner" | "admin" | "member";

export async function membership(leagueId: string, userId: string): Promise<Role | null> {
  const [m] = await db
    .select({ role: schema.leagueMembers.role })
    .from(schema.leagueMembers)
    .where(and(eq(schema.leagueMembers.leagueId, leagueId), eq(schema.leagueMembers.userId, userId)));
  return m?.role ?? null;
}

async function loadLeague(leagueId: string) {
  if (!z.uuid().safeParse(leagueId).success) return null;
  const [l] = await db.select().from(schema.leagues).where(and(eq(schema.leagues.id, leagueId), isNull(schema.leagues.archivedAt)));
  return l ?? null;
}

/** Load a league the viewer may see: members always; anyone for public leagues. */
export async function getLeagueForViewer(leagueId: string, viewerId: string) {
  const league = await loadLeague(leagueId);
  if (!league) throw notFound("League not found.");
  const role = await membership(leagueId, viewerId);
  if (!role && league.visibility !== "public") throw notFound("League not found.");
  const [{ members }] = await db
    .select({ members: sql<number>`count(*)::int` })
    .from(schema.leagueMembers)
    .where(eq(schema.leagueMembers.leagueId, leagueId));
  return { league, role, members };
}

async function requireRole(leagueId: string, userId: string, allowed: Role[]) {
  const league = await loadLeague(leagueId);
  if (!league) throw notFound("League not found.");
  const role = await membership(leagueId, userId);
  if (!role) throw notFound("League not found.");
  if (!allowed.includes(role)) throw forbidden("You don't have permission to do that in this league.");
  return { league, role };
}

async function insertInvite(tx: Tx, leagueId: string, createdBy: string, opts: { maxUses?: number | null; expiresAt?: Date | null; invitedUserId?: string | null } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const res = await tx
      .insert(schema.leagueInvites)
      .values({ leagueId, code, createdBy, maxUses: opts.maxUses ?? null, expiresAt: opts.expiresAt ?? null, invitedUserId: opts.invitedUserId ?? null })
      .onConflictDoNothing()
      .returning();
    if (res[0]) return res[0];
  }
  throw new Error("Could not allocate a unique invite code");
}

export function inviteUrl(code: string) {
  return `${env().APP_URL}/join/${code}`;
}

export async function createLeague(ownerId: string, input: z.infer<typeof leagueSettingsSchema>) {
  const settings = leagueSettingsSchema.parse(input);
  return db.transaction(async (tx) => {
    const [league] = await tx
      .insert(schema.leagues)
      .values({ name: settings.name, description: settings.description ?? null, visibility: settings.visibility, maxMembers: settings.maxMembers, membersCanInvite: settings.membersCanInvite, ownerId })
      .returning();
    await tx.insert(schema.leagueMembers).values({ leagueId: league.id, userId: ownerId, role: "owner" });
    const invite = await insertInvite(tx, league.id, ownerId);
    await tx.insert(schema.activityEvents).values({ userId: ownerId, kind: "league_create", payload: { leagueId: league.id, leagueName: league.name } });
    await audit({ userId: ownerId, actor: "user", action: "league.created", entityType: "league", entityId: league.id }, tx);
    return { league, invite };
  });
}

export async function updateLeague(userId: string, leagueId: string, input: Partial<z.infer<typeof leagueSettingsSchema>>) {
  const { role, league } = await requireRole(leagueId, userId, ["owner", "admin"]);
  const patch = leagueSettingsSchema.partial().parse(input);
  if (patch.visibility !== undefined && patch.visibility !== league.visibility && role !== "owner") throw forbidden("Only the owner can change who can find the league.");
  if (patch.maxMembers !== undefined) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.leagueMembers).where(eq(schema.leagueMembers.leagueId, leagueId));
    if (patch.maxMembers < n) throw new HttpError(400, "MAX_TOO_SMALL", `The league already has ${n} members.`);
  }
  const [l] = await db.update(schema.leagues).set(patch).where(eq(schema.leagues.id, leagueId)).returning();
  await audit({ userId, actor: "user", action: "league.updated", entityType: "league", entityId: leagueId, metadata: patch });
  return l;
}

export async function archiveLeague(userId: string, leagueId: string) {
  await requireRole(leagueId, userId, ["owner"]);
  await db.update(schema.leagues).set({ archivedAt: new Date() }).where(eq(schema.leagues.id, leagueId));
  await db.update(schema.leagueInvites).set({ revokedAt: new Date() }).where(and(eq(schema.leagueInvites.leagueId, leagueId), isNull(schema.leagueInvites.revokedAt)));
  await audit({ userId, actor: "user", action: "league.archived", entityType: "league", entityId: leagueId });
}

export async function createInvite(userId: string, leagueId: string, opts: { maxUses?: number | null; expiresInDays?: number | null; invitedUsername?: string | null } = {}) {
  const { league, role } = await requireRole(leagueId, userId, ["owner", "admin", "member"]);
  if (role === "member" && !league.membersCanInvite) throw forbidden("Only the league owner and admins can invite people.");
  let invitedUserId: string | null = null;
  if (opts.invitedUsername) {
    const [u] = await db
      .select({ id: schema.users.id, notifySocial: schema.users.notifySocial })
      .from(schema.users)
      .where(and(sql`lower(${schema.users.username}) = ${opts.invitedUsername.toLowerCase()}`, isNull(schema.users.deletedAt)));
    if (!u) throw notFound("No manager with that username.");
    if (!(await areFriends(userId, u.id))) throw forbidden("You can only send direct league invites to friends.");
    if (await membership(leagueId, u.id)) throw conflict("ALREADY_MEMBER", "They're already in this league.");
    invitedUserId = u.id;
  }
  const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86400_000) : null;
  const invite = await db.transaction(async (tx) => {
    const inv = await insertInvite(tx, leagueId, userId, { maxUses: invitedUserId ? 1 : (opts.maxUses ?? null), expiresAt, invitedUserId });
    if (invitedUserId) {
      const [me] = await tx.select({ displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId));
      await tx.insert(schema.notifications).values({
        userId: invitedUserId,
        kind: "league_invite",
        title: `${me.displayName} invited you to ${league.name}`,
        body: "Join to see the standings and compete for the top spot.",
        link: `/join/${inv.code}`,
      });
    }
    return inv;
  });
  await audit({ userId, actor: "user", action: "league.invite_created", entityType: "league", entityId: leagueId, metadata: { inviteId: invite.id, direct: Boolean(invitedUserId) } });
  return { ...invite, url: inviteUrl(invite.code) };
}

export async function revokeInvite(userId: string, inviteId: string) {
  if (!z.uuid().safeParse(inviteId).success) throw notFound("Invite not found.");
  const [inv] = await db.select().from(schema.leagueInvites).where(eq(schema.leagueInvites.id, inviteId));
  if (!inv) throw notFound("Invite not found.");
  const role = await membership(inv.leagueId, userId);
  if (!role) throw notFound("Invite not found.");
  if (role === "member" && inv.createdBy !== userId) throw forbidden("You can only revoke invites you created.");
  await db.update(schema.leagueInvites).set({ revokedAt: new Date() }).where(eq(schema.leagueInvites.id, inviteId));
  await audit({ userId, actor: "user", action: "league.invite_revoked", entityType: "league", entityId: inv.leagueId, metadata: { inviteId } });
}

export async function listInvites(userId: string, leagueId: string) {
  const { role } = await requireRole(leagueId, userId, ["owner", "admin", "member"]);
  const rows = await db
    .select({
      id: schema.leagueInvites.id,
      code: schema.leagueInvites.code,
      uses: schema.leagueInvites.uses,
      maxUses: schema.leagueInvites.maxUses,
      expiresAt: schema.leagueInvites.expiresAt,
      revokedAt: schema.leagueInvites.revokedAt,
      createdAt: schema.leagueInvites.createdAt,
      createdBy: schema.leagueInvites.createdBy,
      invitedUsername: schema.users.username,
    })
    .from(schema.leagueInvites)
    .leftJoin(schema.users, eq(schema.users.id, schema.leagueInvites.invitedUserId))
    .where(and(eq(schema.leagueInvites.leagueId, leagueId), isNull(schema.leagueInvites.revokedAt)))
    .orderBy(desc(schema.leagueInvites.createdAt));
  const now = Date.now();
  return rows
    .filter((r) => role !== "member" || r.createdBy === userId || !r.invitedUsername)
    .map((r) => ({ ...r, url: inviteUrl(r.code), active: (!r.expiresAt || r.expiresAt.getTime() > now) && (r.maxUses === null || r.uses < r.maxUses) }));
}

/** Preview an invite before joining (league name + member count only). */
export async function previewInvite(code: string, viewerId: string | null) {
  const c = normaliseCode(code);
  if (c.length < 6 || c.length > 16) throw notFound("This invite link isn't valid.");
  const [row] = await db
    .select({ invite: schema.leagueInvites, league: schema.leagues })
    .from(schema.leagueInvites)
    .innerJoin(schema.leagues, eq(schema.leagues.id, schema.leagueInvites.leagueId))
    .where(eq(schema.leagueInvites.code, c));
  if (!row || row.invite.revokedAt || row.league.archivedAt) throw notFound("This invite link isn't valid any more.");
  const expired = row.invite.expiresAt !== null && row.invite.expiresAt.getTime() < Date.now();
  const exhausted = row.invite.maxUses !== null && row.invite.uses >= row.invite.maxUses;
  const wrongUser = row.invite.invitedUserId !== null && viewerId !== null && row.invite.invitedUserId !== viewerId;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.leagueMembers).where(eq(schema.leagueMembers.leagueId, row.league.id));
  const [owner] = await db.select({ displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, row.league.ownerId));
  return {
    code: c,
    leagueId: row.league.id,
    name: row.league.name,
    description: row.league.description,
    ownerName: owner?.displayName ?? "A manager",
    members: n,
    maxMembers: row.league.maxMembers,
    alreadyMember: viewerId ? Boolean(await membership(row.league.id, viewerId)) : false,
    usable: !expired && !exhausted && !wrongUser && n < row.league.maxMembers,
    reason: expired ? "This invite has expired." : exhausted ? "This invite has been used up." : wrongUser ? "This invite was sent to someone else." : n >= row.league.maxMembers ? "This league is full." : null,
  };
}

export async function joinByCode(userId: string, code: string) {
  const c = normaliseCode(code);
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string; league_id: string; max_uses: number | null; uses: number; expires_at: Date | null; revoked_at: Date | null; invited_user_id: string | null }>(
      sql`SELECT id, league_id, max_uses, uses, expires_at, revoked_at, invited_user_id FROM league_invites WHERE code = ${c} FOR UPDATE`,
    );
    const inv = res.rows[0];
    if (!inv || inv.revoked_at) throw notFound("This invite link isn't valid any more.");
    if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) throw new HttpError(410, "INVITE_EXPIRED", "This invite has expired.");
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) throw new HttpError(410, "INVITE_EXHAUSTED", "This invite has been used up.");
    if (inv.invited_user_id && inv.invited_user_id !== userId) throw forbidden("This invite was sent to someone else.");
    return addMember(tx, inv.league_id, userId, inv.id);
  });
}

export async function joinPublicLeague(userId: string, leagueId: string) {
  const league = await loadLeague(leagueId);
  if (!league || league.visibility !== "public") throw notFound("League not found.");
  return db.transaction((tx) => addMember(tx, leagueId, userId, null));
}

async function addMember(tx: Tx, leagueId: string, userId: string, inviteId: string | null) {
  const lres = await tx.execute<{ id: string; name: string; max_members: number; owner_id: string; archived_at: Date | null }>(
    sql`SELECT id, name, max_members, owner_id, archived_at FROM leagues WHERE id = ${leagueId}::uuid FOR UPDATE`,
  );
  const league = lres.rows[0];
  if (!league || league.archived_at) throw notFound("League not found.");
  const existing = await tx
    .select({ role: schema.leagueMembers.role })
    .from(schema.leagueMembers)
    .where(and(eq(schema.leagueMembers.leagueId, leagueId), eq(schema.leagueMembers.userId, userId)));
  if (existing[0]) throw conflict("ALREADY_MEMBER", "You're already in this league.");
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.leagueMembers).where(eq(schema.leagueMembers.leagueId, leagueId));
  if (n >= league.max_members) throw new HttpError(409, "LEAGUE_FULL", "This league is full.");
  await tx.insert(schema.leagueMembers).values({ leagueId, userId, role: "member" });
  if (inviteId) await tx.update(schema.leagueInvites).set({ uses: sql`${schema.leagueInvites.uses} + 1` }).where(eq(schema.leagueInvites.id, inviteId));
  const [me] = await tx.select({ displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId));
  const [owner] = await tx.select({ notifySocial: schema.users.notifySocial }).from(schema.users).where(eq(schema.users.id, league.owner_id));
  if (owner?.notifySocial && league.owner_id !== userId) {
    await tx.insert(schema.notifications).values({ userId: league.owner_id, kind: "league_join", title: `${me.displayName} joined ${league.name}`, link: `/leagues/${leagueId}` });
  }
  await tx.insert(schema.activityEvents).values({ userId, kind: "league_join", payload: { leagueId, leagueName: league.name } });
  await audit({ userId, actor: "user", action: "league.joined", entityType: "league", entityId: leagueId, metadata: { inviteId } }, tx);
  return { leagueId, name: league.name };
}

export async function leaveLeague(userId: string, leagueId: string) {
  const { role } = await requireRole(leagueId, userId, ["owner", "admin", "member"]);
  if (role === "owner") {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.leagueMembers).where(eq(schema.leagueMembers.leagueId, leagueId));
    if (n > 1) throw conflict("OWNER_MUST_TRANSFER", "Transfer ownership to another member before leaving, or archive the league.");
    await archiveLeague(userId, leagueId);
  }
  await db.delete(schema.leagueMembers).where(and(eq(schema.leagueMembers.leagueId, leagueId), eq(schema.leagueMembers.userId, userId)));
  await audit({ userId, actor: "user", action: "league.left", entityType: "league", entityId: leagueId });
}

export async function removeMember(actorId: string, leagueId: string, targetUserId: string) {
  const { role } = await requireRole(leagueId, actorId, ["owner", "admin"]);
  const targetRole = await membership(leagueId, targetUserId);
  if (!targetRole) throw notFound("That manager isn't in this league.");
  if (targetRole === "owner") throw forbidden("The owner can't be removed.");
  if (role === "admin" && targetRole === "admin") throw forbidden("Admins can't remove other admins.");
  await db.delete(schema.leagueMembers).where(and(eq(schema.leagueMembers.leagueId, leagueId), eq(schema.leagueMembers.userId, targetUserId)));
  await audit({ userId: actorId, actor: "user", action: "league.member_removed", entityType: "league", entityId: leagueId, metadata: { targetUserId } });
}

export async function setMemberRole(actorId: string, leagueId: string, targetUserId: string, newRole: "admin" | "member") {
  await requireRole(leagueId, actorId, ["owner"]);
  const targetRole = await membership(leagueId, targetUserId);
  if (!targetRole) throw notFound("That manager isn't in this league.");
  if (targetRole === "owner") throw forbidden("Use transfer ownership instead.");
  await db.update(schema.leagueMembers).set({ role: newRole }).where(and(eq(schema.leagueMembers.leagueId, leagueId), eq(schema.leagueMembers.userId, targetUserId)));
  await audit({ userId: actorId, actor: "user", action: "league.role_changed", entityType: "league", entityId: leagueId, metadata: { targetUserId, newRole } });
}

export async function transferOwnership(actorId: string, leagueId: string, targetUserId: string) {
  await requireRole(leagueId, actorId, ["owner"]);
  const targetRole = await membership(leagueId, targetUserId);
  if (!targetRole || targetUserId === actorId) throw notFound("That manager isn't in this league.");
  await db.transaction(async (tx) => {
    await tx.update(schema.leagues).set({ ownerId: targetUserId }).where(eq(schema.leagues.id, leagueId));
    await tx.update(schema.leagueMembers).set({ role: "owner" }).where(and(eq(schema.leagueMembers.leagueId, leagueId), eq(schema.leagueMembers.userId, targetUserId)));
    await tx.update(schema.leagueMembers).set({ role: "admin" }).where(and(eq(schema.leagueMembers.leagueId, leagueId), eq(schema.leagueMembers.userId, actorId)));
    await audit({ userId: actorId, actor: "user", action: "league.ownership_transferred", entityType: "league", entityId: leagueId, metadata: { targetUserId } }, tx);
  });
}

export async function listMembers(viewerId: string, leagueId: string) {
  await getLeagueForViewer(leagueId, viewerId);
  return db
    .select({ userId: schema.users.id, username: schema.users.username, displayName: schema.users.displayName, avatarColor: schema.users.avatarColor, role: schema.leagueMembers.role, joinedAt: schema.leagueMembers.joinedAt, isDemo: schema.users.isDemo })
    .from(schema.leagueMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.leagueMembers.userId))
    .where(eq(schema.leagueMembers.leagueId, leagueId))
    .orderBy(sql`case ${schema.leagueMembers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(schema.leagueMembers.joinedAt));
}

export async function listMyLeagues(userId: string) {
  return db
    .select({
      id: schema.leagues.id,
      name: schema.leagues.name,
      description: schema.leagues.description,
      visibility: schema.leagues.visibility,
      role: schema.leagueMembers.role,
      members: sql<number>`(SELECT count(*)::int FROM league_members m WHERE m.league_id = ${schema.leagues.id})`,
    })
    .from(schema.leagueMembers)
    .innerJoin(schema.leagues, eq(schema.leagues.id, schema.leagueMembers.leagueId))
    .where(and(eq(schema.leagueMembers.userId, userId), isNull(schema.leagues.archivedAt)))
    .orderBy(asc(schema.leagues.name));
}

export async function listPublicLeagues(limit = 20) {
  return db
    .select({
      id: schema.leagues.id,
      name: schema.leagues.name,
      description: schema.leagues.description,
      members: sql<number>`(SELECT count(*)::int FROM league_members m WHERE m.league_id = ${schema.leagues.id})`,
      maxMembers: schema.leagues.maxMembers,
    })
    .from(schema.leagues)
    .where(and(eq(schema.leagues.visibility, "public"), isNull(schema.leagues.archivedAt)))
    .orderBy(desc(schema.leagues.createdAt))
    .limit(limit);
}
