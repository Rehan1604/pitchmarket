import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { UserLink } from "@/components/market/atoms";
import { CreateLeagueButton, FriendSearch, JoinByCode } from "@/components/social/social-forms";
import { ActionButton } from "@/components/ui/action-button";
import { Badge, EmptyState, PageHeader, Panel } from "@/components/ui/misc";
import { timeAgo } from "@/lib/format";
import { requirePageUser } from "@/server/auth/current-user";
import { rankOf } from "@/server/leaderboard/service";
import { listFriendRequests, listFriends } from "@/server/social/friends";
import { listMyLeagues, listPublicLeagues } from "@/server/social/leagues";

export const metadata: Metadata = { title: "Friends & leagues" };

export default async function SocialPage() {
  const user = await requirePageUser();
  const [friends, requests, leagues, publicLeagues] = await Promise.all([listFriends(user.id), listFriendRequests(user.id), listMyLeagues(user.id), listPublicLeagues(10)]);
  const ranks = await Promise.all(leagues.map((l) => rankOf({ kind: "league", leagueId: l.id }, user.id)));
  const mine = new Set(leagues.map((l) => l.id));

  return (
    <>
      <PageHeader title="Friends & leagues" description="Add friends to compare portfolios. Leagues rank members by portfolio value and update whenever prices move." />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Panel title="Find friends" id="find">
            <FriendSearch />
          </Panel>

          {requests.incoming.length > 0 ? (
            <Panel title={`Friend requests (${requests.incoming.length})`} id="incoming">
              <ul className="divide-y divide-line">
                {requests.incoming.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <UserLink username={r.username} displayName={r.displayName} color={r.avatarColor} />
                    </div>
                    <span className="hidden text-[12px] text-chalk-4 sm:inline">{timeAgo(r.createdAt)}</span>
                    <ActionButton endpoint={`/api/friends/requests/${r.id}`} body={{ action: "decline" }} variant="ghost" success="Request declined">
                      Decline
                    </ActionButton>
                    <ActionButton endpoint={`/api/friends/requests/${r.id}`} body={{ action: "accept" }} variant="primary" success={`You and ${r.displayName} are now friends`}>
                      Accept
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel title={`Friends (${friends.length})`} id="friends" action={friends.length ? <Link href="/leaderboard?scope=friends" className="text-[13px] text-chalk-3 hover:text-chalk">Friends leaderboard</Link> : null}>
            {friends.length === 0 ? (
              <EmptyState icon={<Users className="size-6" />} title="No friends yet" body="Search by username above, or share a league invite link and become friends inside the league." />
            ) : (
              <ul className="divide-y divide-line">
                {friends.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <UserLink username={f.username} displayName={f.displayName} color={f.avatarColor} isDemo={f.isDemo} />
                    </div>
                    <span className="text-[12px] text-chalk-4">{f.lastActiveAt ? `Active ${timeAgo(f.lastActiveAt)}` : "Not active yet"}</span>
                    <ActionButton
                      endpoint={`/api/friends/${f.username}`}
                      method="DELETE"
                      variant="ghost"
                      success="Friend removed"
                      confirm={{ title: `Remove ${f.displayName}?`, body: "You'll stop seeing each other's friends-only activity and holdings. You can add each other again later.", action: "Remove friend" }}
                    >
                      Remove
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
            {requests.outgoing.length > 0 ? (
              <div className="mt-4 border-t border-line pt-3">
                <p className="mb-2 text-[13px] text-chalk-3">Waiting for a reply</p>
                <ul className="space-y-2">
                  {requests.outgoing.map((r) => (
                    <li key={r.id} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <UserLink username={r.username} displayName={r.displayName} color={r.avatarColor} size={24} />
                      </div>
                      <ActionButton endpoint={`/api/friends/requests/${r.id}`} body={{ action: "cancel" }} variant="ghost" success="Request cancelled">
                        Cancel
                      </ActionButton>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Your leagues" id="leagues" action={<CreateLeagueButton />}>
            {leagues.length === 0 ? (
              <EmptyState title="You're not in a league yet" body="Create one, then send the invite link to your group chat." />
            ) : (
              <ul className="divide-y divide-line">
                {leagues.map((l, i) => (
                  <li key={l.id}>
                    <Link href={`/leagues/${l.id}`} className="flex items-center gap-3 py-3 hover:bg-pitch-800/50">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 font-medium text-chalk">
                          {l.name}
                          {l.role !== "member" ? <Badge tone={l.role === "owner" ? "lime" : "neutral"}>{l.role === "owner" ? "Owner" : "Admin"}</Badge> : null}
                          {l.visibility === "public" ? <Badge>Public</Badge> : null}
                        </span>
                        <span className="text-xs text-chalk-3">{l.members} member{l.members === 1 ? "" : "s"}</span>
                      </span>
                      {ranks[i] ? (
                        <span className="text-right text-sm">
                          <span className="scoreboard text-2xl text-chalk">#{ranks[i]!.rank}</span>
                          <span className="ml-1 text-chalk-3">of {ranks[i]!.total}</span>
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 border-t border-line pt-4">
              <p className="mb-2 text-[13px] text-chalk-3">Got an invite?</p>
              <JoinByCode />
            </div>
          </Panel>

          <Panel title="Public leagues" id="public">
            {publicLeagues.length === 0 ? (
              <EmptyState title="No public leagues yet" body="Make a league public when you create it and anyone can join." />
            ) : (
              <ul className="divide-y divide-line">
                {publicLeagues.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 py-2.5">
                    <Link href={`/leagues/${l.id}`} className="min-w-0 flex-1 hover:underline">
                      <span className="block truncate text-sm font-medium text-chalk">{l.name}</span>
                      <span className="text-xs text-chalk-3">
                        {l.members} of {l.maxMembers} members
                      </span>
                    </Link>
                    {mine.has(l.id) ? (
                      <span className="text-[12.5px] text-chalk-3">Joined</span>
                    ) : l.members >= l.maxMembers ? (
                      <span className="text-[12.5px] text-chalk-3">Full</span>
                    ) : (
                      <ActionButton endpoint={`/api/leagues/${l.id}/join`} success={`Joined ${l.name}`} redirectTo={`/leagues/${l.id}`}>
                        Join
                      </ActionButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
