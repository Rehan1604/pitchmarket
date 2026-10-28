"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import type { ShellStatus } from "./shell-data";

const POLL_MS = 20_000;

/**
 * Polls the lightweight market status endpoint. When the market version moves
 * (a live tick or settlement), server components re-render with fresh prices.
 * The pill always tells the truth about where data comes from and how old it is.
 */
export function MarketPulse({ initial }: { initial: ShellStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [offline, setOffline] = useState(false);
  const [, setNow] = useState(0);
  const version = useRef(initial.marketVersion);

  useEffect(() => {
    let stop = false;
    async function tick() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/market/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const s = await res.json();
        if (stop) return;
        setOffline(false);
        setStatus({
          ...s,
          dataAsOf: s.dataAsOf,
          lastPriceUpdateAt: s.lastPriceUpdateAt,
          lastSuccessAt: s.lastSuccessAt,
        });
        if (s.marketVersion !== version.current) {
          version.current = s.marketVersion;
          router.refresh();
        }
      } catch {
        if (!stop) setOffline(true);
      }
    }
    const id = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNow((n) => n + 1), 30_000);
    const onVis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      clearInterval(id);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [router]);

  const live = status.dataMode === "live";
  const halted = status.marketStatus !== "open";
  let label: string;
  let detail: string;
  if (offline) {
    label = "Connection lost";
    detail = "Retrying. Prices on screen may be out of date.";
  } else if (halted) {
    label = status.marketStatus === "maintenance" ? "Maintenance" : "Trading paused";
    detail = status.marketReason ?? "Trading is paused.";
  } else if (live && status.liveMatches > 0) {
    label = `${status.liveMatches} live`;
    detail = `In-play prices from the FPL feed. Updated ${timeAgo(status.lastPriceUpdateAt)}.`;
  } else if (live) {
    label = "Live feed";
    detail = `Connected to the FPL feed. Last price move ${timeAgo(status.lastPriceUpdateAt)}.`;
  } else if (status.dataMode === "snapshot") {
    label = "Snapshot data";
    detail = `Delayed public snapshot. Matches included up to ${status.dataAsOf ? new Date(status.dataAsOf).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "unknown"}.`;
  } else {
    label = "No data yet";
    detail = "The market hasn't been seeded.";
  }
  const tone = offline || halted ? "loss" : live ? "gain" : "amber";

  return (
    <div className="group relative">
      <button
        type="button"
        className={cn(
          "flex h-8 items-center gap-2 rounded-full border px-3 text-[12.5px] font-medium",
          tone === "gain" && "border-gain/30 text-gain",
          tone === "amber" && "border-amber/35 text-amber",
          tone === "loss" && "border-loss/35 text-loss",
        )}
        aria-describedby="market-pulse-detail"
      >
        <span className={cn("size-1.5 rounded-full bg-current", live && !halted && !offline && "animate-pulse-dot")} aria-hidden />
        {label}
      </button>
      <div
        id="market-pulse-detail"
        role="tooltip"
        className="panel invisible absolute top-10 right-0 z-40 w-72 p-3 text-[13px] text-chalk-2 opacity-0 shadow-xl shadow-black/40 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <p>{detail}</p>
        <p className="mt-2 text-chalk-3">Source: {status.dataProvider === "fpl-api" ? "Fantasy Premier League API" : status.dataProvider === "fpl-archive" ? "FPL public archive (GitHub)" : "none"}</p>
      </div>
    </div>
  );
}
