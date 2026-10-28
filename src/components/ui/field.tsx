import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line-strong bg-pitch-950/60 px-3 text-sm text-chalk placeholder:text-chalk-4 transition-colors hover:border-chalk-4 focus:border-lime focus:outline-none aria-[invalid=true]:border-loss";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cn(control, "h-10", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "min-h-20 py-2", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        control,
        "h-10 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23bcc6bf%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Label({ className, children, ...rest }: ComponentProps<"label">) {
  return (
    <label className={cn("mb-1.5 block text-[13px] font-medium text-chalk-2", className)} {...rest}>
      {children}
    </label>
  );
}

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1.5 text-[13px] text-loss">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[13px] text-chalk-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, className, ...rest }: Omit<ComponentProps<"input">, "type"> & { label: ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 text-sm text-chalk-2", className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[#d4f55c]" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-loss/30 bg-loss/10 px-3 py-2.5 text-sm text-[#ffb3aa]">
      {message}
    </div>
  );
}
