import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Change, PositionBadge, UserAvatar } from "@/components/market/atoms";
import { ActionButton } from "@/components/ui/action-button";
import { ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState, Panel } from "@/components/ui/misc";
import { shortDate, timeAgo } from "@/lib/format";
import { formatCredits } from "@/lib/money";
import { requirePageUser } from "@/server/auth/current-user";
import { HttpError } from "@/server/http";
import { getProfile } from "@/server/social/profiles";

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  return { title: `@${(await params).username}` };
}

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const viewer = await requirePageUser();
  const { username } = await params;
  if (!/^[A-Za-z0-9_]{1,40}$/.test(username)) notFound();
  let p: Awaited<ReturnType<typeof getProfile>>;
  try {
    p = await getProfile(viewer.id, username);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const rel = p.relationship.kind;
  return (
    <>
      <section className="panel pitch-lines mb-4 flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-7">
        <UserAvatar name={p.user.displayName} color={p.user.avatarColor} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="scoreboard text-5xl text-chalk">{p.user.displayName}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-chalk-3">
            @{p.user.username}
            <span>Joined {shortDate(p.user.joinedAt)}</span>
            {p.user.lastActiveAt ? <span>Active {timeAgo(p.user.lastActiveAt)}</span> : null}
            {p.user.isDemo ? <Badge tone="amber">Demo account</Badge> : null}
          </p>
          {p.user.bio ? <p className="mt-3 max-w-xl text-sm text-chalk-2">{p.user.bio}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-6">
          {p.performance ? (
            <div>
              <p className="text-[12.5px] text-chalk-3">Portfolio value</p>
              <p className="scoreboard text-4xl text-chalk">{formatCredits(p.performance.valueCents, { decimals: 0 })}</p>
              <Change bps={p.performance.returnBps} />
            </div>
          ) : null}
          {p.globalRank ? (
            <div>
              <p className="text-[12.5px] text-chalk-3">Global rank</p>
              <p className="scoreboard text-4xl text-chalk">#{p.globalRank.rank}</p>
              <p className="text-[12.5px] text-chalk-3">of {p.globalRank.total}</p>
            </div>
          ) : null}
          <div>
            {rel === "self" ? (
              <ButtonLink href="/settings" size="sm">
                Edit profile
              </ButtonLink>
            ) : rel === "friend" ? (
              <Badge tone="gain">Friends</Badge>
            ) : rel === "pending_out" ? (
              <Badge>Request sent</Badge>
            ) : rel === "pending_in" && p.relationship.requestId ? (
              <ActionButton endpoint={`/api/friends/requests/${p.relationship.requestId}`} body={{ action: "accept" }} variant="primary" success="You're now friends">
                Accept friend request
              </ActionButton>
            ) : (
              <ActionButton endpoint="/api/friends/requests" body={{ username: p.user.username }} variant="primary" success="Friend request sent">
                Add friend
              </ActionButton>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Holdings" id="holdings">
          {p.portfolioHidden ? (
            <EmptyState icon={<Lock className="size-6" />} title="Holdings are private" body={rel === "friend" ? "This manager keeps their holdings to themselves." : "This manager shares holdings with friends only, or not at all."} />
          ) : p.portfolio && p.portfolio.holdings.length ? (
            <ul className="divide-y divide-line">
              {p.portfolio.holdings.map((h) => (
                <li key={h.slug} className="flex items-center gap-3 py-2 text-sm">
                  <PositionBadge position={h.position} />
                  <Link href={`/players/${h.slug}`} className="min-w-0 flex-1 truncate text-chalk hover:underline">
                    {h.name} <span className="text-chalk-4">{h.club}</span>
                  </Link>
                  <span className="num text-chalk-3">{(h.allocationBps / 100).toFixed(1)}%</span>
                  <Change bps={h.unrealizedBps} className="w-20 justify-end" />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="All in cash" body="No holdings right now." />
          )}
        </Panel>
        <div className="space-y-4">
          <Panel title="Recent activity" id="activity">
            {p.activityHidden ? (
              <EmptyState icon={<Lock className="size-6" />} title="Activity is private" />
            ) : p.activity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {p.activity.map((a) => {
                  const pl = a.payload as Record<string, string | number>;
                  return (
                    <li key={a.id} className="flex justify-between gap-3 py-2 text-chalk-2">
                      <span>
                        {a.kind === "trade" ? (
                          <>
                            {pl.side === "buy" ? "Bought" : "Sold"} {pl.quantity} × <Link href={`/players/${pl.playerSlug}`} className="text-chalk hover:underline">{pl.playerName}</Link>
                          </>
                        ) : a.kind === "league_join" ? (
                          <>Joined {pl.leagueName}</>
                        ) : a.kind === "league_create" ? (
                          <>Created {pl.leagueName}</>
                        ) : a.kind === "rank_change" ? (
                          <>Moved to #{pl.to} globally</>
                        ) : (
                          <>Made a new friend</>
                        )}
                      </span>
                      <span className="shrink-0 text-[12px] text-chalk-4">{timeAgo(a.createdAt)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          {p.commonLeagues.length ? (
            <Panel title="Leagues you share" id="common">
              <ul className="space-y-1.5 text-sm">
                {p.commonLeagues.map((l) => (
                  <li key={l.id}>
                    <Link href={`/leagues/${l.id}`} className="text-chalk hover:underline">
                      {l.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
