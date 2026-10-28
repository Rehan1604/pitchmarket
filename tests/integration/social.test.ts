import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@/db";
import { getLeaderboard } from "@/server/leaderboard/service";
import { takeDailySnapshots } from "@/server/portfolio/snapshots";
import { cancelFriendRequest, areFriends, listFriendRequests, removeFriend, respondToFriendRequest, sendFriendRequest } from "@/server/social/friends";
import {
  createInvite,
  createLeague,
  getLeagueForViewer,
  joinByCode,
  leaveLeague,
  listMembers,
  previewInvite,
  removeMember,
  revokeInvite,
  setMemberRole,
  transferOwnership,
  updateLeague,
} from "@/server/social/leagues";
import { getProfile, friendsFeed } from "@/server/social/profiles";
import { executeTrade } from "@/server/trading/service";
import { anyPlayer, key, makeUser } from "./helpers";

afterAll(() => closeDb());

describe("friends", () => {
  it("sends, accepts and lists friend requests; only the recipient can respond", async () => {
    const a = await makeUser("fa");
    const b = await makeUser("fb");
    const c = await makeUser("fc");
    expect(await sendFriendRequest(a.id, b.username)).toEqual({ status: "sent" });
    await expect(sendFriendRequest(a.id, b.username)).rejects.toMatchObject({ code: "REQUEST_PENDING" });
    const { incoming } = await listFriendRequests(b.id);
    const req = incoming.find((r) => r.username === a.username)!;
    // IDOR: a third user (or the sender) cannot accept it.
    await expect(respondToFriendRequest(c.id, req.id, true)).rejects.toMatchObject({ status: 404 });
    await expect(respondToFriendRequest(a.id, req.id, true)).rejects.toMatchObject({ status: 404 });
    await respondToFriendRequest(b.id, req.id, true);
    expect(await areFriends(a.id, b.id)).toBe(true);
    await expect(sendFriendRequest(b.id, a.username)).rejects.toMatchObject({ code: "ALREADY_FRIENDS" });
    const [note] = await db.select().from(schema.notifications).where(sql`${schema.notifications.userId} = ${a.id} AND ${schema.notifications.kind} = 'friend_accepted'`);
    expect(note).toBeTruthy();
    await removeFriend(a.id, b.username);
    expect(await areFriends(a.id, b.id)).toBe(false);
  });

  it("auto-accepts a mirrored request, supports decline and cancel, and refuses self-requests", async () => {
    const a = await makeUser("ma");
    const b = await makeUser("mb");
    await sendFriendRequest(a.id, b.username);
    expect(await sendFriendRequest(b.id, a.username)).toEqual({ status: "accepted" });
    expect(await areFriends(a.id, b.id)).toBe(true);
    const c = await makeUser("mc");
    await sendFriendRequest(c.id, a.username);
    const reqId = (await listFriendRequests(a.id)).incoming.find((r) => r.username === c.username)!.id;
    await respondToFriendRequest(a.id, reqId, false);
    expect(await areFriends(a.id, c.id)).toBe(false);
    await sendFriendRequest(c.id, a.username);
    const again = (await listFriendRequests(c.id)).outgoing.find((r) => r.username === a.username)!.id;
    await cancelFriendRequest(c.id, again);
    await expect(sendFriendRequest(a.id, a.username)).rejects.toMatchObject({ code: "SELF_FRIEND" });
    await expect(sendFriendRequest(a.id, "no_such_manager")).rejects.toMatchObject({ status: 404 });
  });
});

