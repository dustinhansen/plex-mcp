/** Canned prompts and resources that teach a client how to combine the tools.
 *  Pure text. The client's model does the calling. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolsWithLibraries = { list_libraries: { handler: (args: Record<string, never>) => unknown | Promise<unknown> } };
const text = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer, tools: ToolsWithLibraries) {
  server.registerPrompt(
    "movie_night",
    {
      title: "Movie night picker",
      description: "Pick three things to watch tonight from the library, with reasons.",
      argsSchema: {
        library: z.string().optional().describe("library to pick from (default Movies)"),
        mood: z.string().optional().describe("free text: 'cozy', 'tense', 'something short'"),
      },
    },
    ({ library, mood }) =>
      text(
        `Help me pick something to watch tonight from my Plex library "${library ?? "Movies"}".` +
          (mood ? ` Mood: ${mood}.` : "") +
          ` Use random_pick with watched=unwatched (translate the mood into genre, decade, ` +
          `contentRating, or maxDurationMin filters) to get candidates. Call it more than once ` +
          `if the first batch is weak. Use similar_items on something I rated highly ` +
          `(list_media with rated=rated, sort=userRating) for one of the picks. Present exactly ` +
          `three options: title, year, runtime, one sentence on why it fits. Do not invent titles ` +
          `that are not in the results.`
      )
  );

  server.registerPrompt(
    "whats_new",
    {
      title: "What's new",
      description: "Summarize what was added to every library recently.",
      argsSchema: { since: z.string().optional().describe("ISO date or relative like '-7d' (default)") },
    },
    ({ since }) =>
      text(
        `Summarize what is new on my Plex server since ${since ?? "-7d"}. Call list_libraries, ` +
          `then library_changes for each Movies / TV Shows / Music library with since="${since ?? "-7d"}" ` +
          `(use kind=episode for TV libraries so new episodes show up). Group by library, ` +
          `newest first, and note anything I have already started watching.`
      )
  );

  server.registerResource(
    "libraries",
    "plex://libraries",
    { title: "Plex libraries", description: "Every library section with its type and key.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await tools.list_libraries.handler({}), null, 1) }],
    })
  );

  return { promptNames: ["movie_night", "whats_new"], resourceUris: ["plex://libraries"] };
}
