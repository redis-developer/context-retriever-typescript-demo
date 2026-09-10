/**
 * What a tool surface cannot express, decided from the tool contracts alone.
 *
 * Separated from the command that prints it for two reasons. It is pure, so it
 * can be tested against a surface that *does* expose a foreclosed read, which
 * is the case a correctly scoped deployment can never produce. And it pulls in
 * no configuration, so the tests exercising it do not load a `.env`.
 */

/**
 * A class of read, and how the surface forecloses it.
 *
 * The expected case is that no tool accepts the arguments the read would need.
 * When one does, something other than the contract has to stop the read, and
 * that is reported as a finding rather than a pass.
 */
export interface Foreclosure {
  /** The read, phrased as the thing an attacker or a confused agent would want. */
  readonly read: string;
  /** Why it cannot be expressed, in terms of the tool contract. */
  readonly because: string;
  /**
   * Decides whether any discovered tool could express the read. Given every
   * tool's input schema, returns the names of those that could.
   */
  readonly expressibleBy: (tools: readonly DiscoveredTool[]) => readonly string[];
}

export interface DiscoveredTool {
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly additionalProperties: boolean;
}

/** Reads a tool's schema down to the two things this probe reasons about. */
export const describeTool = (tool: { name: string; inputSchema: unknown }): DiscoveredTool => {
  const schema = (tool.inputSchema ?? {}) as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  return {
    name: tool.name,
    properties: schema.properties ?? {},
    additionalProperties: schema.additionalProperties !== false,
  };
};

/** True when the tool declares a parameter of this name. */
const accepts = (tool: DiscoveredTool, parameter: string): boolean =>
  Object.hasOwn(tool.properties, parameter);

/**
 * Exported so the detection logic can be tested against a surface that *does*
 * expose a foreclosed read. A probe that can only ever pass proves nothing, and
 * a mis-scoped deployment is exactly the case worth catching.
 */
export const FORECLOSED: readonly Foreclosure[] = [
  {
    read: "Sum the amounts of one customer's card payments in one month",
    because:
      "the aggregate tools take no conditions, so an aggregate covers everything the key may see and cannot be narrowed to a subset",
    expressibleBy: tools =>
      tools
        .filter(tool => tool.name.startsWith("summarize_") || tool.name.startsWith("count_"))
        .filter(tool => accepts(tool, "tag_conditions") || accepts(tool, "numeric_conditions"))
        .map(tool => tool.name),
  },
  {
    read: "Total spending broken down by both payment type and currency at once",
    because: "group_by takes a single field, and no tool accepts a list of grouping fields",
    expressibleBy: tools =>
      tools
        .filter(tool => accepts(tool, "group_by"))
        .filter(tool => {
          const property = tool.properties["group_by"] as { type?: unknown } | undefined;
          return property?.type === "array";
        })
        .map(tool => tool.name),
  },
  {
    read: "Write, amend or delete a record",
    because: "the surface generates read tools only; no mutation tool is exposed on the data plane",
    expressibleBy: tools =>
      tools
        .filter(tool =>
          ["create", "update", "delete", "insert", "write", "upsert", "set"].some(verb =>
            tool.name.toLowerCase().startsWith(verb),
          ),
        )
        .map(tool => tool.name),
  },
  {
    read: "Run arbitrary Redis commands, or arbitrary query syntax, through a tool argument",
    because:
      "every parameter is either an enum drawn from the data model or a scalar with a declared type, and the tools reject unknown argument names",
    expressibleBy: tools =>
      tools
        .filter(
          tool =>
            accepts(tool, "command") ||
            accepts(tool, "query_string") ||
            accepts(tool, "filter_expression") ||
            accepts(tool, "raw"),
        )
        .map(tool => tool.name),
  },
];