describe("private leagues", () => {
  it("creates a league with an invite code; others join with the code", async () => {
    const owner = await makeUser("lo");
    const friend = await makeUser("lf");
    const { league, invite } = await createLeague(owner.id, { name: "Sunday League", visibility: "private", maxMembers: 3, membersCanInvite: false });
    expect(invite.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    const preview = await previewInvite(invite.code.toLowerCase(), friend.id);
    expect(preview).toMatchObject({ name: "Sunday League", members: 1, usable: true, alreadyMember: false });
    await joinByCode(friend.id, invite.code);
    await expect(joinByCode(friend.id, invite.code)).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
    const members = await listMembers(owner.id, league.id);
    expect(members.map((m) => m.role)).toEqual(["owner", "member"]);
    // Members can't invite when the owner disabled it.
    await expect(createInvite(friend.id, league.id)).rejects.toMatchObject({ status: 403 });
  });

  it("hides private leagues from non-members and enforces permissions", async () => {
    const owner = await makeUser("po");
    const outsider = await makeUser("px");
    const { league } = await createLeague(owner.id, { name: "Secret Six", visibility: "private", maxMembers: 10, membersCanInvite: true });
    await expect(getLeagueForViewer(league.id, outsider.id)).rejects.toMatchObject({ status: 404 });
    await expect(listMembers(outsider.id, league.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateLeague(outsider.id, league.id, { name: "Hijacked" })).rejects.toMatchObject({ status: 404 });
    await expect(getLeagueForViewer("not-a-uuid", outsider.id)).rejects.toMatchObject({ status: 404 });
  });

  it("enforces capacity, revocation, expiry and single-recipient invites", async () => {
    const owner = await makeUser("co");
    const [m1, m2, m3] = [await makeUser("c1"), await makeUser("c2"), await makeUser("c3")];
    const { league, invite } = await createLeague(owner.id, { name: "Tiny League", visibility: "private", maxMembers: 2, membersCanInvite: true });
    await joinByCode(m1.id, invite.code);
    await expect(joinByCode(m2.id, invite.code)).rejects.toMatchObject({ code: "LEAGUE_FULL" });
    await updateLeague(owner.id, league.id, { maxMembers: 10 });
    await revokeInvite(owner.id, invite.id);
    await expect(joinByCode(m2.id, invite.code)).rejects.toMatchObject({ status: 404 });
    const limited = await createInvite(owner.id, league.id, { maxUses: 1 });
    await joinByCode(m2.id, limited.code);
    await expect(joinByCode(m3.id, limited.code)).rejects.toMatchObject({ code: "INVITE_EXHAUSTED" });
    const expiring = await createInvite(owner.id, league.id, { expiresInDays: 1 });
    await db.update(schema.leagueInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.leagueInvites.id, expiring.id));
    await expect(joinByCode(m3.id, expiring.code)).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    // Direct invites go only to friends and only that friend can use them.
    await expect(createInvite(owner.id, league.id, { invitedUsername: m3.username })).rejects.toMatchObject({ status: 403 });
    await sendFriendRequest(owner.id, m3.username);
    const req = (await listFriendRequests(m3.id)).incoming[0];
    await respondToFriendRequest(m3.id, req.id, true);
    const direct = await createInvite(owner.id, league.id, { invitedUsername: m3.username });
    const stranger = await makeUser("c4");
    await expect(joinByCode(stranger.id, direct.code)).rejects.toMatchObject({ status: 403 });
    await joinByCode(m3.id, direct.code);
    const notes = await db.select().from(schema.notifications).where(sql`${schema.notifications.userId} = ${m3.id} AND ${schema.notifications.kind} = 'league_invite'`);
    expect(notes).toHaveLength(1);
  });

  it("manages roles, removal, ownership transfer and leaving", async () => {
    const owner = await makeUser("ro");
    const [a, b] = [await makeUser("ra"), await makeUser("rb")];
    const { league, invite } = await createLeague(owner.id, { name: "Role Play", visibility: "private", maxMembers: 10, membersCanInvite: true });
    await joinByCode(a.id, invite.code);
    await joinByCode(b.id, invite.code);
    await expect(setMemberRole(a.id, league.id, b.id, "admin")).rejects.toMatchObject({ status: 403 });
    await setMemberRole(owner.id, league.id, a.id, "admin");
    await expect(removeMember(a.id, league.id, owner.id)).rejects.toMatchObject({ status: 403 });
    await removeMember(a.id, league.id, b.id);
    await expect(leaveLeague(owner.id, league.id)).rejects.toMatchObject({ code: "OWNER_MUST_TRANSFER" });
    await transferOwnership(owner.id, league.id, a.id);
    await leaveLeague(owner.id, league.id);
    const members = await listMembers(a.id, league.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: a.id, role: "owner" });
  });
});

