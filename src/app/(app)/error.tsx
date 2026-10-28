"use client";

import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="panel mx-auto mt-10 max-w-lg p-8 text-center">
      <h1 className="scoreboard text-4xl text-chalk">This page didn’t load</h1>
      <p className="mt-3 text-sm text-chalk-3">Something went wrong on our side. Your portfolio and trades are safe; nothing was changed.</p>
      {error.digest ? <p className="mt-2 font-mono text-[12px] text-chalk-4">Reference {error.digest}</p> : null}
      <div className="mt-6 flex justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <ButtonLink href="/dashboard">Go to dashboard</ButtonLink>
      </div>
    </div>
  );
}
