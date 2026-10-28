/**
 * Transactional email. Uses Resend's HTTP API when RESEND_API_KEY is set.
 * Without it, development/test print the message (including the link) to the
 * server console; production logs that delivery is not configured and never
 * prints the link.
 */
import { env } from "./env";
import { log } from "./log";

export async function sendEmail(msg: { to: string; subject: string; text: string; devLink?: string }): Promise<boolean> {
  const e = env();
  if (e.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: e.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
      });
      if (!res.ok) {
        log.error("email delivery failed", { status: res.status });
        return false;
      }
      return true;
    } catch (err) {
      log.error("email delivery failed", { error: String(err) });
      return false;
    }
  }
  if (e.NODE_ENV !== "production") {
    // Development only: the link is shown in the terminal running `npm run dev`.
    console.log(`\n[dev email] ${msg.subject}\n${msg.devLink ?? ""}\n`);
    return true;
  }
  log.warn("email not configured — set RESEND_API_KEY to deliver password-reset emails", { subject: msg.subject });
  return false;
}