describe("leaderboards", () => {
  it("ranks global, friends and league boards from persisted portfolios with shared tie ranks", async () => {
    const a = await makeUser("la");
    const b = await makeUser("lb");
    const c = await makeUser("lc");
    const p = await anyPlayer();
    await executeTrade({ userId: a.id, playerId: p.id, side: "buy", quantity: 10, idempotencyKey: key() });
    // Lift the price so `a` is ahead of b and c, who are tied on their untouched starting balance.
    await db.update(schema.playerPrices).set({ priceCents: p.price + 1000 }).where(eq(schema.playerPrices.playerId, p.id));
    try {
      const { league, invite } = await createLeague(a.id, { name: "Board Test", visibility: "private", maxMembers: 10, membersCanInvite: true });
      await joinByCode(b.id, invite.code);
      await joinByCode(c.id, invite.code);
      const board = await getLeaderboard({ kind: "league", leagueId: league.id });
      expect(board.total).toBe(3);
      expect(board.rows[0]).toMatchObject({ userId: a.id, rank: 1, totalReturnCents: 10_000 });
      expect(board.rows[1].rank).toBe(2);
      expect(board.rows[2].rank).toBe(2); // tie shares rank
      expect(board.rows[1].username.toLowerCase() < board.rows[2].username.toLowerCase()).toBe(true); // deterministic order
      await sendFriendRequest(a.id, b.username);
      await respondToFriendRequest(b.id, (await listFriendRequests(b.id)).incoming[0].id, true);
      const friends = await getLeaderboard({ kind: "friends", userId: a.id });
      expect(friends.rows.map((r) => r.userId).sort()).toEqual([a.id, b.id].sort());
      const global = await getLeaderboard({ kind: "global" }, { limit: 100 });
      expect(global.rows.some((r) => r.userId === a.id)).toBe(true);
      // Opting out of the global board removes you from it but not from leagues.
      await db.update(schema.users).set({ showOnGlobalLeaderboard: false }).where(eq(schema.users.id, c.id));
      const global2 = await getLeaderboard({ kind: "global" }, { limit: 100 });
      expect(global2.rows.some((r) => r.userId === c.id)).toBe(false);
      await takeDailySnapshots();
      const day = await getLeaderboard({ kind: "league", leagueId: league.id }, { period: "day" });
      expect(day.rows.every((r) => r.changeCents === 0)).toBe(true);
    } finally {
      await db.update(schema.playerPrices).set({ priceCents: p.price }).where(eq(schema.playerPrices.playerId, p.id));
    }
  });
});

describe("privacy", () => {
  it("hides holdings and activity from strangers by default but shows them to friends", async () => {
    const owner = await makeUser("pv");
    const stranger = await makeUser("ps");
    const friend = await makeUser("pf");
    const p = await anyPlayer();
    await executeTrade({ userId: owner.id, playerId: p.id, side: "buy", quantity: 1, idempotencyKey: key() });
    const asStranger = await getProfile(stranger.id, owner.username);
    expect(asStranger.portfolio).toBeNull();
    expect(asStranger.portfolioHidden).toBe(true);
    expect(asStranger.activity).toEqual([]);
    expect(JSON.stringify(asStranger)).not.toContain(owner.email);
    await sendFriendRequest(friend.id, owner.username);
    await respondToFriendRequest(owner.id, (await listFriendRequests(owner.id)).incoming[0].id, true);
    const asFriend = await getProfile(friend.id, owner.username);
    expect(asFriend.portfolio?.holdings).toHaveLength(1);
    expect(asFriend.activity.length).toBeGreaterThan(0);
    const feed = await friendsFeed(friend.id);
    expect(feed.some((e) => e.username === owner.username && e.kind === "trade")).toBe(true);
    await db.update(schema.users).set({ activityVisibility: "private", portfolioVisibility: "private" }).where(eq(schema.users.id, owner.id));
    const locked = await getProfile(friend.id, owner.username);
    expect(locked.portfolio).toBeNull();
    expect((await friendsFeed(friend.id)).some((e) => e.username === owner.username)).toBe(false);
  });
});
