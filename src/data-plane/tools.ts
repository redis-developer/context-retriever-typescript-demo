import type { MCPTool } from "@redis-iris/context-retriever/mcp";

/**
 * Helpers for reading a discovered tool surface.
 *
 * Nothing here hard-codes a tool name. The generated surface changed
 * materially between two adjacent patch releases of the engine, so any code
 * that assumed a name would already be broken. Read `listTools()` and match on
 * shape instead.
 *
 * Note also that `description` and `inputSchema` are server-supplied. They are
 * useful for discovery and must never be treated as trusted configuration.
 */

/** The property names a tool's input schema accepts. */
export const parameterNames = (tool: MCPTool): readonly string[] => {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(schema?.properties ?? {}).sort();
};

/** The property names a tool requires. */
export const requiredParameters = (tool: MCPTool): readonly string[] => {
  const schema = tool.inputSchema as { required?: unknown } | undefined;
  const required = schema?.required;
  return Array.isArray(required) ? required.map(String).sort() : [];
};

/**
 * Finds the tool matching a naming shape, without hard-coding a full name.
 *
 * The engine's convention is a lowercase entity and a verbatim field joined by
 * underscores, so `get_transaction_by_id` and `filter_transaction` are derived
 * rather than assumed. A caller still has to cope with the tool being absent,
 * because whether a tool generates depends on the entity's indexes and the
 * data source's capabilities.
 */
export const findTool = (tools: readonly MCPTool[], name: string): MCPTool | undefined =>
  tools.find(tool => tool.name === name);

export const entityTool = (
  tools: readonly MCPTool[],
  verb: string,
  entity: string,
  suffix?: string,
): MCPTool | undefined => {
  const parts = [verb, entity.toLowerCase(), ...(suffix === undefined ? [] : [suffix])];
  return findTool(tools, parts.join("_"));
};

/**
 * The entity a tool's name refers to, or undefined for the set-algebra tools.
 *
 * Needed wherever a result has to be interpreted rather than merely displayed:
 * validating a `filter_beneficiary` result against the transaction schema
 * reports every record as malformed, which reads as a service fault when it is
 * really the caller looking up the wrong schema.
 */
export const entityOf = (toolName: string, entities: readonly string[]): string | undefined =>
  // Longest match wins. With entities `card` and `card_transaction`, a
  // first-match search maps `filter_card_transaction` to `card` and then
  // validates the result against the wrong schema, which is exactly the
  // misdiagnosis this helper exists to prevent.
  [...entities]
    .sort((left, right) => right.length - left.length)
    .find(entity => toolName.includes(`_${entity.toLowerCase()}`));

/** Groups tools by the entity their name refers to, for display. */
export const groupByEntity = (
  tools: readonly MCPTool[],
  entities: readonly string[],
): ReadonlyMap<string, readonly MCPTool[]> => {
  const grouped = new Map<string, MCPTool[]>();
  const other: MCPTool[] = [];
  for (const tool of tools) {
    const owner = entityOf(tool.name, entities);
    if (owner === undefined) {
      other.push(tool);
      continue;
    }
    const bucket = grouped.get(owner) ?? [];
    bucket.push(tool);
    grouped.set(owner, bucket);
  }
  if (other.length > 0) grouped.set("(unmatched)", other);
  return grouped;
};
