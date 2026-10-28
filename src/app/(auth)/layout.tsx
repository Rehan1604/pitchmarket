import Link from "next/link";
import { Wordmark } from "@/components/shell/wordmark";
import { env } from "@/server/env";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const name = env().APP_NAME;
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(440px,560px)]">
      <aside className="pitch-lines relative hidden overflow-hidden border-r border-line bg-pitch-950/50 p-10 lg:flex lg:flex-col">
        <Link href="/">
          <Wordmark name={name} />
        </Link>
        <div className="mt-auto max-w-lg">
          <p className="scoreboard text-[64px] leading-[0.92] text-chalk">Every footballer has a share price.</p>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-chalk-2">
            Prices move with real match performances: goals, assists, clean sheets, saves, and in the Premier League the defensive work nobody else counts. Back your judgement with 100,000 virtual Pitch Credits.
          </p>
          <p className="mt-8 text-[12.5px] text-chalk-4">Virtual credits only. No deposits, withdrawals, prizes or betting.</p>
        </div>
      </aside>
      <main id="main" className="flex flex-col px-5 py-8 sm:px-10">
        <Link href="/" className="mb-10 lg:hidden">
          <Wordmark name={name} />
        </Link>
        <div className="my-auto w-full max-w-sm self-center">{children}</div>
      </main>
    </div>
  );
}
