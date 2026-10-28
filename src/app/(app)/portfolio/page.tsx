import { Briefcase } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Change, Credits, PlayerMark, PositionBadge } from "@/components/market/atoms";
import { QuickTrade } from "@/components/market/quick-trade";
import { ValueChart } from "@/components/market/value-chart";
import { ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState, PageHeader, Panel, StatTile } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { nowMs } from "@/lib/clock";
import { dateTime } from "@/lib/format";
import { formatCredits, formatPct } from "@/lib/money";
import { requirePageUser } from "@/server/auth/current-user";
import { getPortfolio, getTrades, getValueHistory } from "@/server/portfolio/valuation";
import { quote } from "@/server/trading/service";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const user = await requirePageUser();
  const { before } = await searchParams;
  const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined;
  const [pf, history, trades] = await Promise.all([getPortfolio(user.id), getValueHistory(user.id, 120), getTrades(user.id, { limit: 50, before: beforeDate })]);
  if (!pf) return null;
  const quotes = await Promise.all(pf.holdings.map((h) => quote(user.id, h.playerId)));
  const points = [
    ...history.map((h) => ({ t: Date.parse(`${h.day}T00:00:00Z`), value: h.valueCents, label: `Start of ${new Date(`${h.day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` })),
    { t: nowMs(), value: pf.totalValueCents, label: "Now" },
  ];
  const cashBps = pf.totalValueCents > 0 ? Math.round((pf.cashCents / pf.totalValueCents) * 10_000) : 0;
  const lastTrade = trades[trades.length - 1];

  return (
    <>
      <PageHeader title="Portfolio" description="Valued at current market prices. Profit and loss include any trading fees." />

      <section className="panel mb-4 min-w-0 p-5 sm:p-7" aria-label="Summary">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <p className="scoreboard text-[56px] text-chalk sm:text-[72px]">
            {formatCredits(pf.totalValueCents)}
            <span className="ml-2 align-top font-sans text-base font-medium text-chalk-3">PC</span>
          </p>
          <div className="pb-2">
            <Change bps={pf.returnBps} size="lg" />
            <p className="text-[12.5px] text-chalk-3">total return, {formatCredits(pf.totalReturnCents, { sign: true })} PC</p>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-5 border-t border-line pt-5 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Cash" value={<Credits cents={pf.cashCents} decimals={0} />} />
          <StatTile label="Invested (cost)" value={<Credits cents={pf.costBasisCents} decimals={0} />} />
          <StatTile label="Holdings value" value={<Credits cents={pf.holdingsValueCents} decimals={0} />} />
          <StatTile label="Unrealized" value={<Credits cents={pf.unrealizedCents} decimals={0} sign />} tone={pf.unrealizedCents > 0 ? "gain" : pf.unrealizedCents < 0 ? "loss" : null} />
          <StatTile label="Realized" value={<Credits cents={pf.realizedCents} decimals={0} sign />} tone={pf.realizedCents > 0 ? "gain" : pf.realizedCents < 0 ? "loss" : null} />
          <StatTile label="Starting balance" value={<Credits cents={pf.startingCents} decimals={0} />} />
        </div>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_380px]">
        <Panel title="Holdings" id="holdings">
          {pf.holdings.length === 0 ? (
            <EmptyState icon={<Briefcase className="size-6" />} title="No holdings yet" body="All your credits are in cash. Buy shares in players you rate." action={<ButtonLink href="/market" variant="primary" size="sm">Open the market</ButtonLink>} />
          ) : (
            <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
              <table className="w-full min-w-[760px] text-sm">
                <caption className="sr-only">Current holdings</caption>
                <thead>
                  <tr className="hairline-b text-left text-[12.5px] text-chalk-3">
                    <th scope="col" className="px-4 py-2 font-medium sm:px-5">Player</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Shares</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Avg cost</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Value</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Unrealized</th>
                    <th scope="col" className="px-4 py-2 font-medium sm:px-5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {pf.holdings.map((h, i) => {
                    const q = quotes[i];
                    return (
                      <tr key={h.playerId}>
                        <td className="px-4 py-2.5 sm:px-5">
                          <Link href={`/players/${h.slug}`} className="flex items-center gap-3 hover:underline">
                            <PlayerMark name={h.name} position={h.position} size={30} />
                            <span>
                              <span className="block font-medium text-chalk">{h.name}</span>
                              <span className="flex items-center gap-1.5 text-xs text-chalk-3">
                                <PositionBadge position={h.position} /> {h.club}
                                {!h.isTradable ? <span className="text-chalk-4">sell only</span> : null}
                              </span>
                            </span>
                          </Link>
                        </td>
                        <td className="num px-3 py-2.5 text-right text-chalk">{h.quantity.toLocaleString("en-GB")}</td>
                        <td className="num px-3 py-2.5 text-right text-chalk-2">{formatCredits(h.avgCostCents)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="num block text-chalk">{formatCredits(h.priceCents)}</span>
                          <Change from={h.previousPriceCents} to={h.priceCents} className="text-xs" />
                        </td>
                        <td className="num px-3 py-2.5 text-right text-chalk">{formatCredits(h.valueCents)}</td>
                        <td className={cn("num px-3 py-2.5 text-right", h.unrealizedCents > 0 ? "text-gain" : h.unrealizedCents < 0 ? "text-loss" : "text-chalk-2")}>
                          {formatCredits(h.unrealizedCents, { sign: true })}
                          <span className="block text-xs">{formatPct(h.unrealizedBps)}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right sm:px-5">
                          <QuickTrade
                            ticket={{
                              playerId: h.playerId,
                              playerName: h.name,
                              priceCents: q.priceCents,
                              cashCents: q.cashCents ?? 0,
                              heldQuantity: q.heldQuantity,
                              avgCostCents: h.avgCostCents,
                              feeBps: q.feeBps,
                              maxQuantity: q.maxQuantity,
                              buyBlocked: q.buyBlocked,
                              sellBlocked: q.sellBlocked,
                              blockMessage: q.blockMessage,
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Allocation" id="allocation">
            <ul className="space-y-3" aria-label="Share of portfolio value">
              {[{ key: "cash", name: "Cash", bps: cashBps, value: pf.cashCents, cash: true }, ...pf.holdings.slice(0, 9).map((h) => ({ key: String(h.playerId), name: h.name, bps: h.allocationBps, value: h.valueCents, cash: false }))].map((a) => (
                <li key={a.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="truncate text-chalk-2">{a.name}</span>
                    <span className="num text-chalk">
                      {(a.bps / 100).toFixed(1)}%<span className="ml-2 text-chalk-4">{formatCredits(a.value, { decimals: 0 })}</span>
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-pitch-750" aria-hidden>
                    <div className={cn("h-full rounded-r-[4px] rounded-l-full", a.cash ? "bg-chalk-4" : "bg-sky")} style={{ width: `${Math.max(a.bps > 0 ? 1 : 0, a.bps / 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
            {pf.holdings.length > 9 ? <p className="mt-3 text-[12.5px] text-chalk-4">Plus {pf.holdings.length - 9} smaller holdings, listed in the table.</p> : null}
          </Panel>
          <Panel title="Value over time" id="value">
            {points.length < 2 ? (
              <EmptyState title="History builds daily" body="A snapshot of your portfolio is taken at the start of each day (UTC). Your chart appears after the first one." />
            ) : (
              <ValueChart points={points} startingCents={pf.startingCents} />
            )}
          </Panel>
        </div>
      </div>

      <Panel title="Transaction history" id="history" className="mt-4" action={<span className="text-[12.5px] text-chalk-4">Immutable ledger, newest first</span>}>
        {trades.length === 0 ? (
          <EmptyState title={beforeDate ? "No older trades" : "No trades yet"} />
        ) : (
          <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[860px] text-sm">
              <caption className="sr-only">Trade receipts</caption>
              <thead>
                <tr className="hairline-b text-left text-[12.5px] text-chalk-3">
                  <th scope="col" className="px-4 py-2 font-medium sm:px-5">Time (UTC)</th>
                  <th scope="col" className="px-3 py-2 font-medium">Order</th>
                  <th scope="col" className="px-3 py-2 font-medium">Player</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Fee</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Cash change</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Realized</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-2.5 text-chalk-3 sm:px-5">{dateTime(t.createdAt).replace(" UTC", "")}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={t.side === "buy" ? "sky" : "amber"}>
                        {t.side === "buy" ? "Buy" : "Sell"} {t.quantity}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link href={`/players/${t.playerSlug}`} className="text-chalk hover:underline">
                        {t.playerName}
                      </Link>
                    </td>
                    <td className="num px-3 py-2.5 text-right text-chalk-2">{formatCredits(t.priceCents)}</td>
                    <td className="num px-3 py-2.5 text-right text-chalk-3">{formatCredits(t.feeCents)}</td>
                    <td className="num px-3 py-2.5 text-right text-chalk">{formatCredits(t.cashDeltaCents, { sign: true })}</td>
                    <td className={cn("num px-3 py-2.5 text-right", t.side === "sell" ? (t.realizedPnlCents >= 0 ? "text-gain" : "text-loss") : "text-chalk-4")}>
                      {t.side === "sell" ? formatCredits(t.realizedPnlCents, { sign: true }) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-chalk-4 sm:px-5" title={`Trade ${t.id}, market version ${t.marketVersion}`}>
                      {t.id.slice(0, 8).toUpperCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {trades.length === 50 && lastTrade ? (
          <div className="mt-3">
            <ButtonLink href={`/portfolio?before=${encodeURIComponent(new Date(lastTrade.createdAt).toISOString())}#history`} size="sm">
              Older trades
            </ButtonLink>
          </div>
        ) : beforeDate ? (
          <div className="mt-3">
            <ButtonLink href="/portfolio#history" size="sm">
              Back to latest
            </ButtonLink>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
