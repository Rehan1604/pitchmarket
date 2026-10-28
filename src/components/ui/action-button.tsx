"use client";

import { useRouter } from "next/navigation";
import { useState, type ComponentProps } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { useToast } from "./toast";

/**
 * A button that performs one API call, shows the outcome, and refreshes the
 * server-rendered page. Optional confirmation dialog for destructive actions.
 */
export function ActionButton({
  endpoint,
  method = "POST",
  body,
  children,
  success,
  confirm,
  redirectTo,
  variant = "secondary",
  size = "sm",
  className,
  ...rest
}: {
  endpoint: string;
  method?: "POST" | "PATCH" | "DELETE";
  body?: unknown;
  success?: string;
  confirm?: { title: string; body: string; action: string };
  redirectTo?: string;
} & Omit<ComponentProps<typeof Button>, "onClick">) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await api(endpoint, { method, body: body ?? (method === "DELETE" ? undefined : {}) });
      if (success) toast({ tone: "success", title: success });
      setOpen(false);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (e) {
      toast({ tone: "error", title: e instanceof ApiError ? e.message : "That didn't work. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={variant} size={size} className={className} loading={busy && !confirm} onClick={() => (confirm ? setOpen(true) : run())} {...rest}>
        {children}
      </Button>
      {confirm ? (
        <Dialog open={open} onOpenChange={setOpen} title={confirm.title} description={confirm.body}>
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" className="flex-1" onClick={run} loading={busy}>
              {confirm.action}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
