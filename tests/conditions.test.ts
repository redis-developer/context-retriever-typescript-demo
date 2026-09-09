import { describe as group, expect, it } from "vitest";
import type { MCPTool } from "@redis-iris/context-retriever/mcp";

import { buildFilterArgs, conditionFields } from "../src/data-plane/conditions.ts";

/**
 * Tests for the code an adopter is most likely to copy verbatim.
 *
 * Every failure mode here is silent or misattributed. A field the tool does not
 * accept produces a remote error that reads like a service fault; a page over
 * the cap is truncated without saying so; a sort field the tool cannot sort by
 * is accepted locally and rejected over the wire. The point of reading the
 * tool's own schema before calling is that none of that has to happen, so these
 * tests pin the reading rather than the calling.
 */

/** A filter tool shaped the way the engine generates one. */
const filterTool = (fields: readonly string[], extra: Record<string, unknown> = {}): MCPTool => ({
  name: "filter_transaction",
  inputSchema: {
    type: "object",
    properties: {
      tag_conditions: {
        type: "array",
        maxItems: 16,
        items: { properties: { field: { enum: [...fields] } } },
      },
      numeric_conditions: {
        type: "array",
        maxItems: 16,
        items: { properties: { field: { enum: ["amount", "transaction_date"] } } },
      },
      limit: { type: "integer", maximum: 100 },
      offset: { type: "integer" },
      ...extra,
    },
    additionalProperties: false,
  },
});

const TAGS = ["customer_id", "status"];

group("reading a condition array's declared fields", () => {
  it("returns the enum the tool declares", () => {
    expect(conditionFields(filterTool(TAGS), "tag_conditions")).toEqual(TAGS);
  });

  it("returns undefined for a parameter the tool does not have", () => {
    expect(conditionFields(filterTool(TAGS), "vector_conditions")).toBeUndefined();
  });
});

group("building filter arguments", () => {
  it("refuses an unaccepted field locally, and names the permitted set", () => {
    // The permitted set has to be in the message. Without it the caller learns
    // only that they were wrong, which is the least useful half of the answer.
    expect(() =>
      buildFilterArgs(filterTool(TAGS), { tags: [{ field: "channel_code", value: "POS" }] }),
    ).toThrow(/cannot filter on "channel_code".*accepts: customer_id, status/s);
  });

  it("refuses when the tool declares no such condition array at all", () => {
    const noTags = { name: "list_transaction", inputSchema: { properties: {} } } as MCPTool;
    expect(() =>
      buildFilterArgs(noTags, { tags: [{ field: "status", value: "SUCCESS" }] }),
    ).toThrow(/declares no tag_conditions/);
  });

  it("counts tag and numeric conditions together against the declared cap", () => {
    // The engine caps both arrays *between* them, so counting either alone
    // would pass locally and fail remotely.
    const tool = filterTool(TAGS);
    const tags = Array.from({ length: 9 }, () => ({ field: "status", value: "SUCCESS" }));
    const ranges = Array.from({ length: 8 }, () => ({ field: "amount", min: 1 }));
    expect(() => buildFilterArgs(tool, { tags, ranges })).toThrow(/at most 16 conditions/);
  });

  it("renames range bounds to the parameters the engine expects", () => {
    const args = buildFilterArgs(filterTool(TAGS), {
      ranges: [{ field: "amount", min: 10, max: 20 }],
    });
    expect(args["numeric_conditions"]).toEqual([{ field: "amount", min_value: 10, max_value: 20 }]);
  });

  it("omits a bound that was not given, rather than sending undefined", () => {
    const args = buildFilterArgs(filterTool(TAGS), { ranges: [{ field: "amount", min: 10 }] });
    expect(args["numeric_conditions"]).toEqual([{ field: "amount", min_value: 10 }]);
  });

  it("includes exclude only when it is true", () => {
    const included = buildFilterArgs(filterTool(TAGS), {
      tags: [{ field: "status", value: "FAILED", exclude: true }],
    });
    expect(included["tag_conditions"]).toEqual([
      { field: "status", value: "FAILED", exclude: true },
    ]);
    const omitted = buildFilterArgs(filterTool(TAGS), {
      tags: [{ field: "status", value: "FAILED", exclude: false }],
    });
    expect(omitted["tag_conditions"]).toEqual([{ field: "status", value: "FAILED" }]);
  });

  it("clamps limit to the engine's page cap and passes offset through", () => {
    const args = buildFilterArgs(filterTool(TAGS), { limit: 5000, offset: 40 });
    expect(args["limit"]).toBe(100);
    expect(args["offset"]).toBe(40);
  });

  it("drops a sort the tool cannot perform, and refuses one it can but does not accept", () => {
    // Two different situations, and conflating them would be wrong. A tool with
    // no sort_by cannot sort at all, so asking is harmless and the argument is
    // simply not sent. A tool that does sort, asked for a field outside its
    // enum, is a caller mistake worth failing on.
    const unsortable = buildFilterArgs(filterTool(TAGS), { sortBy: "transaction_date" });
    expect("sort_by" in unsortable).toBe(false);

    const sortable = filterTool(TAGS, { sort_by: { enum: ["transaction_date"] } });
    expect(
      buildFilterArgs(sortable, { sortBy: "transaction_date", sortOrder: "desc" }),
    ).toMatchObject({ sort_by: "transaction_date", sort_order: "desc" });
    expect(() => buildFilterArgs(sortable, { sortBy: "amount" })).toThrow(
      /cannot sort by "amount"/,
    );
  });

  it("sends no condition arrays for an empty intent", () => {
    expect(buildFilterArgs(filterTool(TAGS), {})).toEqual({});
  });
});
