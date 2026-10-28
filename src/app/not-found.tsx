import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="pitch-lines flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <p className="scoreboard text-[120px] text-chalk-4">404</p>
      <h1 className="scoreboard -mt-2 text-4xl text-chalk">Out of play</h1>
      <p className="mt-3 max-w-sm text-sm text-chalk-3">That page doesn’t exist, or you don’t have access to it.</p>
      <Link href="/dashboard" className="mt-6 rounded-md bg-lime px-4 py-2.5 text-sm font-medium text-pitch-950 hover:bg-[#e2fb84]">
        Back to the dashboard
      </Link>
    </main>
  );
}
