"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Bell, LogOut, Settings, ShieldCheck, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserAvatar } from "@/components/market/atoms";
import { api } from "@/lib/api";

export function UserMenu({ username, displayName, color, isAdmin }: { username: string; displayName: string; color: string; isAdmin: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }
  const item = "flex h-9 cursor-pointer items-center gap-2.5 rounded px-2.5 text-sm text-chalk-2 outline-none data-[highlighted]:bg-pitch-750 data-[highlighted]:text-chalk";
  return (
    <DM.Root>
      <DM.Trigger className="flex items-center gap-2 rounded-full p-0.5 hover:bg-pitch-800" aria-label="Account menu">
        <UserAvatar name={displayName} color={color} size={32} />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={8} className="panel z-50 w-56 p-1.5 shadow-xl shadow-black/50">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium text-chalk">{displayName}</p>
            <p className="truncate text-xs text-chalk-3">@{username}</p>
          </div>
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item asChild className={item}>
            <Link href={`/u/${username}`}>
              <User className="size-4" aria-hidden /> Profile
            </Link>
          </DM.Item>
          <DM.Item asChild className={item}>
            <Link href="/activity">
              <Bell className="size-4" aria-hidden /> Notifications
            </Link>
          </DM.Item>
          <DM.Item asChild className={item}>
            <Link href="/settings">
              <Settings className="size-4" aria-hidden /> Settings
            </Link>
          </DM.Item>
          {isAdmin ? (
            <DM.Item asChild className={item}>
              <Link href="/admin">
                <ShieldCheck className="size-4" aria-hidden /> Admin
              </Link>
            </DM.Item>
          ) : null}
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item className={item} onSelect={(e) => { e.preventDefault(); void signOut(); }} disabled={busy}>
            <LogOut className="size-4" aria-hidden /> Sign out
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
