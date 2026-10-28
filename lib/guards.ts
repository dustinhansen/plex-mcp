/** What the client parsers share to read and narrow untyped JSON. */

import type { Upstream } from "./upstream.js";

/** A plain JSON object: not null, and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number => typeof value === "number";

/** Parses each entry once and keeps the ones that parse. */
export const parseAll = <T>(entries: unknown[], parse: (entry: unknown) => T | undefined): T[] =>
  entries.flatMap((entry) => parse(entry) ?? []);

/** JSON.parse, but a failure names only the upstream and the operation
 *  attempted: the SyntaxError quotes the start of the text, and a non-JSON
 *  reply (a proxy or login page) is an upstream body that must not reach a
 *  tool error. */
export function parseUpstreamJson(text: string, upstream: Upstream, operation: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${upstream} returned a reply that is not JSON on ${operation}`);
  }
}
