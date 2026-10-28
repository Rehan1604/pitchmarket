"use client";

import { Activity, BarChart3, Briefcase, CalendarDays, LayoutDashboard, Settings, ShieldCheck, Trophy, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/market", label: "Market", icon: BarChart3 },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/social", label: "Friends & leagues", icon: Users },
  { href: "/fixtures", label: "Fixtures", icon: CalendarDays },
  { href: "/activity", label: "Activity", icon: Activity },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/market") return pathname === "/market" || pathname.startsWith("/players/");
  if (href === "/social") return pathname.startsWith("/social") || pathname.startsWith("/leagues") || pathname.startsWith("/u/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SideNav({ isAdmin, unread }: { isAdmin: boolean; unread: number }) {
  const pathname = usePathname();
  const items = [...NAV, { href: "/settings", label: "Settings", icon: Settings }, ...(isAdmin ? [{ href: "/admin", label: "Admin", icon: ShieldCheck }] : [])];
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex h-10 items-center gap-3 rounded-md px-3 text-[14px] transition-colors",
              active ? "bg-pitch-750 text-chalk" : "text-chalk-3 hover:bg-pitch-800 hover:text-chalk",
            )}
          >
            {active ? <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-lime" /> : null}
            <Icon className={cn("size-[18px]", active ? "text-lime" : "text-chalk-4 group-hover:text-chalk-2")} aria-hidden />
            <span className="flex-1">{label}</span>
            {href === "/activity" && unread > 0 ? (
              <span className="rounded-full bg-lime px-1.5 text-[11px] font-semibold text-pitch-950" aria-label={`${unread} unread`}>
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav({ unread }: { unread: number }) {
  const pathname = usePathname();
  const items = [NAV[0], NAV[1], NAV[2], NAV[3], { href: "/social", label: "Social", icon: Users }];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-pitch-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <ul className="grid grid-cols-5">
        {items.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link href={href} aria-current={active ? "page" : undefined} className={cn("relative flex h-14 flex-col items-center justify-center gap-1 text-[10.5px]", active ? "text-lime" : "text-chalk-3")}>
                <Icon className="size-5" aria-hidden />
                {label.split(" ")[0]}
                {href === "/social" && unread > 0 ? <span className="absolute top-2 right-[calc(50%-16px)] size-2 rounded-full bg-lime" aria-label={`${unread} unread notifications`} /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
