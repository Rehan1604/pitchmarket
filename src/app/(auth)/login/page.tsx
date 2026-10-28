import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/forms";
import { getCurrentUser } from "@/server/auth/current-user";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <>
      <h1 className="scoreboard text-5xl text-chalk">Sign in</h1>
      <p className="mt-2 mb-7 text-sm text-chalk-3">Your portfolio, leagues and friends are waiting.</p>
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="mt-6 text-sm text-chalk-3">
        New here?{" "}
        <Link href="/signup" className="font-medium text-lime hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
