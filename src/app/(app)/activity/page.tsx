import { Bell } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { UserAvatar } from "@/components/market/atoms";
import { ActionButton } from "@/components/ui/action-button";
import { EmptyState, PageHeader, Panel } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { formatCredits } from "@/lib/money";
import { requirePageUser } from "@/server/auth/current-user";
import { mostTraded } from "@/server/market/queries";
import { friendsFeed, listNotifications } from "@/server/social/profiles";

export const metadata: Metadata = { title: "Activity" };

type Event = Awaited<ReturnType<typeof friendsFeed>>[number];

function describe(e: Event, me: string): React.ReactNode {
  const who = e.username === me ? "You" : e.displayName;
  const p = e.payload as Record<string, string | number | undefined>;
  switch (e.kind) {
    case "trade":
      return (
        <>
          {who} {p.side === "buy" ? "bought" : "sold"} {p.quantity} ×{" "}
          <Link href={`/players/${p.playerSlug}`} className="text-chalk hover:underline">
            {p.playerName}
          </Link>{" "}
          at {formatCredits(Number(p.priceCents))}
        </>
      );
    case "league_join":
      return (
        <>
          {who} joined{" "}
          <Link href={`/leagues/${p.leagueId}`} className="text-chalk hover:underline">
            {p.leagueName}
          </Link>
        </>
      );
    case "league_create":
      return (
        <>
          {who} created{" "}
          <Link href={`/leagues/${p.leagueId}`} className="text-chalk hover:underline">
            {p.leagueName}
          </Link>
        </>
      );
    case "rank_change":
      return (
        <>
          {who} moved from #{p.from} to #{p.to} on the global leaderboard
        </>
      );
    case "friend":
      return <>{who} made a new friend</>;
    default:
      return <>{who} did something</>;
  }
}

export default async function ActivityPage() {
  const user = await requirePageUser();
  const [notes, feed, traded] = await Promise.all([listNotifications(user.id, 50), friendsFeed(user.id, 50), mostTraded(8)]);
  const unread = notes.filter((n) => !n.readAt).length;
  return (
    <>
      <PageHeader title="Activity" description="Your notifications, what your friends are doing, and where the market’s attention is." />
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel
          title={`Notifications${unread ? ` (${unread} new)` : ""}`}
          id="notifications"
          action={unread ? <ActionButton endpoint="/api/notifications/read" body={{}} variant="ghost" success="All caught up">Mark all read</ActionButton> : null}
        >
          {notes.length === 0 ? (
            <EmptyState icon={<Bell className="size-6" />} title="No notifications yet" body="Trade confirmations, friend requests, league invites, big price moves on your players and rank changes appear here." />
          ) : (
            <ul className="divide-y divide-line">
              {notes.map((n) => (
                <li key={n.id} className={cn("relative py-3 pl-4", !n.readAt && "before:absolute before:top-4.5 before:left-0 before:size-1.5 before:rounded-full before:bg-lime")}>
                  {n.link ? (
                    <Link href={n.link} className="block hover:underline">
                      <span className={cn("text-sm", n.readAt ? "text-chalk-2" : "font-medium text-chalk")}>{n.title}</span>
                    </Link>
                  ) : (
                    <span className={cn("text-sm", n.readAt ? "text-chalk-2" : "font-medium text-chalk")}>{n.title}</span>
                  )}
                  {n.body ? <p className="mt-0.5 text-[13px] text-chalk-3">{n.body}</p> : null}
                  <p className="mt-0.5 text-[12px] text-chalk-4">
                    {!n.readAt ? <span className="sr-only">Unread. </span> : null}
                    {timeAgo(n.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Friends’ activity" id="feed">
            {feed.length === 0 ? (
              <EmptyState title="Quiet so far" body={<>Your trades and your friends’ shared activity show up here. <Link href="/social" className="text-lime hover:underline">Add friends</Link>.</>} />
            ) : (
              <ul className="divide-y divide-line">
                {feed.map((e) => (
                  <li key={e.id} className="flex items-start gap-3 py-2.5">
                    <UserAvatar name={e.displayName} color={e.avatarColor} size={28} />
                    <div className="min-w-0 flex-1 text-sm text-chalk-2">
                      <p>{describe(e, user.username)}</p>
                      <p className="text-[12px] text-chalk-4">{timeAgo(e.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Most traded in the last 24 hours" id="traded" action={<span className="text-[12px] text-chalk-4">All managers, anonymised</span>}>
            {traded.length === 0 ? (
              <EmptyState title="No trades in the last 24 hours" />
            ) : (
              <ul className="divide-y divide-line">
                {traded.map((t) => (
                  <li key={t.slug} className="flex items-center gap-3 py-2 text-sm">
                    <Link href={`/players/${t.slug}`} className="min-w-0 flex-1 truncate text-chalk hover:underline">
                      {t.name} <span className="text-chalk-4">{t.club}</span>
                    </Link>
                    <span className="num text-chalk-3">
                      {t.trades} trade{t.trades === 1 ? "" : "s"}, {Math.round((t.buys / t.trades) * 100)}% buys
                    </span>
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
