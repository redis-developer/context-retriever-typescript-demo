import type { MCPTool } from "@redis-iris/context-retriever/mcp";

/**
 * Building tool arguments from the tool's own declared schema.
 *
 * The composite filter does not take a parameter per field. It takes
 * `tag_conditions` and `numeric_conditions`, arrays whose `field` property is
 * an enum of exactly the entity's indexed fields. So the curated index set does
 * not change the parameter count; it changes the enum, and it changes the tool
 * description, into which the engine folds every indexed field's description.
 *
 * Reading the enum before calling means an unsupported field fails here, with
 * the permitted set in the message, rather than as a remote error. The schema
 * already says what is allowed; there is no reason to find out over the wire.
 */

export interface TagPredicate {
  readonly field: string;
  readonly value: string;
  /** Match records where the field is present and does not hold this value. */
  readonly exclude?: boolean;
}

export interface RangePredicate {
  readonly field: string;
  readonly min?: number;
  readonly max?: number;
}

interface ArraySchema {
  readonly items?: { readonly properties?: { readonly field?: { readonly enum?: unknown } } };
  readonly maxItems?: number;
}

interface ToolSchema {
  readonly properties?: Record<string, ArraySchema & { readonly enum?: unknown }>;
}

/**
 * A structural view of a tool's input schema.
 *
 * Server-supplied, so it is read defensively and never trusted as
 * configuration: every lookup below tolerates the property being absent or the
 * wrong shape.
 */
const schemaOf = (tool: MCPTool): ToolSchema => tool.inputSchema;

/** The values a condition array's `field` property accepts, or undefined if absent. */
export const conditionFields = (
  tool: MCPTool,
  parameter: string,
): readonly string[] | undefined => {
  const candidate = schemaOf(tool).properties?.[parameter];
  const values = candidate?.items?.properties?.field?.enum;
  return Array.isArray(values) ? values.map(String) : undefined;
};

/** The values a plain enum parameter accepts, or undefined if it is not an enum. */
export const enumValues = (tool: MCPTool, parameter: string): readonly string[] | undefined => {
  const values: unknown = schemaOf(tool).properties?.[parameter]?.enum;
  return Array.isArray(values) ? values.map(String) : undefined;
};

export const hasParameter = (tool: MCPTool, parameter: string): boolean =>
  schemaOf(tool).properties?.[parameter] !== undefined;

const assertAllowed = (tool: MCPTool, parameter: string, field: string): void => {
  const allowed = conditionFields(tool, parameter);
  if (allowed === undefined) {
    throw new Error(`${tool.name} declares no ${parameter}, so it cannot filter on ${field}`);
  }
  if (!allowed.includes(field)) {
    throw new Error(
      `${tool.name} cannot filter on ${JSON.stringify(field)} via ${parameter}. ` +
        `It accepts: ${allowed.join(", ")}`,
    );
  }
};

export interface FilterIntent {
  readonly tags?: readonly TagPredicate[];
  readonly ranges?: readonly RangePredicate[];
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: string;
  readonly sortOrder?: "asc" | "desc";
}

/**
 * Renders an intent into arguments this specific tool accepts.
 *
 * The engine caps both condition arrays at sixteen entries between them, and
 * caps a page at a hundred results, so both are checked here rather than
 * discovered remotely.
 */
export const buildFilterArgs = (tool: MCPTool, intent: FilterIntent): Record<string, unknown> => {
  const args: Record<string, unknown> = {};
  const tags = intent.tags ?? [];
  const ranges = intent.ranges ?? [];

  const declaredMax = schemaOf(tool).properties?.["tag_conditions"]?.maxItems;
  const maxConditions = typeof declaredMax === "number" ? declaredMax : 16;
  if (tags.length + ranges.length > maxConditions) {
    throw new Error(
      `${tool.name} accepts at most ${String(maxConditions)} conditions across both arrays, ` +
        `got ${String(tags.length + ranges.length)}`,
    );
  }

  if (tags.length > 0) {
    for (const predicate of tags) assertAllowed(tool, "tag_conditions", predicate.field);
    args["tag_conditions"] = tags.map(predicate => ({
      field: predicate.field,
      value: predicate.value,
      ...(predicate.exclude === true ? { exclude: true } : {}),
    }));
  }

  if (ranges.length > 0) {
    for (const predicate of ranges) assertAllowed(tool, "numeric_conditions", predicate.field);
    args["numeric_conditions"] = ranges.map(predicate => ({
      field: predicate.field,
      ...(predicate.min === undefined ? {} : { min_value: predicate.min }),
      ...(predicate.max === undefined ? {} : { max_value: predicate.max }),
    }));
  }

  if (intent.limit !== undefined) args["limit"] = Math.min(intent.limit, 100);
  if (intent.offset !== undefined) args["offset"] = intent.offset;

  if (intent.sortBy !== undefined && hasParameter(tool, "sort_by")) {
    const sortable = enumValues(tool, "sort_by");
    if (sortable !== undefined && !sortable.includes(intent.sortBy)) {
      throw new Error(
        `${tool.name} cannot sort by ${JSON.stringify(intent.sortBy)}. It accepts: ${sortable.join(", ")}`,
      );
    }
    args["sort_by"] = intent.sortBy;
    if (intent.sortOrder !== undefined) args["sort_order"] = intent.sortOrder;
  }

  return args;
};
