import { defineTool, READ_ONLY } from "../../types/tool-registration.js";
import { FILTER_SCHEMA } from "../../lib/tools-read.js";

defineTool({
  title: "Defaulted schema",
  annotations: READ_ONLY,
  description: "A defaulted schema produces required parsed handler arguments.",
  inputSchema: FILTER_SCHEMA,
  handler: ({ library, watched, rated, kind }) => {
    const requiredLibrary: string = library;
    const requiredWatched: "all" | "watched" | "unwatched" = watched;
    const requiredRated: "all" | "rated" | "unrated" = rated;
    const optionalKind: string | undefined = kind;
    return { requiredLibrary, requiredWatched, requiredRated, optionalKind };
  },
});

defineTool({
  title: "Mismatched handler",
  annotations: READ_ONLY,
  description: "A mismatched handler argument must stay rejected.",
  inputSchema: FILTER_SCHEMA,
  // @ts-expect-error library is parsed as a string, not a number.
  handler: ({ library }: { library: number }) => ({ library }),
});

// @ts-expect-error every tool declares its own annotations.
defineTool({
  title: "No annotations",
  description: "A tool without annotations must stay rejected.",
  inputSchema: {},
  handler: () => null,
});

defineTool({
  title: "Partial annotations",
  // @ts-expect-error all four hints are required; an absent one reads as the worst case.
  annotations: { readOnlyHint: false },
  description: "A tool missing a hint must stay rejected.",
  inputSchema: {},
  handler: () => null,
});
