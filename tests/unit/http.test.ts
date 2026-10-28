import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { clientIp } from "@/server/http";

const req = (h: Record<string, string>) => new Request("https://pitchmarket.test/api/auth/login", { headers: h });

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.CLIENT_IP_HEADER;
    resetEnvCache();
  });

  it("defaults to x-real-ip, then the first x-forwarded-for hop", () => {
    process.env.DATABASE_URL ??= "postgres://unused";
    resetEnvCache();
    expect(clientIp(req({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.9");
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("treats blank optional settings (as in a copied .env.example) as unset", async () => {
    const { env } = await import("@/server/env");
    process.env.DATABASE_URL ??= "postgres://unused";
    process.env.CLIENT_IP_HEADER = "";
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "";
    resetEnvCache();
    expect(env().CRON_SECRET).toBeUndefined();
    expect(env().CLIENT_IP_HEADER).toBeUndefined();
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  it("prefers the configured header when CLIENT_IP_HEADER is set (spoofed x-forwarded-for ignored)", () => {
    process.env.DATABASE_URL ??= "postgres://unused";
    process.env.CLIENT_IP_HEADER = "True-Client-IP";
    resetEnvCache();
    expect(clientIp(req({ "true-client-ip": "203.0.113.50", "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6" }))).toBe("203.0.113.50");
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7"); // header absent: fall back
  });
});
