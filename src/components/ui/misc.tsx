import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Panel({ title, action, children, className, bodyClassName, id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section id={id} className={cn("panel min-w-0 scroll-mt-28", className)} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {title ? (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-3 sm:px-5">
          <h2 id={id ? `${id}-title` : undefined} className="text-[15px] font-semibold text-chalk">
            {title}
          </h2>
          {action}
        </header>
      ) : null}
      <div className={cn(title ? "px-4 pb-4 sm:px-5" : "p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "gain" | "loss" | "amber" | "sky" | "lime"; className?: string }) {
  const tones = {
    neutral: "border-line-strong text-chalk-2",
    gain: "border-gain/30 text-gain bg-gain/8",
    loss: "border-loss/30 text-loss bg-loss/8",
    amber: "border-amber/35 text-amber bg-amber/8",
    sky: "border-sky/30 text-sky bg-sky/8",
    lime: "border-lime/35 text-lime bg-lime/8",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] leading-4 font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-pitch-750/70", className)} />;
}

export function EmptyState({ title, body, action, icon }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon ? <div className="mb-3 text-chalk-4">{icon}</div> : null}
      <p className="font-medium text-chalk">{title}</p>
      {body ? <p className="mt-1 max-w-sm text-sm text-chalk-3">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function StatTile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "gain" | "loss" | null }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] text-chalk-3">{label}</p>
      <p className={cn("mt-1 truncate text-xl font-semibold text-chalk", tone === "gain" && "text-gain", tone === "loss" && "text-loss")}>{value}</p>
      {sub ? <p className="mt-0.5 text-[12.5px] text-chalk-3">{sub}</p> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="scoreboard text-4xl text-chalk sm:text-5xl">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm text-chalk-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
