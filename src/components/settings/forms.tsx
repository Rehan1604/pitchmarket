"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserAvatar } from "@/components/market/atoms";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";

function useSave() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(endpoint: string, method: "PATCH" | "POST", body: unknown, ok: string) {
    setBusy(true);
    setError(null);
    try {
      await api(endpoint, { method, body });
      toast({ tone: "success", title: ok });
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save };
}

export function ProfileForm({ displayName, bio, color, colors }: { displayName: string; bio: string | null; color: string; colors: string[] }) {
  const { busy, error, save } = useSave();
  const [name, setName] = useState(displayName);
  const [c, setC] = useState(color);
  const [b, setB] = useState(bio ?? "");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save("/api/settings/profile", "PATCH", { displayName: name, bio: b, avatarColor: c }, "Profile saved");
      }}
    >
      <FormError message={error} />
      <div className="flex items-center gap-4">
        <UserAvatar name={name || "?"} color={c} size={48} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Avatar colour">
          {colors.map((x) => (
            <button key={x} type="button" aria-pressed={c === x} aria-label={`Colour ${x}`} onClick={() => setC(x)} className={cn("size-7 rounded-full ring-offset-2 ring-offset-pitch-850", c === x ? "ring-2 ring-chalk" : "hover:ring-2 hover:ring-chalk-4")} style={{ background: x }} />
          ))}
        </div>
      </div>
      <Field label="Display name" htmlFor="s-name">
        <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
      </Field>
      <Field label="Bio" htmlFor="s-bio" hint="Shown on your profile. 160 characters.">
        <Textarea id="s-bio" value={b} onChange={(e) => setB(e.target.value)} maxLength={160} />
      </Field>
      <Button type="submit" loading={busy}>
        Save profile
      </Button>
    </form>
  );
}

export function PrivacyForm(props: { portfolioVisibility: string; activityVisibility: string; showOnGlobalLeaderboard: boolean }) {
  const { busy, error, save } = useSave();
  const [pv, setPv] = useState(props.portfolioVisibility);
  const [av, setAv] = useState(props.activityVisibility);
  const [g, setG] = useState(props.showOnGlobalLeaderboard);
  const opts = (
    <>
      <option value="public">Everyone</option>
      <option value="friends">Friends only</option>
      <option value="private">Only me</option>
    </>
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save("/api/settings/privacy", "PATCH", { portfolioVisibility: pv, activityVisibility: av, showOnGlobalLeaderboard: g }, "Privacy settings saved");
      }}
    >
      <FormError message={error} />
      <Field label="Who can see your holdings and cash" htmlFor="p-port" hint="Your portfolio value and return are always visible where you appear on a leaderboard.">
        <Select id="p-port" value={pv} onChange={(e) => setPv(e.target.value)}>
          {opts}
        </Select>
      </Field>
      <Field label="Who can see your trades and activity" htmlFor="p-act">
        <Select id="p-act" value={av} onChange={(e) => setAv(e.target.value)}>
          {opts}
        </Select>
      </Field>
      <Checkbox checked={g} onChange={(e) => setG(e.target.checked)} label="Show me on the global leaderboard (friends and league boards always include you)" />
      <p className="text-[12.5px] text-chalk-4">Your email address is never shown to other managers.</p>
      <Button type="submit" loading={busy}>
        Save privacy settings
      </Button>
    </form>
  );
}

export function NotificationsForm(props: { notifyTrades: boolean; notifySocial: boolean; notifyRank: boolean }) {
  const { busy, error, save } = useSave();
  const [t, setT] = useState(props.notifyTrades);
  const [s, setS] = useState(props.notifySocial);
  const [r, setR] = useState(props.notifyRank);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save("/api/settings/notifications", "PATCH", { notifyTrades: t, notifySocial: s, notifyRank: r }, "Notification preferences saved");
      }}
    >
      <FormError message={error} />
      <Checkbox checked={t} onChange={(e) => setT(e.target.checked)} label="Trade confirmations and big price moves on players I hold" />
      <Checkbox checked={s} onChange={(e) => setS(e.target.checked)} label="Friend requests, league invites and new league members" />
      <Checkbox checked={r} onChange={(e) => setR(e.target.checked)} label="Big changes in my global rank" />
      <Button type="submit" loading={busy} className="mt-2">
        Save preferences
      </Button>
    </form>
  );
}

export function PasswordForm() {
  const { busy, error, save } = useSave();
  const [done, setDone] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const ok = await save("/api/settings/password", "POST", { currentPassword: f.get("current"), newPassword: f.get("next") }, "Password changed. Other devices were signed out.");
        if (ok) {
          form.reset();
          setDone(true);
        }
      }}
    >
      <FormError message={error} />
      <Field label="Current password" htmlFor="pw-current">
        <Input id="pw-current" name="current" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="New password" htmlFor="pw-next" hint="At least 10 characters.">
        <Input id="pw-next" name="next" type="password" autoComplete="new-password" required minLength={10} />
      </Field>
      <Button type="submit" loading={busy}>
        Change password
      </Button>
      {done ? <p className="text-[13px] text-gain">Password updated.</p> : null}
    </form>
  );
}

export function DemoReset() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await api("/api/portfolio/reset", { method: "POST", body: {} });
      toast({ tone: "success", title: "Portfolio reset to your starting balance" });
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast({ tone: "error", title: e instanceof ApiError ? e.message : "Reset failed." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Reset demo portfolio
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Reset your portfolio?" description="All holdings are sold at current prices and your cash returns to the starting balance. Your trade history stays in the ledger.">
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" className="flex-1" loading={busy} onClick={run}>
            Reset portfolio
          </Button>
        </div>
      </Dialog>
    </>
  );
}

export function DeleteAccount() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete account
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Delete your account?" description="Your profile, friends, league memberships and notifications are removed and your name is anonymised. Leagues you own pass to another member. This can't be undone.">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError(null);
            try {
              await api("/api/settings/delete", { body: { password: f.get("password"), confirm: f.get("confirm") } });
              router.push("/");
              router.refresh();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Couldn't delete the account.");
              setBusy(false);
            }
          }}
        >
          <FormError message={error} />
          <Field label="Password" htmlFor="del-pw">
            <Input id="del-pw" name="password" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="Type DELETE to confirm" htmlFor="del-confirm">
            <Input id="del-confirm" name="confirm" required autoComplete="off" />
          </Field>
          <Button type="submit" variant="danger" className="w-full" loading={busy}>
            Delete my account
          </Button>
        </form>
      </Dialog>
    </>
  );
}
