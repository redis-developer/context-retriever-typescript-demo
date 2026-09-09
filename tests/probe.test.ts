import { describe as group, expect, it } from "vitest";

import { FORECLOSED, describe } from "../src/cli/commands/probe.ts";

/**
 * Tests for the capability probe's detection, not for its prose.
 *
 * A probe that can only ever pass proves nothing, so what needs testing is the
 * case the live surface cannot produce: a deployment that *does* expose one of
 * the reads the probe claims are foreclosed. Each test below builds a synthetic
 * tool list with that mistake in it and asserts the probe names the offending
 * tool, then asserts the clean list is silent.
 */

const tool = (
  name: string,
  properties: Record<string, unknown>,
): { name: string; inputSchema: unknown } => ({
  name,
  inputSchema: { type: "object", properties, additionalProperties: false },
});

/** The shape this repository's surface actually generates, in miniature. */
const WELL_SCOPED = [
  tool("filter_transaction", {
    tag_conditions: { type: "array" },
    numeric_conditions: { type: "array" },
    limit: { type: "integer" },
  }),
  tool("summarize_transaction", {
    field: { type: "string", enum: ["amount"] },
    function: { type: "string", enum: ["sum"] },
    group_by: { type: "string", enum: ["currency_code"] },
  }),
  tool("count_transaction", { function: { type: "string", enum: ["count"] } }),
  tool("get_transaction_by_id", { id: { type: "string" } }),
].map(describe);

const foreclosureFor = (read: string) => {
  const found = FORECLOSED.find(entry => entry.read.startsWith(read));
  if (found === undefined) throw new Error(`no foreclosure starting "${read}"`);
  return found;
};

group("the capability probe", () => {
  it("reports nothing against a well-scoped surface", () => {
    for (const foreclosure of FORECLOSED) {
      expect(foreclosure.expressibleBy(WELL_SCOPED), foreclosure.read).toEqual([]);
    }
  });

  it("catches an aggregate that accepts conditions", () => {
    const surface = [
      ...WELL_SCOPED,
      describe(
        tool("summarize_transaction_scoped", {
          field: { type: "string" },
          function: { type: "string" },
          tag_conditions: { type: "array" },
        }),
      ),
    ];
    expect(foreclosureFor("Sum the amounts").expressibleBy(surface)).toEqual([
      "summarize_transaction_scoped",
    ]);
  });

  it("catches a group_by that takes a list of fields", () => {
    const surface = [
      describe(
        tool("summarize_transaction", { group_by: { type: "array", items: { type: "string" } } }),
      ),
    ];
    expect(foreclosureFor("Total spending broken down").expressibleBy(surface)).toEqual([
      "summarize_transaction",
    ]);
  });

  it("catches a mutation tool on the data plane", () => {
    const surface = [
      ...WELL_SCOPED,
      describe(tool("delete_transaction", { id: { type: "string" } })),
    ];
    expect(foreclosureFor("Write, amend or delete").expressibleBy(surface)).toEqual([
      "delete_transaction",
    ]);
  });

  it("catches a tool that accepts raw query syntax", () => {
    const surface = [
      ...WELL_SCOPED,
      describe(tool("search_raw", { query_string: { type: "string" } })),
    ];
    expect(foreclosureFor("Run arbitrary Redis commands").expressibleBy(surface)).toEqual([
      "search_raw",
    ]);
  });

  it("treats a tool with no schema as expressing nothing", () => {
    const surface = [describe({ name: "mystery", inputSchema: undefined })];
    for (const foreclosure of FORECLOSED) {
      expect(foreclosure.expressibleBy(surface), foreclosure.read).toEqual([]);
    }
  });

  it("records that an open schema accepts unknown arguments", () => {
    const open = describe({ name: "open", inputSchema: { type: "object", properties: {} } });
    expect(open.additionalProperties).toBe(true);
    expect(WELL_SCOPED.every(entry => !entry.additionalProperties)).toBe(true);
  });
});
