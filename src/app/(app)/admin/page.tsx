import type { Metadata } from "next";
import { IngestControl, MarketStatusControl } from "@/components/admin/controls";
import { Badge, PageHeader, Panel } from "@/components/ui/misc";
import { dateTime, timeAgo } from "@/lib/format";
import { diagnostics } from "@/server/admin/service";
import { requirePageAdmin } from "@/server/auth/current-user";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default async function AdminPage() {
  await requirePageAdmin();
  const d = await diagnostics();
  const e = env();
  const c = d.counts as Record<string, number>;
  return (
    <>
      <PageHeader title="Admin" description="Restricted to administrators. Data provider health, ingestion jobs, ledger integrity and market controls." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Market" id="market" action={<Badge tone={d.market.status === "open" ? "gain" : "loss"}>{d.market.status}</Badge>}>
          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <Item label="Data mode" value={d.market.dataMode} />
            <Item label="Provider" value={d.market.dataProvider ?? "none"} />
            <Item label="Data as of" value={dateTime(d.market.dataAsOf)} />
            <Item label="Last price update" value={timeAgo(d.market.lastPriceUpdateAt)} />
            <Item label="Market version" value={String(d.market.version)} />
            <Item label="Status set by" value={d.market.statusSetBy ?? "default"} />
          </dl>
          <MarketStatusControl status={d.market.status} reason={d.market.statusReason} />
        </Panel>
        <Panel title="Ingestion" id="ingest">
          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <Item label="DATA_PROVIDER" value={e.DATA_PROVIDER} />
            <Item label="Live poll" value={`${e.LIVE_POLL_SECONDS}s`} />
            <Item label="Live fixtures" value={String(c.live_fixtures)} />
            <Item label="Unsettled finished" value={String(c.unsettled_fixtures)} />
            <Item label="Settled fixtures" value={String(c.settled_fixtures)} />
            <Item label="Rate-limited runs (24h)" value={String(c.rate_limited_24h)} />
            <Item label="Cron endpoint" value={e.CRON_SECRET ? "configured" : "CRON_SECRET missing"} />
            <Item label="football-data.org" value={e.FOOTBALL_DATA_API_KEY ? "key set" : "not configured"} />
          </dl>
          <IngestControl />
        </Panel>

        <Panel title="Providers" id="providers" className="lg:col-span-2">
          <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="hairline-b text-left text-[12.5px] text-chalk-3">
                  {["Provider", "Last success", "Last error", "Failures in a row", "Backoff until", "Rate-limit hits", "Data as of"].map((h) => (
                    <th key={h} className="px-4 py-2 font-medium first:sm:pl-5">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.providers.map((p) => (
                  <tr key={p.provider}>
                    <td className="px-4 py-2 font-medium text-chalk sm:pl-5">{p.provider}</td>
                    <td className="px-4 py-2 text-chalk-2">{timeAgo(p.lastSuccessAt)}</td>
                    <td className="max-w-72 px-4 py-2 text-chalk-3" title={p.lastError ?? ""}>
                      {p.lastErrorAt ? `${timeAgo(p.lastErrorAt)}: ${(p.lastError ?? "").slice(0, 80)}` : "—"}
                    </td>
                    <td className="num px-4 py-2 text-chalk-2">{p.consecutiveFailures}</td>
                    <td className="px-4 py-2 text-chalk-3">{p.nextAllowedAt && p.nextAllowedAt > new Date() ? dateTime(p.nextAllowedAt) : "—"}</td>
                    <td className="num px-4 py-2 text-chalk-2">{p.rateLimitHits}</td>
                    <td className="px-4 py-2 text-chalk-3">{dateTime(p.dataAsOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Recent runs" id="runs">
          <ul className="max-h-[420px] divide-y divide-line overflow-y-auto text-[13px]">
            {d.runs.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <Badge tone={r.status === "success" ? "gain" : r.status === "failed" ? "loss" : r.status === "running" ? "sky" : "neutral"}>{r.status}</Badge>
                <span className="min-w-0 flex-1 truncate text-chalk-2">
                  {r.job} <span className="text-chalk-4">{r.provider}, {r.trigger}</span>
                </span>
                <span className="num text-chalk-3">{r.itemsProcessed}</span>
                <span className="w-24 text-right text-chalk-4">{timeAgo(r.startedAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="space-y-4">
          <Panel title="Failed jobs (24h)" id="failures">
            {d.failures.length === 0 ? (
              <p className="text-sm text-chalk-3">No failures in the last 24 hours.</p>
            ) : (
              <ul className="space-y-2 text-[13px]">
                {d.failures.map((f) => (
                  <li key={f.id} className="rounded-md border border-loss/20 p-2.5">
                    <p className="text-chalk">
                      {f.job} <span className="text-chalk-4">{f.provider}, {timeAgo(f.startedAt)}</span>
                    </p>
                    <p className="mt-1 font-mono text-[12px] break-words text-chalk-3">{f.error}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Ledger integrity" id="integrity" action={<Badge tone={d.invariants.healthy ? "gain" : "loss"}>{d.invariants.healthy ? "Healthy" : "Mismatch"}</Badge>}>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <Item label="Cash ≠ ledger" value={String(d.invariants.cashMismatches)} />
              <Item label="Position ≠ trades" value={String(d.invariants.positionMismatches)} />
              <Item label="Trades w/o cash entry" value={String(d.invariants.tradesWithoutCashEntry)} />
            </dl>
          </Panel>
          <Panel title="Usage" id="usage">
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <Item label="Managers" value={String(c.users)} />
              <Item label="Active 24h" value={String(c.active_24h)} />
              <Item label="Leagues" value={String(c.leagues)} />
              <Item label="Trades" value={String(c.trades)} />
              <Item label="Trades 24h" value={String(c.trades_24h)} />
              <Item label="Tradable players" value={`${c.tradable_players} / ${c.players}`} />
            </dl>
          </Panel>
        </div>

        <Panel title="Audit log" id="audit" className="lg:col-span-2">
          <ul className="divide-y divide-line text-[13px]">
            {d.audits.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="w-28 text-chalk-4">{timeAgo(a.createdAt)}</span>
                <Badge>{a.actor}</Badge>
                <span className="font-medium text-chalk">{a.action}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-chalk-4">{a.metadata ? JSON.stringify(a.metadata) : ""}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-chalk-3">{label}</dt>
      <dd className="mt-0.5 truncate text-chalk">{value}</dd>
    </div>
  );
}
