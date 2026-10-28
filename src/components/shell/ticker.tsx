import Link from "next/link";
import { changeBps, formatCredits, formatPct } from "@/lib/money";

/**
 * The tape: biggest real movers from the latest price updates. This is the one
 * piece of ambient motion in the product (paused on hover / focus, static when
 * the user prefers reduced motion).
 */
export function Ticker({ items }: { items: { slug: string; name: string; club: string | null; priceCents: number; previousPriceCents: number }[] }) {
  if (items.length === 0) return null;
  const row = items.map((m) => {
    const bps = changeBps(m.previousPriceCents, m.priceCents);
    const up = bps >= 0;
    return (
      <Link key={m.slug} href={`/players/${m.slug}`} className="inline-flex items-center gap-2 px-4 text-[12.5px] whitespace-nowrap hover:text-chalk">
        <span className="font-medium text-chalk">{m.name}</span>
        <span className="text-chalk-4">{m.club}</span>
        <span className="num text-chalk-2">{formatCredits(m.priceCents)}</span>
        <span className={up ? "num text-gain" : "num text-loss"}>
          {up ? "▲" : "▼"} {formatPct(bps)}
        </span>
      </Link>
    );
  });
  return (
    <div className="group relative overflow-hidden border-b border-line bg-pitch-950/60" aria-label="Biggest moves since each player's last match">
      <div className="flex w-max animate-ticker py-1.5 group-focus-within:[animation-play-state:paused] group-hover:[animation-play-state:paused]">
        <div className="flex">{row}</div>
        <div className="flex" aria-hidden>
          {row}
        </div>
      </div>
    </div>
  );
}
