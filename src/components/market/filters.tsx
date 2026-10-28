"use client";

import { Search, Star, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";

const POSITIONS = [
  { v: "", label: "All" },
  { v: "GK", label: "GK" },
  { v: "DEF", label: "DEF" },
  { v: "MID", label: "MID" },
  { v: "FWD", label: "FWD" },
];

const SORTS = [
  { v: "price:desc", label: "Price, high to low" },
  { v: "price:asc", label: "Price, low to high" },
  { v: "change:desc", label: "Biggest risers" },
  { v: "change:asc", label: "Biggest fallers" },
  { v: "form:desc", label: "Best recent form" },
  { v: "quality:desc", label: "Best season rating" },
  { v: "held:desc", label: "Most held by managers" },
  { v: "name:asc", label: "Name, A to Z" },
];

export function MarketFilters({ clubs, competitions = [] }: { clubs: { id: number; name: string }[]; competitions?: { code: string; name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
  const first = useRef(true);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => update({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const position = params.get("position") ?? "";
  const sort = `${params.get("sort") ?? "price"}:${params.get("dir") ?? "desc"}`;
  const watch = params.get("watchlist") === "1";
  const club = params.get("club") ?? "";
  const minPrice = params.get("minPrice") ?? "";
  const maxPrice = params.get("maxPrice") ?? "";
  const competition = (params.get("competition") ?? "").toUpperCase();
  const active = Boolean(params.get("q") || position || club || watch || minPrice || maxPrice || competition);

  return (
    <div className={cn("mb-4 flex flex-col gap-3 transition-opacity", pending && "opacity-70")} role="search" aria-label="Filter players">
      {competitions.length > 1 ? (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="League">
          {[{ code: "", name: "All leagues" }, ...competitions].map((c) => (
            <button
              key={c.code || "all"}
              type="button"
              aria-pressed={competition === c.code}
              onClick={() => update({ competition: c.code || null, club: null })}
              className={cn(
                "h-8 shrink-0 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap",
                competition === c.code ? "border-lime/40 bg-lime/10 text-lime" : "border-line-strong text-chalk-3 hover:text-chalk",
              )}
            >
              {c.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-chalk-4" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players or clubs" aria-label="Search players or clubs" className="pl-9" />
        </div>
        <div className="flex rounded-md border border-line-strong p-0.5" role="group" aria-label="Position">
          {POSITIONS.map((p) => (
            <button
              key={p.v}
              type="button"
              aria-pressed={position === p.v}
              onClick={() => update({ position: p.v || null })}
              className={cn("h-8 flex-1 rounded px-3 text-[13px] font-medium md:flex-none", position === p.v ? "bg-pitch-700 text-chalk" : "text-chalk-3 hover:text-chalk")}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Select aria-label="Club" value={club} onChange={(e) => update({ club: e.target.value || null })} className="md:w-48">
          <option value="">All clubs</option>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Sort"
          value={sort}
          onChange={(e) => {
            const [s, d] = e.target.value.split(":");
            update({ sort: s, dir: d });
          }}
          className="md:w-56"
        >
          {SORTS.map((s) => (
            <option key={s.v} value={s.v}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <label className="flex items-center gap-2 text-chalk-3">
          Price
          <Input type="number" inputMode="numeric" min={0} placeholder="Min" aria-label="Minimum price" defaultValue={minPrice} onBlur={(e) => update({ minPrice: e.target.value || null })} className="h-8 w-24" />
          <span aria-hidden>–</span>
          <Input type="number" inputMode="numeric" min={0} placeholder="Max" aria-label="Maximum price" defaultValue={maxPrice} onBlur={(e) => update({ maxPrice: e.target.value || null })} className="h-8 w-24" />
        </label>
        <button
          type="button"
          aria-pressed={watch}
          onClick={() => update({ watchlist: watch ? null : "1" })}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3", watch ? "border-lime/40 text-lime" : "border-line-strong text-chalk-3 hover:text-chalk")}
        >
          <Star className={cn("size-3.5", watch && "fill-lime")} aria-hidden /> Watchlist only
        </button>
        {active ? (
          <button type="button" onClick={() => { setQ(""); startTransition(() => router.replace(pathname, { scroll: false })); }} className="inline-flex items-center gap-1 text-chalk-3 hover:text-chalk">
            <X className="size-3.5" aria-hidden /> Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
