/**
 * Promote an existing account to administrator. Requires direct database
 * access (DATABASE_URL), so it is not a web backdoor.
 *
 *   npm run admin:grant -- you@example.com
 */
import "dotenv/config";
import { closeDb } from "@/db";
import { grantAdmin } from "@/server/admin/service";

async function main() {
  const email = process.argv.slice(2).find((a) => a.includes("@"));
  if (!email) throw new Error("Usage: npm run admin:grant -- you@example.com");
  const id = await grantAdmin(email);
  console.log(JSON.stringify({ msg: "admin granted", userId: id }));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
