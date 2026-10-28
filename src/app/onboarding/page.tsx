import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingFlow } from "@/components/auth/onboarding";
import { Wordmark } from "@/components/shell/wordmark";
import { AVATAR_COLORS } from "@/server/auth/accounts";
import { getCurrentUser } from "@/server/auth/current-user";
import { env } from "@/server/env";
import { dataStatus } from "@/server/market/queries";

export const metadata: Metadata = { title: "Welcome" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { next } = await searchParams;
  const e = env();
  const status = await dataStatus();
  return (
    <div className="pitch-lines min-h-dvh px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-xl">
        <Wordmark name={e.APP_NAME} />
        <main id="main" className="mt-10">
          <OnboardingFlow
            displayName={user.displayName}
            username={user.username}
            colors={AVATAR_COLORS}
            initialColor={user.avatarColor}
            startingCredits={e.STARTING_BALANCE_CREDITS}
            feeBps={e.TRADING_FEE_BPS}
            livePolicy={e.LIVE_TRADING_POLICY}
            dataMode={status.dataMode}
            dataAsOf={status.dataAsOf?.toISOString() ?? null}
            next={next ?? null}
          />
        </main>
      </div>
    </div>
  );
}
