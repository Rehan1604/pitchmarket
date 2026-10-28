"use client";

import { Check, Copy, Search, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { UserAvatar } from "@/components/market/atoms";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";

type Found = { id: string; username: string; displayName: string; avatarColor: string; isDemo: boolean; relationship: "self" | "friend" | "pending_out" | "pending_in" | "none" };

export function FriendSearch() {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await api<{ users: Found[] }>(`/api/users/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        setResults(res.users);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setResults([]);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  async function add(u: Found) {
    setBusy(u.id);
    try {
      const res = await api<{ status: string }>("/api/friends/requests", { body: { username: u.username } });
      toast({ tone: "success", title: res.status === "accepted" ? `You and ${u.displayName} are now friends` : `Friend request sent to ${u.displayName}` });
      setResults((rs) => rs?.map((r) => (r.id === u.id ? { ...r, relationship: res.status === "accepted" ? "friend" : "pending_out" } : r)) ?? null);
      router.refresh();
    } catch (e) {
      toast({ tone: "error", title: e instanceof ApiError ? e.message : "Couldn't send the request." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-chalk-4" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find managers by username" aria-label="Find managers by username" className="pl-9" />
      </div>
      {results && q.trim().length >= 2 ? (
        <ul className="mt-2 divide-y divide-line rounded-md border border-line" aria-live="polite">
          {results.length === 0 ? <li className="p-3 text-sm text-chalk-3">No managers match “{q.trim()}”.</li> : null}
          {results.map((u) => (
            <li key={u.id} className="flex items-center gap-3 p-2.5">
              <UserAvatar name={u.displayName} color={u.avatarColor} size={30} />
              <a href={`/u/${u.username}`} className="min-w-0 flex-1 hover:underline">
                <span className="block truncate text-sm text-chalk">{u.displayName}</span>
                <span className="block truncate text-xs text-chalk-3">
                  @{u.username}
                  {u.isDemo ? " (demo account)" : ""}
                </span>
              </a>
              {u.relationship === "none" ? (
                <Button size="sm" onClick={() => add(u)} loading={busy === u.id}>
                  <UserPlus className="size-3.5" aria-hidden /> Add
                </Button>
              ) : u.relationship === "pending_in" ? (
                <Button size="sm" variant="primary" onClick={() => add(u)} loading={busy === u.id}>
                  Accept
                </Button>
              ) : (
                <span className="text-[12.5px] text-chalk-3">{u.relationship === "self" ? "You" : u.relationship === "friend" ? "Friends" : "Request sent"}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CreateLeagueButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; url: string } | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ league: { id: string; name: string }; invite: { url: string } }>("/api/leagues", {
        body: {
          name: f.get("name"),
          description: f.get("description") || null,
          visibility: f.get("visibility"),
          maxMembers: Number(f.get("maxMembers") || 50),
          membersCanInvite: f.get("membersCanInvite") === "on",
        },
      });
      setCreated({ id: res.league.id, name: res.league.name, url: res.invite.url });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the league.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => { setCreated(null); setOpen(true); }}>
        Create league
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={created ? `${created.name} is ready` : "Create a league"} description={created ? "Share this link. Anyone with it can join until you revoke it." : "Leagues rank members by portfolio value."}>
        {created ? (
          <div>
            <CopyField value={created.url} label="Invite link" />
            <div className="mt-5 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button variant="primary" className="flex-1" onClick={() => router.push(`/leagues/${created.id}`)}>
                Open league
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <FormError message={error} />
            <Field label="Name" htmlFor="league-name">
              <Input id="league-name" name="name" required minLength={3} maxLength={40} placeholder="Sunday League Legends" autoFocus />
            </Field>
            <Field label="Description (optional)" htmlFor="league-description">
              <Textarea id="league-description" name="description" maxLength={240} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Who can find it" htmlFor="league-visibility">
                <Select id="league-visibility" name="visibility" defaultValue="private">
                  <option value="private">Invite only</option>
                  <option value="public">Public</option>
                </Select>
              </Field>
              <Field label="Max members" htmlFor="league-max">
                <Input id="league-max" name="maxMembers" type="number" min={2} max={500} defaultValue={50} />
              </Field>
            </div>
            <Checkbox name="membersCanInvite" defaultChecked label="Members can invite others" />
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Create league
            </Button>
          </form>
        )}
      </Dialog>
    </>
  );
}

export function JoinByCode() {
  const router = useRouter();
  const [code, setCode] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const c = code.trim().replace(/^.*\/join\//, "").replace(/[^A-Za-z0-9]/g, "");
        if (c) router.push(`/join/${c}`);
      }}
      className="flex gap-2"
    >
      <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Invite code or link" aria-label="Invite code or link" className="h-9" />
      <Button type="submit" size="sm" className="h-9">
        Join
      </Button>
    </form>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-medium text-chalk-2">{label}</p>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" />
        <Button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check className="size-4 text-gain" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
