import type { Metadata } from "next";
import { DeleteAccount, DemoReset, NotificationsForm, PasswordForm, PrivacyForm, ProfileForm } from "@/components/settings/forms";
import { PageHeader, Panel } from "@/components/ui/misc";
import { shortDate } from "@/lib/format";
import { AVATAR_COLORS } from "@/server/auth/accounts";
import { requirePageUser } from "@/server/auth/current-user";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requirePageUser();
  const demo = env().APP_MODE === "demo";
  return (
    <>
      <PageHeader title="Settings" description={`Signed in as @${user.username} (${user.email}). Member since ${shortDate(user.createdAt)}.`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Profile" id="profile">
          <ProfileForm displayName={user.displayName} bio={user.bio} color={user.avatarColor} colors={AVATAR_COLORS} />
        </Panel>
        <Panel title="Privacy" id="privacy">
          <PrivacyForm portfolioVisibility={user.portfolioVisibility} activityVisibility={user.activityVisibility} showOnGlobalLeaderboard={user.showOnGlobalLeaderboard} />
        </Panel>
        <Panel title="Notifications" id="notifications">
          <NotificationsForm notifyTrades={user.notifyTrades} notifySocial={user.notifySocial} notifyRank={user.notifyRank} />
        </Panel>
        <Panel title="Password" id="password">
          <PasswordForm />
        </Panel>
        {demo ? (
          <Panel title="Demo portfolio" id="demo">
            <p className="mb-4 text-sm text-chalk-3">This is a demo instance, so you can start over: every holding is sold at the current price and your cash returns to the starting balance. Limited to once every 10 minutes.</p>
            <DemoReset />
          </Panel>
        ) : null}
        <Panel title="Delete account" id="delete">
          <p className="mb-4 text-sm text-chalk-3">Deleting removes your profile and social connections and anonymises your trade history, which is kept so league standings stay consistent.</p>
          <DeleteAccount />
        </Panel>
      </div>
    </>
  );
}
