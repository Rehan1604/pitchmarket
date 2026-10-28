import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

type Holder = { pool?: Pool; db?: Database; url?: string };
const g = globalThis as unknown as { __pitchmarketDb?: Holder };
const holder: Holder = (g.__pitchmarketDb ??= {});

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export function getPool(): Pool {
  const url = connectionString();
  if (!holder.pool || holder.url !== url) {
    holder.pool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=require|neon\.tech|supabase\.co/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    holder.pool.on("error", (err) => {
      console.error(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message }));
    });
    holder.url = url;
    holder.db = drizzle(holder.pool, { schema });
  }
  return holder.pool;
}

export function getDb(): Database {
  getPool();
  return holder.db!;
}

/** Lazily-initialised shared Drizzle instance. */
export const db: Database = new Proxy({} as Database, {
  get(_t, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export async function closeDb() {
  if (holder.pool) {
    await holder.pool.end();
    holder.pool = undefined;
    holder.db = undefined;
    holder.url = undefined;
  }
}

export { schema };
