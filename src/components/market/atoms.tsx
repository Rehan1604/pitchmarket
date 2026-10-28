import { CircleAlert, CircleHelp, Cross, Ban, CircleCheck } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { changeBps, formatCredits, formatPct } from "@/lib/money";
import { initials } from "@/lib/text";

const POSITION_TONE: Record<string, string> = {
  GK: "text-amber border-amber/30",
  DEF: "text-sky border-sky/30",
  MID: "text-lime border-lime/30",
  FWD: "text-[#ff9f8f] border-[#ff9f8f]/30",
};

export function PositionBadge({ position, className }: { position: string; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded border px-1.5 text-[10.5px] font-semibold tracking-wide", POSITION_TONE[position] ?? "text-chalk-2 border-line-strong", className)}>{position}</span>;
}

/** Signed change with direction glyph — colour is never the only signal. */
export function Change({ from, to, bps, className, size = "sm" }: { from?: number; to?: number; bps?: number; className?: string; size?: "sm" | "md" | "lg" }) {
  const value = bps ?? (from !== undefined && to !== undefined ? changeBps(from, to) : 0);
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-1 font-medium whitespace-nowrap",
        dir === "up" && "text-gain",
        dir === "down" && "text-loss",
        dir === "flat" && "text-chalk-3",
        size === "sm" && "text-[13px]",
        size === "md" && "text-sm",
        size === "lg" && "text-lg",
        className,
      )}
    >
      <span aria-hidden className="text-[0.7em]">
        {dir === "up" ? "▲" : dir === "down" ? "▼" : "■"}
      </span>
      <span className="sr-only">{dir === "up" ? "up" : dir === "down" ? "down" : "unchanged"}</span>
      {formatPct(value)}
    </span>
  );
}

export function Credits({ cents, className, decimals = 2, sign }: { cents: number; className?: string; decimals?: 0 | 2; sign?: boolean }) {
  return (
    <span className={cn("num", className)}>
      {formatCredits(cents, { decimals, sign })}
      <span className="ml-1 text-[0.72em] font-normal text-chalk-3">PC</span>
    </span>
  );
}

export function PlayerMark({ name, position, size = 36 }: { name: string; position: string; size?: number }) {
  const ring: Record<string, string> = { GK: "#f2b544", DEF: "#7cc6fe", MID: "#d4f55c", FWD: "#ff9f8f" };
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-pitch-750 font-display font-bold text-chalk"
      style={{ width: size, height: size, fontSize: size * 0.4, boxShadow: `inset 0 0 0 1.5px ${ring[position] ?? "#56655e"}55` }}
    >
      {initials(name)}
    </span>
  );
}

export function UserAvatar({ name, color, size = 32, className }: { name: string; color: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-pitch-950", className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: color }}
    >
      {initials(name)}
    </span>
  );
}

export function UserLink({ username, displayName, color, isDemo, size = 28 }: { username: string; displayName: string; color: string; isDemo?: boolean; size?: number }) {
  return (
    <Link href={`/u/${username}`} className="group inline-flex min-w-0 items-center gap-2.5">
      <UserAvatar name={displayName} color={color} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-chalk group-hover:underline">{displayName}</span>
        <span className="block truncate text-xs text-chalk-3">
          @{username}
          {isDemo ? <span className="ml-1.5 rounded border border-amber/40 px-1 text-[10px] text-amber">Demo account</span> : null}
        </span>
      </span>
    </Link>
  );
}

const AVAIL: Record<string, { label: string; tone: string; Icon: typeof CircleCheck }> = {
  available: { label: "Available", tone: "text-gain", Icon: CircleCheck },
  doubtful: { label: "Doubtful", tone: "text-amber", Icon: CircleAlert },
  injured: { label: "Injured", tone: "text-loss", Icon: Cross },
  suspended: { label: "Suspended", tone: "text-loss", Icon: Ban },
  unavailable: { label: "Unavailable", tone: "text-chalk-3", Icon: Ban },
  unknown: { label: "No injury news from this feed", tone: "text-chalk-4", Icon: CircleHelp },
};

export function Availability({ status, chance, note, compact }: { status: string; chance?: number | null; note?: string | null; compact?: boolean }) {
  const a = AVAIL[status] ?? AVAIL.unknown;
  const text = status === "doubtful" && chance !== null && chance !== undefined ? `${chance}% chance` : a.label;
  if (compact) {
    // "unknown" = the feed publishes no injury news (ESPN leagues): show nothing rather than a warning on every row.
    if (status === "available" || status === "unknown") return null;
    return (
      <span title={note ?? text} className={cn("inline-flex items-center", a.tone)}>
        <a.Icon className="size-3.5" aria-hidden />
        <span className="sr-only">{text}</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px]", a.tone)}>
      <a.Icon className="size-3.5" aria-hidden />
      {text}
    </span>
  );
}

/** Minimal sparkline of settled prices. Single series → no legend; direction coloured by first→last. */
export function Sparkline({ values, width = 84, height = 26, className }: { values: number[]; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return <span className={cn("inline-block text-xs text-chalk-4", className)} style={{ width }} aria-label="Not enough history yet">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (width - pad * 2), pad + (1 - (v - min) / span) * (height - pad * 2)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} role="img" aria-label={`Price trend over the last ${values.length} price points: ${up ? "up" : "down"}`}>
      <path d={d} fill="none" stroke={up ? "#3ddc97" : "#ff6a5c"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={up ? "#3ddc97" : "#ff6a5c"} stroke="#0b1814" strokeWidth={1.5} />
    </svg>
  );
}
