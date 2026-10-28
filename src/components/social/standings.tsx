import { Trophy } from "lucide-react";
import { UserLink } from "@/components/market/atoms";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { formatCredits, formatPct } from "@/lib/money";
import type { LeaderboardRow, Period } from "@/server/leaderboard/service";

export function Standings({ rows, viewerId, period, emptyTitle, emptyBody }: { rows: LeaderboardRow[]; viewerId: string; period: Period; emptyTitle?: string; emptyBody?: React.ReactNode }) {
  if (rows.length === 0) return <EmptyState icon={<Trophy className="size-6" />} title={emptyTitle ?? "Nobody here yet"} body={emptyBody} />;
  return (
    <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">Standings</caption>
        <thead>
          <tr className="hairline-b text-left text-[12.5px] text-chalk-3">
            <th scope="col" className="w-20 px-4 py-2 font-medium sm:px-5">Rank</th>
            <th scope="col" className="px-3 py-2 font-medium">Manager</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Portfolio value</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{period === "season" ? "Total return" : period === "week" ? "This week" : "Today"}</th>
            {period !== "season" ? <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">Total return</th> : <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">P/L</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const me = r.userId === viewerId;
            const pct = period === "season" ? r.totalReturnBps : r.changeBps;
            return (
              <tr key={r.userId} className={cn(me && "bg-lime/[0.06]")} aria-current={me ? "true" : undefined}>
                <td className="px-4 py-2.5 sm:px-5">
                  <span className="flex items-center gap-2">
                    <span className={cn("scoreboard w-8 text-2xl", r.rank <= 3 ? "text-lime" : "text-chalk")}>{r.rank}</span>
                    <Movement value={r.movement} />
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    <UserLink username={r.username} displayName={r.displayName} color={r.avatarColor} isDemo={r.isDemo} />
                    {me ? <span className="rounded border border-lime/40 px-1.5 text-[11px] text-lime">You</span> : null}
                  </span>
                </td>
                <td className="num px-3 py-2.5 text-right text-chalk">{formatCredits(r.valueCents)}</td>
                <td className={cn("num px-3 py-2.5 text-right font-medium", pct > 0 ? "text-gain" : pct < 0 ? "text-loss" : "text-chalk-3")}>
                  {pct > 0 ? "▲ " : pct < 0 ? "▼ " : ""}
                  {formatPct(pct)}
                </td>
                <td className="num px-4 py-2.5 text-right text-chalk-2 sm:px-5">
                  {period === "season" ? formatCredits(r.totalReturnCents, { sign: true }) : formatPct(r.totalReturnBps)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Movement({ value }: { value: number | null }) {
  if (value === null || value === 0) return <span className="w-8 text-[12px] text-chalk-4" aria-label="No change today">–</span>;
  const up = value > 0;
  return (
    <span className={cn("num w-8 text-[12px]", up ? "text-gain" : "text-loss")} aria-label={`${up ? "Up" : "Down"} ${Math.abs(value)} since the start of today`}>
      {up ? "▲" : "▼"}
      {Math.abs(value)}
    </span>
  );
}
