"use client";

import { useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/cn";
import { formatCredits, formatPct, changeBps } from "@/lib/money";

export interface ChartPoint {
  t: number;
  price: number;
  label: string;
  kind: "ipo" | "match" | "live" | "now";
}

const GAIN = "#3ddc97";
const LOSS = "#ff6a5c";

/**
 * Settled price history as a step line: prices only change at full time
 * (or provisionally while a match is live), so flat segments are the truth.
 * Single series → no legend; the panel title names it. A table view of the
 * same points lives in the match-by-match table below the chart.
 */
export function PriceChart({ points, ipoCents }: { points: ChartPoint[]; ipoCents: number }) {
  const [range, setRange] = useState<"season" | "recent">("season");
  const data = useMemo(() => {
    if (range === "season" || points.length <= 7) return points;
    return points.slice(-7);
  }, [points, range]);
  const first = data[0]?.price ?? ipoCents;
  const last = data[data.length - 1]?.price ?? ipoCents;
  const color = last >= first ? GAIN : LOSS;
  const min = Math.min(...data.map((d) => d.price));
  const max = Math.max(...data.map((d) => d.price));
  const pad = Math.max(500, Math.round((max - min) * 0.15));

  if (points.length < 2) {
    return <p className="flex h-[260px] items-center justify-center text-sm text-chalk-3">The chart starts after this player’s first priced match.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[13px] text-chalk-3">
          {range === "season" ? "Since listing" : "Last 6 price moves"}: <span className={cn("num font-medium", last >= first ? "text-gain" : "text-loss")}>{last >= first ? "▲" : "▼"} {formatPct(changeBps(first, last))}</span>
        </p>
        <div className="flex rounded-md border border-line-strong p-0.5" role="group" aria-label="Chart range">
          {(["season", "recent"] as const).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className={cn("h-7 rounded px-2.5 text-[12.5px]", range === r ? "bg-pitch-700 text-chalk" : "text-chalk-3 hover:text-chalk")}>
              {r === "season" ? "Season" : "Recent"}
            </button>
          ))}
        </div>
      </div>
      <div className="h-[280px] w-full overflow-hidden" role="img" aria-label={`Price history from ${formatCredits(first)} to ${formatCredits(last)} Pitch Credits`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="pc-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={color} stopOpacity={0.01} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="rgba(241,238,228,0.07)" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}
              tick={{ fill: "#82918a", fontSize: 12 }}
              axisLine={{ stroke: "rgba(241,238,228,0.12)" }}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              dataKey="price"
              domain={[Math.max(0, min - pad), max + pad]}
              tickFormatter={(v) => formatCredits(v, { decimals: 0 })}
              tick={{ fill: "#82918a", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <ReferenceLine y={ipoCents} stroke="rgba(241,238,228,0.18)" strokeWidth={1} label={{ value: "Listing price", position: "insideBottomLeft", fill: "#56655e", fontSize: 11 }} />
            <Tooltip
              cursor={{ stroke: "rgba(241,238,228,0.35)", strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as ChartPoint;
                const idx = data.findIndex((d) => d.t === p.t);
                const prev = idx > 0 ? data[idx - 1].price : null;
                return (
                  <div className="panel px-3 py-2 text-[12.5px] shadow-xl shadow-black/40">
                    <p className="text-chalk-3">{new Date(p.t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</p>
                    <p className="num mt-0.5 text-sm font-semibold text-chalk">{formatCredits(p.price)} PC</p>
                    {prev !== null && p.kind !== "now" ? (
                      <p className={cn("num", p.price >= prev ? "text-gain" : "text-loss")}>
                        {p.price >= prev ? "▲" : "▼"} {formatPct(changeBps(prev, p.price))}
                      </p>
                    ) : null}
                    <p className="mt-0.5 max-w-56 text-chalk-2">{p.label}</p>
                  </div>
                );
              }}
            />
            <Area type="stepAfter" dataKey="price" stroke={color} strokeWidth={2} fill="url(#pc-fill)" isAnimationActive={false} dot={false} activeDot={{ r: 5, fill: color, stroke: "#0b1814", strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
