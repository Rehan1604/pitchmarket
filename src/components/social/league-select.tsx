"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/field";

export function LeagueSelect({ leagues, value, period }: { leagues: { id: string; name: string }[]; value: string | null; period: string }) {
  const router = useRouter();
  return (
    <Select
      aria-label="League"
      value={value ?? ""}
      onChange={(e) => router.push(`/leaderboard?scope=league&leagueId=${e.target.value}&period=${period}`)}
      className="w-56"
    >
      {value ? null : <option value="">Choose a league</option>}
      {leagues.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
        </option>
      ))}
    </Select>
  );
}
