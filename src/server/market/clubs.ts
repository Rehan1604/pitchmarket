import "server-only";
import { sql } from "drizzle-orm";

/**
 * A club has one row per competition (Real Madrid in La Liga and in the
 * Champions League), and a Premier League club can also appear in ESPN's
 * Champions League feed (linked in entity_links). This subquery returns every
 * club row that is the same real club as `clubId`.
 */
export function sameClubIds(clubId: number) {
  return sql`(
    SELECT c2.id FROM clubs c1 JOIN clubs c2 ON c2.provider = c1.provider AND c2.provider_ref = c1.provider_ref WHERE c1.id = ${clubId}
    UNION
    SELECT c3.id FROM entity_links l JOIN clubs c3 ON c3.provider = l.provider AND c3.provider_ref = l.provider_ref
    WHERE l.kind = 'club' AND l.local_id = ${clubId}
  )`;
}
