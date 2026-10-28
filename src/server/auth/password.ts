import { hash, verify } from "@node-rs/argon2";

/** OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/** Verify against a throwaway hash so unknown accounts take as long as known ones. */
export async function burnVerifyTime(password: string) {
  dummy ??= hashPassword("pitchmarket-timing-equaliser");
  await verifyPassword(await dummy, password);
}

export function passwordProblems(password: string, context: { email?: string; username?: string } = {}): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 128) return "Use 128 characters or fewer.";
  const lower = password.toLowerCase();
  if (context.username && lower.includes(context.username.toLowerCase())) return "Don't include your username in your password.";
  if (context.email && lower.includes(context.email.split("@")[0].toLowerCase()) && context.email.split("@")[0].length >= 4)
    return "Don't include your email name in your password.";
  if (/^(.)\1+$/.test(password)) return "Pick something less repetitive.";
  if (["password12", "1234567890", "qwertyuiop", "pitchmarket"].some((w) => lower.includes(w))) return "That password is too common.";
  return null;
}
