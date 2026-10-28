"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCredits } from "@/lib/money";

/** Portfolio value from daily start-of-day snapshots plus "now". Single series, no legend. */
export function ValueChart({ points, startingCents }: { points: { t: number; value: number; label: string }[]; startingCents: number }) {
  const min = Math.min(startingCents, ...points.map((p) => p.value));
  const max = Math.max(startingCents, ...points.map((p) => p.value));
  const pad = Math.max(10_000, Math.round((max - min) * 0.2));
  const up = points[points.length - 1].value >= startingCents;
  const color = up ? "#3ddc97" : "#ff6a5c";
  return (
    <div className="h-[220px] w-full overflow-hidden" role="img" aria-label={`Portfolio value over ${points.length} daily snapshots`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="rgba(241,238,228,0.07)" />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} tick={{ fill: "#82918a", fontSize: 12 }} axisLine={{ stroke: "rgba(241,238,228,0.12)" }} tickLine={false} minTickGap={40} />
          <YAxis domain={[min - pad, max + pad]} tickFormatter={(v) => `${Math.round(v / 100_000)}k`} tick={{ fill: "#82918a", fontSize: 12 }} axisLine={false} tickLine={false} width={44} />
          <ReferenceLine y={startingCents} stroke="rgba(241,238,228,0.18)" label={{ value: "Starting balance", position: "insideBottomLeft", fill: "#56655e", fontSize: 11 }} />
          <Tooltip
            cursor={{ stroke: "rgba(241,238,228,0.35)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { t: number; value: number; label: string };
              return (
                <div className="panel px-3 py-2 text-[12.5px] shadow-xl shadow-black/40">
                  <p className="text-chalk-3">{p.label}</p>
                  <p className="num text-sm font-semibold text-chalk">{formatCredits(p.value)} PC</p>
                </div>
              );
            }}
          />
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 3, fill: color, stroke: "#0b1814", strokeWidth: 2 }} activeDot={{ r: 5, fill: color, stroke: "#0b1814", strokeWidth: 2 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
