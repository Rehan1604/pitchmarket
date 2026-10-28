import type { Metadata } from "next";
import Link from "next/link";
import { ForgotForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <>
      <h1 className="scoreboard text-5xl text-chalk">Reset password</h1>
      <p className="mt-2 mb-7 text-sm text-chalk-3">Enter the email you signed up with and we’ll send a reset link.</p>
      <ForgotForm />
      <p className="mt-6 text-sm text-chalk-3">
        <Link href="/login" className="hover:text-chalk">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
