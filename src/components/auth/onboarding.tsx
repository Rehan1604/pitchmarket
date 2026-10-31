"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserAvatar } from "@/components/market/atoms";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input } from "@/components/ui/field";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { safeNext } from "./forms";

export function OnboardingFlow(props: {
  displayName: string;
  username: string;
  colors: string[];
  initialColor: string;
  startingCredits: number;
  feeBps: number;
  livePolicy: "halt" | "allow";
  dataMode: "live" | "snapshot" | "none";
  dataAsOf: string | null;
  next: string | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(props.displayName);
  const [color, setColor] = useState(props.initialColor);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credits = props.startingCredits.toLocaleString("en-GB");

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/onboarding", { body: { displayName: name.trim() || props.username, avatarColor: color, acknowledgeVirtual: ack } });
      router.push(safeNext(props.next));
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save. Try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-sm text-chalk-3" aria-live="polite">
        Step {step + 1} of 3
      </p>
      {step === 0 ? (
        <section>
          <h1 className="scoreboard mt-2 text-5xl text-chalk sm:text-6xl">You have {credits} Pitch Credits.</h1>
          <p className="mt-4 text-[15px] leading-relaxed text-chalk-2">They are virtual. You can’t buy more, cash them out or win anything with them. They exist so you can prove you read the game better than your friends.</p>
          <ol className="mt-8 space-y-5">
            {[
              ["Buy shares in players", "Every player has a share price in credits. You buy and sell whole shares at the current market price" + (props.feeBps ? `, plus a ${(props.feeBps / 100).toFixed(2)}% trading fee.` : ", with no trading fee.")],
              ["Prices move with real matches", "After each match a player’s price is updated from what they actually did: goals and assists, chances, clean sheets, saves, tackles and recoveries, judged against what’s normal for their position. Most matches move a price by up to 8%; a bigger game keeps adding, each extra goal or assist a little less, never more than 15%. Players who don’t play don’t lose value for sitting out."],
              ["Climb the leaderboards", "Your rank is your portfolio value: cash plus shares at today’s prices. Create a private league and send the invite link to your friends."],
            ].map(([title, body], i) => (
              <li key={title} className="flex gap-4">
                <span className="scoreboard w-8 shrink-0 text-3xl text-lime">{i + 1}</span>
                <div>
                  <p className="font-medium text-chalk">{title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-chalk-3">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          {props.livePolicy === "halt" ? (
            <p className="mt-6 rounded-md border border-line p-3 text-[13px] text-chalk-3">
              Fair-play rule: trading in a player is locked while their match is live, because match data reaches us a minute or two after TV. It reopens once the match is settled, about an hour after full time.
            </p>
          ) : null}
          <Button variant="primary" size="lg" className="mt-8" onClick={() => setStep(1)}>
            Continue
          </Button>
        </section>
      ) : null}

      {step === 1 ? (
        <section>
          <h1 className="scoreboard mt-2 text-5xl text-chalk">How friends will see you</h1>
          <p className="mt-3 text-sm text-chalk-3">Your username is @{props.username}. Your display name and colour appear on leaderboards.</p>
          <div className="mt-7 flex items-center gap-4">
            <UserAvatar name={name || props.username} color={color} size={56} />
            <div className="flex-1">
              <Field label="Display name" htmlFor="displayName">
                <Input id="displayName" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
          </div>
          <fieldset className="mt-6">
            <legend className="mb-2 text-[13px] font-medium text-chalk-2">Colour</legend>
            <div className="flex flex-wrap gap-2.5">
              {props.colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-pressed={color === c}
                  aria-label={`Colour ${c}`}
                  className={cn("size-9 rounded-full ring-offset-2 ring-offset-pitch-900 transition", color === c ? "ring-2 ring-chalk" : "hover:ring-2 hover:ring-chalk-4")}
                  style={{ background: c }}
                />
              ))}
            </div>
          </fieldset>
          <div className="mt-8 flex gap-3">
            <Button variant="ghost" size="lg" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button variant="primary" size="lg" onClick={() => setStep(2)} disabled={!name.trim()}>
              Continue
            </Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section>
          <h1 className="scoreboard mt-2 text-5xl text-chalk">One last thing</h1>
          {props.dataMode === "snapshot" ? (
            <p className="mt-4 rounded-md border border-amber/25 bg-amber/6 p-3 text-sm text-chalk-2">
              Right now prices come from a delayed public snapshot of Premier League data
              {props.dataAsOf ? ` (matches up to ${new Date(props.dataAsOf).toLocaleDateString("en-GB", { day: "numeric", month: "long" })})` : ""}, not a live feed. The app says so wherever it matters.
            </p>
          ) : null}
          <div className="mt-6">
            <Checkbox
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              label="I understand Pitch Credits are virtual. Nothing here involves real money, and share prices are game prices, not real-world player valuations."
            />
          </div>
          <div className="mt-6">
            <FormError message={error} />
          </div>
          <div className="mt-6 flex gap-3">
            <Button variant="ghost" size="lg" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" size="lg" onClick={finish} disabled={!ack} loading={busy}>
              Start trading
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
