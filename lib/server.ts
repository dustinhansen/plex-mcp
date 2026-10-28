/** Builds a fully tool-registered McpServer. One per stdio process. One per HTTP request (stateless mode). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { readTools } from "./tools-read.js";
import { historyTools } from "./tools-history.js";
import { writeTools } from "./tools-write.js";
import { discoverTools } from "./tools-discover.js";
import { registerPrompts } from "./prompts.js";
import { playbackTools } from "./tools-playback.js";
import { tautulliTools } from "./tools-tautulli.js";
import type { PlexClient, TautulliClient } from "../types/boundaries.js";

export const { version }: { version: string } = createRequire(import.meta.url)("../../package.json");

/** `readOnly` leaves the write and playback groups unregistered, whatever
 *  `playback` says. The Tautulli tools are reads and stay. */
export type ServerOptions = { readOnly?: boolean; playback?: boolean; tautulli?: TautulliClient | null };

/** The most array elements and object members, combined, that one tools/call
 *  may carry. The SDK counts them before schema validation, so a payload under
 *  the HTTP body cap can't make validation exhaust memory. The longest real list
 *  is 500 ratingKeys, so this leaves it room twice over. */
export const MAX_TOOL_INPUT_ELEMENTS = 1000;

/** The tool map alone (no McpServer). Lets callers count/list tools without
 *  standing up (and then having to close) a server they never connect. */
export function buildTools(client: PlexClient, { readOnly = false, playback = false, tautulli = null }: ServerOptions = {}) {
  return {
    ...readTools(client),
    ...discoverTools(client),
    ...historyTools(client),
    ...(readOnly ? {} : writeTools(client)),
    ...(playback && !readOnly ? playbackTools(client) : {}),
    ...(tautulli ? tautulliTools(tautulli) : {}),
  };
}

export function buildServer(client: PlexClient, options: ServerOptions = {}) {
  const server = new McpServer({ name: "plex", version }, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS });
  const tools = buildTools(client, options);
  for (const [name, tool] of Object.entries(tools)) {
    server.registerTool(name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }, async (args: unknown) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await tool.invoke(args), null, 1) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    });
  }
  const { promptNames, resourceUris } = registerPrompts(server, tools);
  return { server, toolNames: Object.keys(tools), promptNames, resourceUris };
}
