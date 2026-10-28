/** Tautulli API v2 client. One endpoint, `cmd` selects the call. Optional:
 *  only built when TAUTULLI_URL and TAUTULLI_API_KEY are set. The key goes in
 *  the `X-Api-Key` header, never the URL, so it stays out of proxy and access
 *  logs. Tautulli reads that header from 2.18.0 on. */

import type { Query, TautulliClient, TautulliHistory, TautulliOptions, TautulliResponse, TautulliRow, TautulliStat } from "../types/boundaries.js";
import { isNumber, isRecord, isString, parseUpstreamJson } from "./guards.js";
import { UpstreamError, upstreamText } from "./upstream.js";

/** Before 2.18.0 Tautulli ignores the header, so every call reaches it with no
 *  key and it answers 400. From 2.18.0 on a wrong key gets 401. A 400 can also
 *  be an error result from a valid call, so the hint is conditional: a
 *  Tautulli that refuses every call is the case it points at. */
const KEY_REFUSED_HINT = "If every Tautulli call fails like this, check that Tautulli is 2.18.0 or later, then that TAUTULLI_API_KEY is right";

function rowFromJson(value: unknown): TautulliRow | undefined {
  if (!isRecord(value)) return undefined;
  return {
    title: isString(value.title) ? value.title : undefined,
    full_title: isString(value.full_title) ? value.full_title : undefined,
    friendly_name: isString(value.friendly_name) ? value.friendly_name : undefined,
    user: isString(value.user) ? value.user : undefined,
    total_plays: isNumber(value.total_plays) ? value.total_plays : undefined,
    total_duration: isNumber(value.total_duration) ? value.total_duration : undefined,
    users_watched: isNumber(value.users_watched) ? value.users_watched : undefined,
    media_type: isString(value.media_type) ? value.media_type : undefined,
    rating_key: isString(value.rating_key) || isNumber(value.rating_key) ? value.rating_key : undefined,
    date: isNumber(value.date) ? value.date : undefined,
    platform: isString(value.platform) ? value.platform : undefined,
    player: isString(value.player) ? value.player : undefined,
    percent_complete: isNumber(value.percent_complete) ? value.percent_complete : undefined,
    watched_status: isNumber(value.watched_status) ? value.watched_status : undefined,
    duration: isNumber(value.duration) ? value.duration : undefined,
  };
}

function historyFromJson(value: unknown): TautulliHistory | undefined {
  if (!isRecord(value)) return undefined;
  return {
    recordsFiltered: isNumber(value.recordsFiltered) ? value.recordsFiltered : undefined,
    data: Array.isArray(value.data) ? value.data.flatMap((row) => {
      const parsed = rowFromJson(row);
      return parsed ? [parsed] : [];
    }) : undefined,
  };
}

function statsFromJson(value: unknown): TautulliStat[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((stat): TautulliStat[] => {
    if (!isRecord(stat) || !isString(stat.stat_id)) return [];
    return [{ stat_id: stat.stat_id, rows: Array.isArray(stat.rows) ? stat.rows.flatMap((row) => {
      const parsed = rowFromJson(row);
      return parsed ? [parsed] : [];
    }) : undefined }];
  });
}

function tautulliResponseFromJson(value: unknown): TautulliResponse {
  if (!isRecord(value) || !isRecord(value.response)) return {};
  const { response } = value;
  return { response: {
    result: isString(response.result) ? response.result : undefined,
    data: historyFromJson(response.data) ?? statsFromJson(response.data),
  } };
}

export function makeTautulli({ baseUrl, apiKey, fetchImpl = globalThis.fetch }: TautulliOptions): TautulliClient {
  const base = baseUrl.replace(/\/$/, "");

  async function call(cmd: string, params: Query = {}): Promise<TautulliHistory | TautulliStat[] | undefined> {
    const url = new URL(base + "/api/v2");
    url.searchParams.set("cmd", cmd);
    for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
    let text;
    try {
      text = await upstreamText(fetchImpl, "Tautulli", cmd, url, { headers: { Accept: "application/json", "X-Api-Key": apiKey } });
    } catch (error) {
      if (error instanceof UpstreamError && (error.status === 400 || error.status === 401)) error.message = `${error.message}. ${KEY_REFUSED_HINT}`;
      throw error;
    }
    const parsed = parseUpstreamJson(text, "Tautulli", cmd);
    const body = tautulliResponseFromJson(parsed).response ?? {};
    if (body.result !== "success") throw new Error(`Tautulli ${cmd} did not return success`);
    return body.data;
  }

  return { call };
}
