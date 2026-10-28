/** Request-time clock for server components (rendering is per request, so reading the time is intended). */
export function nowMs(): number {
  return Date.now();
}
