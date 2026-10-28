import type { Metadata } from "next";
import Link from "next/link";
import { ResetForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <>
      <h1 className="scoreboard text-5xl text-chalk">New password</h1>
      {token ? (
        <>
          <p className="mt-2 mb-7 text-sm text-chalk-3">Choose a new password. You’ll be signed out everywhere else.</p>
          <ResetForm token={token} />
        </>
      ) : (
        <p className="mt-4 text-sm text-chalk-3">
          This page needs the link from your reset email.{" "}
          <Link href="/forgot-password" className="text-lime hover:underline">
            Request a new link
          </Link>
          .
        </p>
      )}
    </>
  );
}
