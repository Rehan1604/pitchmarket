/**
 * Resilient HTTP for data providers: timeouts, bounded retries with exponential
 * backoff + jitter for transient failures, and typed errors that carry
 * rate-limit information so the pipeline can back off at the provider level.
 */

export type ProviderErrorKind = "rate_limited" | "http" | "network" | "timeout" | "parse" | "auth";

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public status?: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Base backoff in ms (doubles each retry). */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return undefined;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<{ text: string; headers: Headers }> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const backoff = opts.backoffMs ?? 750;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: ProviderError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        headers: { "User-Agent": "PITCHMARKET/1.0 (+virtual football market)", Accept: "application/json, text/csv, */*", ...opts.headers },
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        // Never hammer a rate-limited provider: surface immediately for provider-level backoff.
        throw new ProviderError("rate_limited", `429 from ${new URL(url).host}`, 429, retryAfter ?? 60);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError("auth", `${res.status} from ${new URL(url).host} (check API key / plan)`, res.status);
      }
      if (!res.ok) {
        const err = new ProviderError("http", `${res.status} from ${new URL(url).host}`, res.status);
        if (res.status >= 500 && attempt < retries) {
          lastErr = err;
          await sleep(backoff * 2 ** attempt + Math.floor(Math.random() * 250));
          continue;
        }
        throw err;
      }
      return { text: await res.text(), headers: res.headers };
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.kind === "http" && e.status && e.status >= 500 && attempt < retries) continue;
        throw e;
      }
      const aborted = (e as Error)?.name === "AbortError";
      lastErr = new ProviderError(aborted ? "timeout" : "network", `${aborted ? "timeout" : "network error"} for ${safeHost(url)}: ${(e as Error)?.message ?? e}`);
      if (attempt < retries) {
        await sleep(backoff * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new ProviderError("network", `request failed for ${safeHost(url)}`);
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<{ data: T; headers: Headers }> {
  const { text, headers } = await fetchText(url, opts);
  try {
    return { data: JSON.parse(text) as T, headers };
  } catch {
    throw new ProviderError("parse", `invalid JSON from ${safeHost(url)}`);
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "provider";
  }
}
