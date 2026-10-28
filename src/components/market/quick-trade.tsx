"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TradeTicket, type TicketProps } from "./trade-ticket";

/** Opens the full trade ticket in a dialog (used from portfolio rows). */
export function QuickTrade({ label = "Sell", side = "sell", ticket }: { label?: string; side?: "buy" | "sell"; ticket: TicketProps }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={side === "sell" ? "danger" : "secondary"} onClick={() => setOpen(true)} aria-label={`${label} ${ticket.playerName}`}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={`Trade ${ticket.playerName}`}>
        <TradeTicket {...ticket} defaultSide={side} />
      </Dialog>
    </>
  );
}
