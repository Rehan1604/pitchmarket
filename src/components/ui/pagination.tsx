import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const link = (p: number, label: React.ReactNode, disabled: boolean, aria: string) =>
    disabled ? (
      <span className="inline-flex h-9 items-center gap-1 rounded-md px-3 text-sm text-chalk-4" aria-disabled>
        {label}
      </span>
    ) : (
      <Link href={hrefFor(p)} scroll={false} aria-label={aria} className={cn("inline-flex h-9 items-center gap-1 rounded-md border border-line-strong px-3 text-sm text-chalk-2 hover:bg-pitch-800 hover:text-chalk")}>
        {label}
      </Link>
    );
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
      <p className="text-[13px] text-chalk-3">
        {from.toLocaleString("en-GB")}–{to.toLocaleString("en-GB")} of {total.toLocaleString("en-GB")}
      </p>
      <div className="flex items-center gap-2">
        {link(page - 1, <><ChevronLeft className="size-4" aria-hidden /> Previous</>, page <= 1, "Previous page")}
        <span className="num px-1 text-[13px] text-chalk-3">
          {page} / {pages}
        </span>
        {link(page + 1, <>Next <ChevronRight className="size-4" aria-hidden /></>, page >= pages, "Next page")}
      </div>
    </nav>
  );
}
