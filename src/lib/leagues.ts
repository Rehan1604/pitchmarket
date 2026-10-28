/** Short labels for tradable competitions (client-safe). */
export const LEAGUE_SHORT: Record<string, string> = {
  PL: "PL",
  PD: "LaLiga",
  BL1: "BL",
  SA: "Serie A",
  FL1: "Ligue 1",
  CL: "UCL",
};

export const leagueShort = (code: string | null | undefined) => (code ? (LEAGUE_SHORT[code] ?? code) : "");
