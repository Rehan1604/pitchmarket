"use client";

import { Lock, Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateTime } from "@/lib/format";
import { feeForGross, formatCredits } from "@/lib/money";

export interface TicketProps {
  playerId: number;
  playerName: string;
  priceCents: number;
  cashCents: number;
  heldQuantity: number;
  avgCostCents: number;
  feeBps: number;
  maxQuantity: number;
  buyBlocked: string | null;
  sellBlocked: string | null;
  blockMessage: string | null;
  defaultSide?: "buy" | "sell";
}

interface Receipt {
  id: string;
  side: "buy" | "sell";
  quantity: number;
  priceCents: number;
  grossCents: number;
  feeCents: number;
  cashDeltaCents: number;
  realizedPnlCents: number;
  cashAfterCents: number;
  positionAfterQty: number;
  marketVersion: number;
  createdAt: string;
  replayed: boolean;
}

export function TradeTicket(props: TicketProps) {
  const router = useRouter();
  const toast = useToast();
  const [side, setSide] = useState<"buy" | "sell">(props.defaultSide ?? (props.heldQuantity > 0 && props.buyBlocked ? "sell" : "buy"));
  const [qtyText, setQtyText] = useState("1");
  const [price, setPrice] = useState(props.priceCents);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<{ from: number; to: number } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const keyRef = useRef<string | null>(null);

  // Follow server price updates (router.refresh after a market tick) unless an order is being reviewed.
  const [syncedPrice, setSyncedPrice] = useState(props.priceCents);
  if (props.priceCents !== syncedPrice && !open) {
    setSyncedPrice(props.priceCents);
    setPrice(props.priceCents);
  }

  const qty = Math.max(0, Math.floor(Number(qtyText) || 0));
  const gross = qty * price;
  const fee = feeForGross(gross, props.feeBps);
  const total = side === "buy" ? gross + fee : gross - fee;
  const maxAffordable = useMemo(() => {
    let n = Math.floor(props.cashCents / price);
    while (n > 0 && n * price + feeForGross(n * price, props.feeBps) > props.cashCents) n--;
    return Math.min(n, props.maxQuantity);
  }, [props.cashCents, price, props.feeBps, props.maxQuantity]);
  const blocked = side === "buy" ? props.buyBlocked : props.sellBlocked;

  let problem: string | null = null;
  if (qty < 1) problem = "Enter at least 1 share.";
  else if (qty > props.maxQuantity) problem = `Orders are limited to ${props.maxQuantity.toLocaleString("en-GB")} shares.`;
  else if (side === "buy" && total > props.cashCents) problem = `You can afford up to ${maxAffordable.toLocaleString("en-GB")} shares.`;
  else if (side === "sell" && qty > props.heldQuantity) problem = props.heldQuantity === 0 ? "You don't hold any shares in this player." : `You hold ${props.heldQuantity} shares.`;

  function review() {
    setError(null);
    setMoved(null);
    setReceipt(null);
    keyRef.current = newIdempotencyKey();
    setOpen(true);
  }

  async function submit() {
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ receipt: Receipt }>("/api/trades", {
        body: { playerId: props.playerId, side, quantity: qty, idempotencyKey: keyRef.current, expectedPriceCents: price },
      });
      setReceipt(res.receipt);
      toast({
        tone: "success",
        title: `${res.receipt.side === "buy" ? "Bought" : "Sold"} ${res.receipt.quantity} × ${props.playerName}`,
        body: `At ${formatCredits(res.receipt.priceCents)} PC per share.`,
      });
      keyRef.current = null;
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "PRICE_CHANGED" && typeof e.details?.currentPriceCents === "number") {
        setMoved({ from: price, to: e.details.currentPriceCents });
        setPrice(e.details.currentPriceCents);
        keyRef.current = newIdempotencyKey(); // a new order at the new price
      } else {
        setError(e instanceof ApiError ? e.message : "The order didn't go through. Nothing was charged.");
      }
    } finally {
      setBusy(false);
    }
  }

  const avgAfter = side === "buy" && props.heldQuantity + qty > 0 ? Math.round((props.avgCostCents * props.heldQuantity + total) / (props.heldQuantity + qty)) : props.avgCostCents;

  return (
    <div>
      <div className="grid grid-cols-2 rounded-md border border-line-strong p-0.5" role="tablist" aria-label="Order side">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
            className={cn("h-9 rounded text-sm font-medium capitalize", side === s ? (s === "buy" ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss") : "text-chalk-3 hover:text-chalk")}
          >
            {s}
          </button>
        ))}
      </div>

      {blocked ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-md border border-amber/25 bg-amber/6 p-3 text-sm text-chalk-2">
          <Lock className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden />
          <span>{props.blockMessage ?? "Trading is unavailable right now."}</span>
        </div>
      ) : null}

      <label htmlFor="qty" className="mt-5 mb-1.5 block text-[13px] font-medium text-chalk-2">
        Shares
      </label>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setQtyText(String(Math.max(1, qty - 1)))} className="flex size-10 items-center justify-center rounded-md border border-line-strong text-chalk-2 hover:bg-pitch-800" aria-label="One fewer share">
          <Minus className="size-4" aria-hidden />
        </button>
        <input
          id="qty"
          inputMode="numeric"
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value.replace(/[^0-9]/g, "").slice(0, 7))}
          className="num h-10 w-full rounded-md border border-line-strong bg-pitch-950/60 px-3 text-center text-lg font-semibold text-chalk focus:border-lime focus:outline-none"
          aria-describedby="qty-help"
        />
        <button type="button" onClick={() => setQtyText(String(qty + 1))} className="flex size-10 items-center justify-center rounded-md border border-line-strong text-chalk-2 hover:bg-pitch-800" aria-label="One more share">
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
      <div id="qty-help" className="mt-2 flex flex-wrap gap-2 text-[12.5px]">
        {side === "buy"
          ? [1, 5, 10].map((n) => (
              <button key={n} type="button" onClick={() => setQtyText(String(n))} className="rounded-full border border-line px-2.5 py-0.5 text-chalk-3 hover:text-chalk">
                {n}
              </button>
            ))
          : null}
        {side === "buy" && maxAffordable > 0 ? (
          <button type="button" onClick={() => setQtyText(String(maxAffordable))} className="rounded-full border border-line px-2.5 py-0.5 text-chalk-3 hover:text-chalk">
            Max {maxAffordable.toLocaleString("en-GB")}
          </button>
        ) : null}
        {side === "sell" && props.heldQuantity > 0 ? (
          <button type="button" onClick={() => setQtyText(String(props.heldQuantity))} className="rounded-full border border-line px-2.5 py-0.5 text-chalk-3 hover:text-chalk">
            All {props.heldQuantity}
          </button>
        ) : null}
      </div>

      <dl className="mt-5 space-y-2 text-sm">
        <Row label="Market price" value={`${formatCredits(price)} PC`} />
        <Row label={`${qty.toLocaleString("en-GB")} × price`} value={`${formatCredits(gross)} PC`} />
        <Row label={props.feeBps ? `Fee (${(props.feeBps / 100).toFixed(2)}%)` : "Fee"} value={props.feeBps ? `${formatCredits(fee)} PC` : "None"} />
        <div className="border-t border-line pt-2">
          <Row label={side === "buy" ? "Estimated cost" : "Estimated proceeds"} value={`${formatCredits(total)} PC`} strong />
        </div>
        <Row label="Cash after" value={`${formatCredits(props.cashCents + (side === "buy" ? -total : total))} PC`} muted />
      </dl>

      {problem && qtyText !== "" ? <p className="mt-3 text-[13px] text-amber">{problem}</p> : null}

      <Button variant={side === "buy" ? "gain" : "loss"} size="lg" className="mt-5 w-full" onClick={review} disabled={Boolean(problem) || Boolean(blocked)}>
        Review {side} order
      </Button>
      <p className="mt-2 text-center text-[12px] text-chalk-4">Market order. Executes at the server price when you confirm.</p>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)} title={receipt ? "Order filled" : `Confirm ${side} order`} description={receipt ? undefined : "Virtual Pitch Credits only. No real money."}>
        {receipt ? (
          <div>
            <dl className="space-y-2 text-sm">
              <Row label="Order" value={`${receipt.side === "buy" ? "Bought" : "Sold"} ${receipt.quantity} × ${props.playerName}`} strong />
              <Row label="Execution price" value={`${formatCredits(receipt.priceCents)} PC`} />
              <Row label="Fee" value={`${formatCredits(receipt.feeCents)} PC`} />
              <Row label={receipt.side === "buy" ? "Total paid" : "Total received"} value={`${formatCredits(Math.abs(receipt.cashDeltaCents))} PC`} strong />
              {receipt.side === "sell" ? <Row label="Realised profit/loss" value={`${formatCredits(receipt.realizedPnlCents, { sign: true })} PC`} /> : null}
              <Row label="Cash now" value={`${formatCredits(receipt.cashAfterCents)} PC`} />
              <Row label="Shares now" value={receipt.positionAfterQty.toLocaleString("en-GB")} />
              <Row label="Time" value={dateTime(receipt.createdAt)} muted />
              <Row label="Receipt" value={receipt.id.slice(0, 8).toUpperCase()} muted />
              <Row label="Market version" value={String(receipt.marketVersion)} muted />
            </dl>
            <Button variant="secondary" className="mt-5 w-full" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        ) : (
          <div>
            {moved ? (
              <div role="alert" className="mb-4 rounded-md border border-amber/30 bg-amber/8 p-3 text-sm text-chalk-2">
                The price moved from {formatCredits(moved.from)} to <strong className="text-chalk">{formatCredits(moved.to)} PC</strong> before your order reached the market. Nothing was traded. Confirm again to trade at the new price.
              </div>
            ) : null}
            <dl className="space-y-2 text-sm">
              <Row label="Player" value={props.playerName} strong />
              <Row label="Side" value={side === "buy" ? "Buy" : "Sell"} />
              <Row label="Shares" value={qty.toLocaleString("en-GB")} />
              <Row label="Price per share" value={`${formatCredits(price)} PC`} />
              <Row label="Fee" value={`${formatCredits(fee)} PC`} />
              <Row label={side === "buy" ? "Total cost" : "Total proceeds"} value={`${formatCredits(total)} PC`} strong />
              {side === "buy" ? <Row label="Average cost after" value={`${formatCredits(avgAfter)} PC`} muted /> : null}
            </dl>
            <div className="mt-4">
              <FormError message={error} />
            </div>
            <div className="mt-5 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant={side === "buy" ? "gain" : "loss"} className="flex-1" onClick={submit} loading={busy}>
                Confirm {side}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className={cn("text-chalk-3", muted && "text-chalk-4")}>{label}</dt>
      <dd className={cn("num text-right", strong ? "font-semibold text-chalk" : muted ? "text-chalk-3" : "text-chalk-2")}>{value}</dd>
    </div>
  );
}
