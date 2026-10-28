import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { log } from "./log";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Sign in to continue.") => new HttpError(401, "UNAUTHENTICATED", message);
export const forbidden = (message = "You don't have access to this.") => new HttpError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found.") => new HttpError(404, "NOT_FOUND", message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new HttpError(409, code, message, details);

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) } });
}

export function errorResponse(err: unknown) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.",
          details: { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        },
      },
      { status: 400 },
    );
  }
  log.error("unhandled API error", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack?.split("\n").slice(0, 5).join(" | ") : undefined });
  return json({ error: { code: "INTERNAL", message: "Something went wrong on our side. Try again in a moment." } }, { status: 500 });
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/**
 * Wrap a route handler: maps errors to JSON, and for state-changing methods
 * enforces a same-origin check (CSRF defence in depth alongside SameSite=Lax cookies).
 */
export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden("Cross-site request blocked.");
    }
    if (!host || originHost !== host) throw forbidden("Cross-site request blocked.");
    return;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw forbidden("Cross-site request blocked.");
}

export async function readJson<S extends z.ZodTypeAny>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 20_000) throw badRequest("Request body too large.");
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest("Request body must be valid JSON.");
  }
  return schema.parse(body);
}

/**
 * Client IP for rate limiting. Prefers the platform-set `x-real-ip` (Vercel and
 * most reverse proxies overwrite it), then the first `x-forwarded-for` hop.
 * Only trust these headers when the app runs behind such a proxy.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}
