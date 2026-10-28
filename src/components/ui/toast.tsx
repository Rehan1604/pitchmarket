"use client";

import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "success" | "error" | "info";
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}

const Ctx = createContext<{ push: (t: Omit<ToastItem, "id">) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:pr-6">
        {items.map((t) => {
          const Icon = t.tone === "success" ? CheckCircle2 : t.tone === "error" ? TriangleAlert : Info;
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : "status"}
              className={cn(
                "panel pointer-events-auto flex w-full max-w-sm items-start gap-3 border-l-2 p-3.5 shadow-xl shadow-black/40",
                t.tone === "success" && "border-l-gain",
                t.tone === "error" && "border-l-loss",
                t.tone === "info" && "border-l-sky",
              )}
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", t.tone === "success" ? "text-gain" : t.tone === "error" ? "text-loss" : "text-sky")} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-chalk">{t.title}</p>
                {t.body ? <p className="mt-0.5 text-[13px] text-chalk-3">{t.body}</p> : null}
              </div>
              <button onClick={() => dismiss(t.id)} className="rounded p-0.5 text-chalk-4 hover:text-chalk" aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx.push;
}
