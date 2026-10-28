import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { UserLink } from "@/components/market/atoms";
import { LeagueSettings, MemberMenu, NewInvite } from "@/components/social/league-admin";
import { CopyField } from "@/components/social/social-forms";
import { Standings } from "@/components/social/standings";
import { ActionButton } from "@/components/ui/action-button";
import { Badge, Panel } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { dateTime, shortDate } from "@/lib/format";
import { requirePageUser } from "@/server/auth/current-user";
import { HttpError } from "@/server/http";
import { getLeaderboard } from "@/server/leaderboard/service";
import { listFriends } from "@/server/social/friends";
import { getLeagueForViewer, listInvites, listMembers } from "@/server/social/leagues";

export const metadata: Metadata = { title: "League" };

export default async function LeaguePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  const period = z.enum(["season", "week", "day"]).catch("season").parse((await searchParams).period);
  let view: Awaited<ReturnType<typeof getLeagueForViewer>>;
  try {
    view = await getLeagueForViewer(id, user.id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const { league, role } = view;
  const isMember = Boolean(role);
  const canManage = role === "owner" || role === "admin";
  const canInvite = canManage || (role === "member" && league.membersCanInvite);
  const [board, members, invites, friends] = await Promise.all([
    getLeaderboard({ kind: "league", leagueId: id }, { period, limit: 100 }),
    listMembers(user.id, id),
    canInvite ? listInvites(user.id, id) : Promise.resolve([]),
    canInvite ? listFriends(user.id) : Promise.resolve([]),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));

  return (
    <>
      <Link href="/social" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-chalk-3 hover:text-chalk">
        <ArrowLeft className="size-3.5" aria-hidden /> Friends & leagues
      </Link>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="scoreboard text-5xl text-chalk">{league.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-chalk-3">
            <Badge>{league.visibility === "public" ? "Public" : "Invite only"}</Badge>
            <span>
              {view.members} of {league.maxMembers} members
            </span>
            <span>Created {shortDate(league.createdAt)}</span>
          </p>
          {league.description ? <p className="mt-3 max-w-2xl text-sm text-chalk-2">{league.description}</p> : null}
        </div>
        <div className="flex gap-2">
          {!isMember ? (
            <ActionButton endpoint={`/api/leagues/${id}/join`} variant="primary" size="md" success={`Joined ${league.name}`}>
              Join league
            </ActionButton>
          ) : role === "owner" ? (
            <ActionButton
              endpoint={`/api/leagues/${id}`}
              method="DELETE"
              variant="danger"
              size="md"
              redirectTo="/social"
              success="League archived"
              confirm={{ title: `Archive ${league.name}?`, body: "Standings disappear and all invite links stop working. This can't be undone.", action: "Archive league" }}
            >
              Archive
            </ActionButton>
          ) : (
            <ActionButton
              endpoint={`/api/leagues/${id}/leave`}
              variant="danger"
              size="md"
              redirectTo="/social"
              success={`You left ${league.name}`}
              confirm={{ title: `Leave ${league.name}?`, body: "You'll need a new invite to rejoin.", action: "Leave league" }}
            >
              Leave
            </ActionButton>
          )}
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1fr_380px]">
        <Panel
          title="Standings"
          action={
            <nav aria-label="Period" className="flex rounded-md border border-line-strong p-0.5">
              {(["season", "week", "day"] as const).map((p) => (
                <Link key={p} href={`/leagues/${id}?period=${p}`} aria-current={period === p ? "page" : undefined} className={cn("h-7 rounded px-2.5 text-[12.5px] leading-7", period === p ? "bg-pitch-700 text-chalk" : "text-chalk-3 hover:text-chalk")}>
                  {p === "season" ? "Season" : p === "week" ? "Week" : "Today"}
                </Link>
              ))}
            </nav>
          }
        >
          <Standings rows={board.rows} viewerId={user.id} period={period} />
          <p className="mt-3 text-[12.5px] text-chalk-4">Updated {dateTime(board.computedAt)}. Rankings use each member’s whole portfolio value.</p>
        </Panel>

        <div className="space-y-4">
          {canInvite ? (
            <Panel title="Invite" id="invites" action={<NewInvite leagueId={id} friends={friends.filter((f) => !memberIds.has(f.id)).map((f) => ({ username: f.username, displayName: f.displayName }))} />}>
              {invites.filter((i) => i.active && !i.invitedUsername)[0] ? <CopyField value={invites.filter((i) => i.active && !i.invitedUsername)[0].url} label="Share this link" /> : <p className="text-sm text-chalk-3">No active open invite. Create one to get a link.</p>}
              {invites.length > 0 ? (
                <ul className="mt-4 divide-y divide-line text-[13px]">
                  {invites.map((inv) => (
                    <li key={inv.id} className="flex items-center gap-2 py-2">
                      <span className="font-mono text-chalk-2">{inv.code}</span>
                      <span className="min-w-0 flex-1 truncate text-chalk-4">
                        {inv.invitedUsername ? `for @${inv.invitedUsername}` : `${inv.uses}${inv.maxUses ? ` of ${inv.maxUses}` : ""} used`}
                        {inv.expiresAt ? `, expires ${shortDate(inv.expiresAt)}` : ""}
                        {!inv.active ? ", inactive" : ""}
                      </span>
                      <ActionButton endpoint={`/api/invite-links/${inv.id}`} method="DELETE" variant="ghost" success="Invite revoked">
                        Revoke
                      </ActionButton>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>
          ) : null}

          <Panel title={`Members (${members.length})`} id="members">
            <ul className="divide-y divide-line">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <UserLink username={m.username} displayName={m.displayName} color={m.avatarColor} isDemo={m.isDemo} />
                  </div>
                  {m.role !== "member" ? <Badge tone={m.role === "owner" ? "lime" : "neutral"}>{m.role === "owner" ? "Owner" : "Admin"}</Badge> : null}
                  {m.userId !== user.id ? (
                    <MemberMenu
                      leagueId={id}
                      userId={m.userId}
                      name={m.displayName}
                      isAdmin={m.role === "admin"}
                      canPromote={role === "owner" && m.role !== "owner"}
                      canTransfer={role === "owner" && m.role !== "owner"}
                      canRemove={(role === "owner" && m.role !== "owner") || (role === "admin" && m.role === "member")}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>

          {canManage ? (
            <Panel title="Settings" id="settings">
              <LeagueSettings league={{ id, name: league.name, description: league.description, visibility: league.visibility, maxMembers: league.maxMembers, membersCanInvite: league.membersCanInvite }} isOwner={role === "owner"} />
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
