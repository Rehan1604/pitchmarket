"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";

export function MarketStatusControl({ status, reason }: { status: string; reason: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState(status);
  const [r, setR] = useState(reason ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/api/admin/market-status", { body: { status: s, reason: r || null } });
          toast({ tone: "success", title: `Market set to ${s}` });
          router.refresh();
        } catch (err) {
          toast({ tone: "error", title: err instanceof ApiError ? err.message : "Failed" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid grid-cols-[140px_1fr] gap-3">
        <Field label="Status" htmlFor="ms-status">
          <Select id="ms-status" value={s} onChange={(e) => setS(e.target.value)}>
            <option value="open">Open</option>
            <option value="halted">Halted</option>
            <option value="maintenance">Maintenance</option>
          </Select>
        </Field>
        <Field label="Reason shown to users" htmlFor="ms-reason">
          <Input id="ms-reason" value={r} onChange={(e) => setR(e.target.value)} maxLength={200} placeholder="Optional" />
        </Field>
      </div>
      <Button type="submit" loading={busy}>
        Apply
      </Button>
    </form>
  );
}

export function IngestControl() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  async function run(kind: "due" | "force" | "reprobe") {
    setBusy(kind);
    setResult(null);
    try {
      const res = await api<{ provider: string; mode: string; jobs: Record<string, string> }>("/api/admin/ingest", { body: { force: kind === "force", reprobe: kind === "reprobe" } });
      setResult(`${res.provider} (${res.mode}): ${Object.entries(res.jobs).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing was due"}`);
      router.refresh();
    } catch (err) {
      toast({ tone: "error", title: err instanceof ApiError ? err.message : "Run failed" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run("due")} loading={busy === "due"} disabled={busy !== null}>
          Run due jobs
        </Button>
        <Button onClick={() => run("force")} loading={busy === "force"} disabled={busy !== null}>
          Force full refresh
        </Button>
        <Button variant="ghost" onClick={() => run("reprobe")} loading={busy === "reprobe"} disabled={busy !== null}>
          Re-check live feed
        </Button>
      </div>
      {result ? <p className="mt-3 rounded-md border border-line p-2.5 font-mono text-[12px] text-chalk-2">{result}</p> : null}
      <p className="mt-2 text-[12px] text-chalk-4">Runs are idempotent and lock-protected; manual runs are rate-limited and audited.</p>
    </div>
  );
}
