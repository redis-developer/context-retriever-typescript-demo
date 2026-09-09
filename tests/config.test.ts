import { afterEach, beforeEach, describe as group, expect, it } from "vitest";

import { controlPlaneConfig, dataSourceConfig } from "../src/config/env.ts";
import { entityOf, groupByEntity } from "../src/data-plane/tools.ts";
import { otherSubjectValue, resolveDomain, subjectAccessTag } from "../src/domain/index.ts";

/**
 * Two properties of configuration handling, and the tool-name conventions.
 *
 * The configuration tests matter more than they look. A public repository
 * cannot afford an error message that echoes a credential, and the value of
 * reporting every missing variable at once is that a reader fixes their `.env`
 * in one pass instead of five.
 */

const GUARDED = [
  "CONTEXT_RETRIEVER_SERVER_URL",
  "CONTEXT_RETRIEVER_API_KEY_AUTH",
  "DEMO_DATA_SOURCE_ADDR",
  "DEMO_DATA_SOURCE_PASSWORD",
];

let saved: Record<string, string | undefined> = {};

// `Reflect.deleteProperty` rather than `delete`, which the lint rules reject on
// a computed key. Assigning undefined would not do: Node stringifies it, so the
// variable would be present and hold the text "undefined".
const clear = (name: string): void => {
  Reflect.deleteProperty(process.env, name);
};

beforeEach(() => {
  saved = Object.fromEntries(GUARDED.map(name => [name, process.env[name]]));
  for (const name of GUARDED) clear(name);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) clear(name);
    else process.env[name] = value;
  }
});

group("configuration failures", () => {
  it("reports every missing variable in one message", () => {
    // Both, not the first. Discovering prerequisites one failure at a time is
    // the main reason a demo gets abandoned half-configured.
    try {
      controlPlaneConfig();
      expect.unreachable("expected the parse to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("CONTEXT_RETRIEVER_SERVER_URL");
      expect(message).toContain("CONTEXT_RETRIEVER_API_KEY_AUTH");
    }
  });

  it("never puts a value in the message, only the variable name", () => {
    process.env["CONTEXT_RETRIEVER_SERVER_URL"] = "not-a-url";
    process.env["CONTEXT_RETRIEVER_API_KEY_AUTH"] = "sk-planted-secret-value";
    try {
      controlPlaneConfig();
      expect.unreachable("expected the parse to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("sk-planted-secret-value");
      expect(message).not.toContain("not-a-url");
      expect(message).toContain("CONTEXT_RETRIEVER_SERVER_URL");
    }
  });

  it("names the data-source address, which has no default and is easy to miss", () => {
    expect(() => dataSourceConfig()).toThrow(/DEMO_DATA_SOURCE_ADDR/);
  });
});

group("resolving a tool's entity", () => {
  const entities = ["transaction", "beneficiary"];

  it("matches on the underscore-delimited entity name", () => {
    expect(entityOf("filter_transaction", entities)).toBe("transaction");
    expect(entityOf("search_beneficiary_by_text", entities)).toBe("beneficiary");
  });

  it("returns undefined for the set-algebra tools, which belong to no entity", () => {
    expect(entityOf("expand_results", entities)).toBeUndefined();
  });

  it("prefers the longest match, so a prefixed entity is not misattributed", () => {
    // `filter_card_transaction` resolving to `card` would validate the result
    // against the wrong schema and report every row as malformed.
    expect(entityOf("filter_card_transaction", ["card", "card_transaction"])).toBe(
      "card_transaction",
    );
  });

  it("files unmatched tools separately rather than dropping them", () => {
    const named = (name: string): unknown => ({ name, inputSchema: { type: "object" } });
    const tools = [named("filter_transaction"), named("union_results")] as Parameters<
      typeof groupByEntity
    >[0];
    const grouped = groupByEntity(tools, entities);
    expect(grouped.get("transaction")).toHaveLength(1);
    expect(grouped.get("(unmatched)")).toHaveLength(1);
  });
});

group("deriving scoping values from the domain", () => {
  const domain = resolveDomain("retail-banking");

  it("reads the access tag off the entity's own ACL mapping", () => {
    // Provisioning used to hardcode this. A domain declaring a different tag
    // then minted a key matching nothing, and every read came back empty.
    expect(subjectAccessTag(domain)).toBe("customer");
  });

  it("finds an out-of-scope value that is never the signed-in one", () => {
    for (const signedIn of ["CUST001", "CUST002", "CUST099"]) {
      expect(otherSubjectValue(domain, signedIn), signedIn).not.toBe(signedIn);
    }
  });
});
