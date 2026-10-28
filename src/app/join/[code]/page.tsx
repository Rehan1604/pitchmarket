import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/shell/wordmark";
import { ActionButton } from "@/components/ui/action-button";
import { ButtonLink } from "@/components/ui/button";
import { getCurrentUser } from "@/server/auth/current-user";
import { env } from "@/server/env";
import { HttpError } from "@/server/http";
import { previewInvite } from "@/server/social/leagues";

export const metadata: Metadata = { title: "League invite", robots: { index: false } };

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await getCurrentUser();
  if (user && !user.onboardedAt) redirect(`/onboarding?next=/join/${encodeURIComponent(code)}`);
  let preview: Awaited<ReturnType<typeof previewInvite>> | null = null;
  let error: string | null = null;
  try {
    preview = await previewInvite(code, user?.id ?? null);
  } catch (e) {
    if (e instanceof HttpError) error = e.message;
    else throw e;
  }
  const next = `/join/${encodeURIComponent(code)}`;
  return (
    <div className="pitch-lines flex min-h-dvh flex-col px-5 py-8">
      <Link href="/" className="self-start">
        <Wordmark name={env().APP_NAME} />
      </Link>
      <main id="main" className="m-auto w-full max-w-md py-10">
        <div className="panel p-6 sm:p-8">
          {error || !preview ? (
            <>
              <h1 className="scoreboard text-4xl text-chalk">Invite not valid</h1>
              <p className="mt-3 text-sm text-chalk-3">{error ?? "This invite link isn't valid."} Ask whoever sent it for a new link.</p>
              <ButtonLink href={user ? "/social" : "/"} className="mt-6">
                {user ? "Back to leagues" : "Go to the homepage"}
              </ButtonLink>
            </>
          ) : (
            <>
              <p className="text-sm text-chalk-3">{preview.ownerName} invited you to</p>
              <h1 className="scoreboard mt-2 text-5xl text-chalk">{preview.name}</h1>
              {preview.description ? <p className="mt-3 text-sm text-chalk-2">{preview.description}</p> : null}
              <p className="mt-3 text-sm text-chalk-3">
                {preview.members} of {preview.maxMembers} members. Ranked by portfolio value, with virtual credits only.
              </p>
              <div className="mt-7">
                {!user ? (
                  <div className="flex flex-col gap-2">
                    <ButtonLink href={`/signup?next=${encodeURIComponent(next)}`} variant="primary" size="lg">
                      Create an account to join
                    </ButtonLink>
                    <ButtonLink href={`/login?next=${encodeURIComponent(next)}`} variant="ghost">
                      I already have an account
                    </ButtonLink>
                  </div>
                ) : preview.alreadyMember ? (
                  <ButtonLink href={`/leagues/${preview.leagueId}`} variant="primary" size="lg">
                    You’re in. Open the league
                  </ButtonLink>
                ) : preview.usable ? (
                  <ActionButton endpoint={`/api/invites/${preview.code}/join`} variant="primary" size="lg" className="w-full" success={`Joined ${preview.name}`} redirectTo={`/leagues/${preview.leagueId}`}>
                    Join {preview.name}
                  </ActionButton>
                ) : (
                  <p className="rounded-md border border-amber/30 bg-amber/8 p-3 text-sm text-chalk-2">{preview.reason}</p>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
