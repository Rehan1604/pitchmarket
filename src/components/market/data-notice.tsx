import { CirclePause, History } from "lucide-react";
import { dateTime } from "@/lib/format";
import { dataStatus } from "@/server/market/queries";

/** Honest data banner: shown whenever prices are not from a live feed or trading is paused. */
export async function DataNotice({ context = "market" }: { context?: "market" | "fixtures" }) {
  const s = await dataStatus();
  if (s.marketStatus !== "open") {
    return (
      <div role="status" className="mb-5 flex items-start gap-3 rounded-lg border border-loss/30 bg-loss/8 px-4 py-3 text-sm">
        <CirclePause className="mt-0.5 size-4 shrink-0 text-loss" aria-hidden />
        <div>
          <p className="font-medium text-chalk">{s.marketStatus === "maintenance" ? "The market is in maintenance" : "Trading is paused"}</p>
          <p className="mt-0.5 text-chalk-3">{s.marketReason ?? "Orders can't be placed right now. Prices and portfolios are still shown."}</p>
        </div>
      </div>
    );
  }
  if (s.dataMode === "snapshot") {
    return (
      <div role="status" className="mb-5 flex items-start gap-3 rounded-lg border border-amber/25 bg-amber/6 px-4 py-3 text-sm">
        <History className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden />
        <div>
          <p className="font-medium text-chalk">Delayed data: {context === "fixtures" ? "results" : "prices"} include matches up to {s.dataAsOf ? dateTime(s.dataAsOf) : "the latest snapshot"}</p>
          <p className="mt-0.5 text-chalk-3">
            This server can’t reach the live Fantasy Premier League feed, so it is using the public FPL archive on GitHub, which updates days after each gameweek. Nothing here is shown as live. Prices will move when newer matches arrive.
          </p>
        </div>
      </div>
    );
  }
  return null;
}
