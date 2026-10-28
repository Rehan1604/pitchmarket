import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SignupForm } from "@/components/auth/forms";
import { getCurrentUser } from "@/server/auth/current-user";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  const credits = env().STARTING_BALANCE_CREDITS.toLocaleString("en-GB");
  return (
    <>
      <h1 className="scoreboard text-5xl text-chalk">Join the market</h1>
      <p className="mt-2 mb-7 text-sm text-chalk-3">Start with {credits} virtual Pitch Credits. Free, and it stays free.</p>
      <Suspense>
        <SignupForm />
      </Suspense>
      <p className="mt-6 text-sm text-chalk-3">
        Already trading?{" "}
        <Link href="/login" className="font-medium text-lime hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
