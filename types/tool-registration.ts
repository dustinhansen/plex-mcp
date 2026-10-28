import { z } from "zod";

type ParsedArguments<Shape extends z.ZodRawShape> = z.output<z.ZodObject<Shape>>;

/** MCP tool annotations, all four required: the spec reads an absent key as
 *  the worst case (destructive, open-world), so each tool states every one. */
type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** A read changes nothing on the server, so repeating it has no further effect. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

type TypedTool<Shape extends z.ZodRawShape, Result> = {
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Shape;
  handler: (args: ParsedArguments<Shape>) => Result | Promise<Result>;
  invoke: (args: unknown) => Result | Promise<Result>;
};

/** The one Zod-to-handler registration boundary. */
export function defineTool<Shape extends z.ZodRawShape, Result>(tool: Omit<TypedTool<Shape, Result>, "invoke">): TypedTool<Shape, Result> {
  const schema = z.object(tool.inputSchema);
  return { ...tool, invoke: (args) => tool.handler(schema.parse(args)) };
}

/** A ratingKey, playlist id or collection id: Plex issues each as a decimal integer. */
export const PLEX_ID = z.string().regex(/^\d+$/, "a Plex id is a run of digits");
