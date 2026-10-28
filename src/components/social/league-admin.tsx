"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { CopyField } from "./social-forms";

export function NewInvite({ leagueId, friends }: { leagueId: string; friends: { username: string; displayName: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const friend = String(f.get("friend") || "");
      const res = await api<{ invite: { url: string } }>(`/api/leagues/${leagueId}/invites`, {
        body: {
          maxUses: f.get("maxUses") ? Number(f.get("maxUses")) : null,
          expiresInDays: f.get("expires") ? Number(f.get("expires")) : null,
          invitedUsername: friend || null,
        },
      });
      setUrl(res.invite.url);
      if (friend) toast({ tone: "success", title: "Invite sent", body: "They'll see it in their notifications." });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the invite.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="primary" onClick={() => { setUrl(null); setOpen(true); }}>
        New invite
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={url ? "Invite ready" : "Create an invite"} description={url ? "Anyone with this link can join, within the limits you set." : "Limit uses or set an expiry for links you share widely."}>
        {url ? (
          <div>
            <CopyField value={url} label="Invite link" />
            <Button className="mt-5 w-full" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <FormError message={error} />
            <Field label="Send directly to a friend (optional)" htmlFor="inv-friend" hint="Direct invites work once, only for that friend, and notify them.">
              <Select id="inv-friend" name="friend" defaultValue="">
                <option value="">Anyone with the link</option>
                {friends.map((f) => (
                  <option key={f.username} value={f.username}>
                    {f.displayName} (@{f.username})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max uses" htmlFor="inv-max">
                <Input id="inv-max" name="maxUses" type="number" min={1} max={500} placeholder="Unlimited" />
              </Field>
              <Field label="Expires after" htmlFor="inv-exp">
                <Select id="inv-exp" name="expires" defaultValue="">
                  <option value="">Never</option>
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </Select>
              </Field>
            </div>
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Create invite
            </Button>
          </form>
        )}
      </Dialog>
    </>
  );
}

export function MemberMenu({ leagueId, userId, name, canPromote, canRemove, canTransfer, isAdmin }: { leagueId: string; userId: string; name: string; canPromote: boolean; canRemove: boolean; canTransfer: boolean; isAdmin: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | "remove" | "transfer">(null);
  const [busy, setBusy] = useState(false);
  if (!canPromote && !canRemove && !canTransfer) return null;
  async function act(body: unknown, msg: string) {
    setBusy(true);
    try {
      await api(`/api/leagues/${leagueId}/members/${userId}`, { body });
      toast({ tone: "success", title: msg });
      setConfirm(null);
      router.refresh();
    } catch (e) {
      toast({ tone: "error", title: e instanceof ApiError ? e.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  }
  const item = "flex h-9 cursor-pointer items-center rounded px-2.5 text-sm text-chalk-2 outline-none data-[highlighted]:bg-pitch-750 data-[highlighted]:text-chalk";
  return (
    <>
      <DM.Root>
        <DM.Trigger className="rounded p-1.5 text-chalk-3 hover:bg-pitch-750 hover:text-chalk" aria-label={`Manage ${name}`}>
          <MoreHorizontal className="size-4" />
        </DM.Trigger>
        <DM.Portal>
          <DM.Content align="end" className="panel z-50 w-52 p-1.5 shadow-xl shadow-black/50">
            {canPromote ? (
              <DM.Item className={item} onSelect={() => act({ action: "role", role: isAdmin ? "member" : "admin" }, isAdmin ? `${name} is now a member` : `${name} is now an admin`)}>
                {isAdmin ? "Make member" : "Make admin"}
              </DM.Item>
            ) : null}
            {canTransfer ? (
              <DM.Item className={item} onSelect={() => setConfirm("transfer")}>
                Transfer ownership
              </DM.Item>
            ) : null}
            {canRemove ? (
              <DM.Item className={`${item} text-loss data-[highlighted]:text-loss`} onSelect={() => setConfirm("remove")}>
                Remove from league
              </DM.Item>
            ) : null}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "transfer" ? `Make ${name} the owner?` : `Remove ${name}?`}
        description={confirm === "transfer" ? "You'll become an admin. Only the new owner can transfer it back." : "They can rejoin only with a new invite."}
      >
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button variant="danger" className="flex-1" loading={busy} onClick={() => (confirm === "transfer" ? act({ action: "transfer" }, "Ownership transferred") : act({ action: "remove" }, `${name} removed`))}>
            {confirm === "transfer" ? "Transfer" : "Remove"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

export function LeagueSettings({ league, isOwner }: { league: { id: string; name: string; description: string | null; visibility: string; maxMembers: number; membersCanInvite: boolean }; isOwner: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/leagues/${league.id}`, {
        method: "PATCH",
        body: {
          name: f.get("name"),
          description: f.get("description") || null,
          ...(isOwner ? { visibility: f.get("visibility") } : {}),
          maxMembers: Number(f.get("maxMembers")),
          membersCanInvite: f.get("membersCanInvite") === "on",
        },
      });
      toast({ tone: "success", title: "League settings saved" });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <FormError message={error} />
      <Field label="Name" htmlFor="ls-name">
        <Input id="ls-name" name="name" defaultValue={league.name} required minLength={3} maxLength={40} />
      </Field>
      <Field label="Description" htmlFor="ls-desc">
        <Textarea id="ls-desc" name="description" defaultValue={league.description ?? ""} maxLength={240} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Who can find it" htmlFor="ls-vis">
          <Select id="ls-vis" name="visibility" defaultValue={league.visibility} disabled={!isOwner}>
            <option value="private">Invite only</option>
            <option value="public">Public</option>
          </Select>
        </Field>
        <Field label="Max members" htmlFor="ls-max">
          <Input id="ls-max" name="maxMembers" type="number" min={2} max={500} defaultValue={league.maxMembers} />
        </Field>
      </div>
      <Checkbox name="membersCanInvite" defaultChecked={league.membersCanInvite} label="Members can invite others" />
      <Button type="submit" className="w-full" loading={busy}>
        Save settings
      </Button>
    </form>
  );
}
