"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input } from "@/components/ui/field";
import { api, ApiError } from "@/lib/api";

export function safeNext(next: string | null, fallback = "/dashboard") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { identifier: form.get("identifier"), password: form.get("password") } });
      router.push(safeNext(params.get("next")));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Try again.");
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="Email or username" htmlFor="identifier">
        <Input id="identifier" name="identifier" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <div className="flex items-center justify-between text-sm">
        <Link href="/forgot-password" className="text-chalk-3 hover:text-chalk">
          Forgot your password?
        </Link>
      </div>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
        Sign in
      </Button>
    </form>
  );
}

export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await api("/api/auth/signup", {
        body: {
          email: form.get("email"),
          username: form.get("username"),
          password: form.get("password"),
          acceptTerms: form.get("acceptTerms") === "on" ? true : false,
        },
      });
      const next = safeNext(params.get("next"), "");
      router.push(next ? `/onboarding?next=${encodeURIComponent(next)}` : "/onboarding");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = (err.details?.issues as { path: string; message: string }[] | undefined) ?? [];
        if (issues.length) setFieldErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])));
        if (err.code === "USERNAME_TAKEN") setFieldErrors({ username: err.message });
        else if (err.code === "EMAIL_UNAVAILABLE") setFieldErrors({ email: err.message });
        else if (err.code === "WEAK_PASSWORD") setFieldErrors({ password: err.message });
        else if (!issues.length) setError(err.message);
      } else setError("Sign-up failed. Try again.");
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="Email" htmlFor="email" error={fieldErrors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(fieldErrors.email)} autoFocus />
      </Field>
      <Field label="Username" htmlFor="username" hint="3–20 letters, numbers or underscores. Friends find you by this." error={fieldErrors.username}>
        <Input id="username" name="username" autoComplete="username" required pattern="[A-Za-z0-9_]{3,20}" aria-invalid={Boolean(fieldErrors.username)} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 10 characters." error={fieldErrors.password}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} aria-invalid={Boolean(fieldErrors.password)} />
      </Field>
      <div>
        <Checkbox
          name="acceptTerms"
          required
          label={
            <>
              I understand PITCHMARKET uses <strong className="text-chalk">virtual Pitch Credits only</strong>. No real money can be deposited, won or withdrawn. My username, portfolio value and return appear on leaderboards.
            </>
          }
        />
        {fieldErrors.acceptTerms ? <p className="mt-1.5 text-[13px] text-loss">{fieldErrors.acceptTerms}</p> : null}
      </div>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
        Create account
      </Button>
    </form>
  );
}

export function ForgotForm() {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/auth/forgot", { body: { email: form.get("email") } });
      setDone(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <div role="status" className="rounded-md border border-gain/30 bg-gain/8 p-4 text-sm text-chalk-2">
        {done} The link works for one hour.
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
        Send reset link
      </Button>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/reset", { body: { token, password: form.get("password") } });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed. Request a new link.");
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="New password" htmlFor="password" hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} autoFocus />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
        Set new password
      </Button>
    </form>
  );
}
