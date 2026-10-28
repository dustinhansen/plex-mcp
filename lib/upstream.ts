/** The one request path the three clients share, and the error it throws.
 *  Callers branch on `status`, never on the message, so the wording can change
 *  without breaking them. */

import type { FetchLike } from "../types/boundaries.js";
import { isRecord, isString } from "./guards.js";

export type Upstream = "Plex" | "plex.tv" | "Tautulli";

const TIMEOUT_MS = 30_000;

/** A failed request to an upstream. `status` is the HTTP status, or null when
 *  the request failed in transit. In that case `reason` is the network
 *  error's code (ECONNREFUSED, ENOTFOUND) or "timed out". The message names
 *  the upstream and the operation, plus at most a fixed hint a caller adds:
 *  never a response body, a token or a URL's query. */
export class UpstreamError extends Error {
  override name = "UpstreamError";
  readonly upstream: Upstream;
  readonly status: number | null;
  readonly operation: string;
  readonly reason: string | undefined;
  constructor(upstream: Upstream, status: number | null, operation: string, reason?: string) {
    super(status !== null ? `${upstream} ${status} on ${operation}`
      : reason === "timed out" ? `${upstream} timed out after ${TIMEOUT_MS / 1000}s on ${operation}`
      : `${upstream} unreachable${reason ? ` (${reason})` : ""} on ${operation}`);
    this.upstream = upstream;
    this.status = status;
    this.operation = operation;
    this.reason = reason;
  }
}

/** The code of a network failure, from the error fetch threw or its cause.
 *  Only a code that looks like one is kept, so no free text reaches a message. */
function failureCode(error: unknown): string | undefined {
  for (const candidate of [error, isRecord(error) ? error.cause : undefined]) {
    if (isRecord(candidate) && isString(candidate.code) && /^[A-Z][A-Z0-9_]*$/.test(candidate.code)) return candidate.code;
  }
  return undefined;
}

function failure(error: unknown, upstream: Upstream, operation: string): UpstreamError {
  const timedOut = isRecord(error) && error.name === "TimeoutError";
  return new UpstreamError(upstream, null, operation, timedOut ? "timed out" : failureCode(error));
}

/** True for a 404 from any upstream, read from the status, not the message. */
export const isNotFound = (error: unknown): boolean => error instanceof UpstreamError && error.status === 404;

/** One request with a 30-second timeout and no retry. Resolves only on a 2xx,
 *  with the body text. The timeout covers reading the body too. */
export async function upstreamText(fetchImpl: FetchLike, upstream: Upstream, operation: string, url: URL, init: RequestInit = {}): Promise<string> {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw failure(error, upstream, operation);
  }
  if (!response.ok) throw new UpstreamError(upstream, response.status, operation);
  try {
    return await response.text();
  } catch (error) {
    throw failure(error, upstream, operation);
  }
}
