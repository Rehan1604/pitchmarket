import { Bell } from "lucide-react";
import Link from "next/link";
import { Credits } from "@/components/market/atoms";
import { MarketPulse } from "@/components/shell/market-pulse";
import { MobileNav, SideNav } from "@/components/shell/nav";
import { getShellData } from "@/components/shell/shell-data";
import { Ticker } from "@/components/shell/ticker";
import { UserMenu } from "@/components/shell/user-menu";
import { Wordmark } from "@/components/shell/wordmark";
import { requirePageUser } from "@/server/auth/current-user";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const shell = await getShellData(user.id);
  const isAdmin = user.role === "admin";

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[236px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-pitch-950/40 px-3 py-5 lg:flex">
        <Link href="/dashboard" className="mb-7 px-3">
          <Wordmark name={shell.appName} />
        </Link>
        <SideNav isAdmin={isAdmin} unread={shell.unread} />
        <div className="mt-auto space-y-3 px-3">
          <div className="rounded-md border border-line p-3">
            <p className="text-[12px] text-chalk-3">Cash to trade</p>
            <p className="mt-0.5 text-[15px] font-semibold text-chalk">
              <Credits cents={shell.cashCents} />
            </p>
          </div>
          <p className="text-[11.5px] leading-relaxed text-chalk-4">Virtual Pitch Credits only. No deposits, withdrawals or prizes, ever.</p>
        </div>
      </aside>

      <div className="min-w-0">
        {shell.appMode === "demo" ? (
          <div className="border-b border-amber/20 bg-amber/8 px-4 py-1.5 text-center text-[12.5px] text-amber">
            Demo instance. Accounts marked “Demo account” are sample players, and you can reset your portfolio in Settings.
          </div>
        ) : null}
        <header className="sticky top-0 z-30 border-b border-line bg-pitch-900/90 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <Link href="/dashboard" className="lg:hidden">
              <Wordmark name={shell.appName} compact />
            </Link>
            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <MarketPulse initial={shell.status} />
              <span className="hidden items-center rounded-full border border-line px-3 py-1 text-[12.5px] text-chalk-2 sm:inline-flex lg:hidden">
                <Credits cents={shell.cashCents} decimals={0} />
              </span>
              <Link href="/activity" className="relative rounded-full p-2 text-chalk-3 hover:bg-pitch-800 hover:text-chalk" aria-label={`Notifications${shell.unread ? `, ${shell.unread} unread` : ""}`}>
                <Bell className="size-[18px]" aria-hidden />
                {shell.unread > 0 ? <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-lime ring-2 ring-pitch-900" aria-hidden /> : null}
              </Link>
              <UserMenu username={user.username} displayName={user.displayName} color={user.avatarColor} isAdmin={isAdmin} />
            </div>
          </div>
          <Ticker items={shell.ticker} />
        </header>
        <main id="main" className="mx-auto w-full max-w-[1320px] px-4 pt-6 pb-28 sm:px-6 lg:pb-12">
          {children}
        </main>
      </div>
      <MobileNav unread={shell.unread} />
    </div>
  );
}
