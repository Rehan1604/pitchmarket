"use client";

import { Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";

export function WatchButton({ playerId, name, watched, withLabel }: { playerId: number; name: string; watched: boolean; withLabel?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [on, setOn] = useState(watched);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      await api("/api/watchlist", { body: { playerId, watched: next } });
      router.refresh();
    } catch (e) {
      setOn(!next);
      toast({ tone: "error", title: "Watchlist not updated", body: e instanceof ApiError ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from watchlist` : `Add ${name} to watchlist`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md p-1.5 transition-colors",
        on ? "text-lime" : "text-chalk-4 hover:text-chalk-2",
        withLabel && "h-10 border border-line-strong px-3 text-sm",
      )}
    >
      <Star className={cn("size-4", on && "fill-lime")} aria-hidden />
      {withLabel ? (on ? "Watching" : "Watch") : null}
    </button>
  );
}
