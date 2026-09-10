import { describe as group, expect, it } from "vitest";

import { GOVERNED_TOOL_BRIEF, TENANT_GUARDRAIL, buildPrompt } from "../src/agent/prompt.ts";
import { SQL_TOOL_BRIEF } from "../src/compare/arms/sql.ts";
import { resolveDomain } from "../src/domain/index.ts";

/**
 * Tests for the fairness invariant.
 *
 * The comparison's whole value rests on one claim: the two arms differ in their
 * tools and in one block of prose, and in nothing else. That claim is cheap to
 * assert in a README and cheap for a later edit to break silently, which is why
 * it is asserted here instead.
 *
 * What these cannot check is the `Arm` interface having no member for a model
 * or a step budget, because that is a compile-time property, and the lint rule
 * barring an arm from importing the model provider, because that is a lint
 * property. Both are checked by `npm run typecheck` and `npm run lint`.
 */

const domain = resolveDomain("retail-banking");

const promptFor = (toolBrief: readonly string[], tenantGuardrail = true): string =>
  buildPrompt({ domain, toolBrief, tenantGuardrail });

group("the two prompts", () => {
  it("differ only in the tool block", () => {
    // The load-bearing assertion. Strip each arm's own tool brief and what is
    // left has to be identical, or the two arms were told different things
    // about the business and the comparison is measuring that instead.
    const withoutBrief = (prompt: string, brief: readonly string[]): string =>
      prompt.replace(brief.join("\n"), "");
    expect(withoutBrief(promptFor(GOVERNED_TOOL_BRIEF), GOVERNED_TOOL_BRIEF)).toBe(
      withoutBrief(promptFor(SQL_TOOL_BRIEF), SQL_TOOL_BRIEF),
    );
  });

  it("both carry the guardrail sentence verbatim", () => {
    expect(promptFor(GOVERNED_TOOL_BRIEF)).toContain(TENANT_GUARDRAIL);
    expect(promptFor(SQL_TOOL_BRIEF)).toContain(TENANT_GUARDRAIL);
  });

  it("both define the contested term, so a disagreement is not scored as an error", () => {
    // "Spend" has two defensible readings and they give different numbers. The
    // reference implementation scored a semantic disagreement as a correctness
    // failure until it pinned this.
    for (const brief of [GOVERNED_TOOL_BRIEF, SQL_TOOL_BRIEF]) {
      expect(promptFor(brief)).toContain("mean the gross sum of every transaction amount");
    }
  });

  it("puts nothing about the business in either tool block", () => {
    // The domain brief is shared; a fact that leaked into one arm's tool block
    // would be a fact the other arm was never told.
    for (const brief of [GOVERNED_TOOL_BRIEF, SQL_TOOL_BRIEF]) {
      expect(brief.join("\n")).not.toContain(domain.description);
      expect(brief.join("\n")).not.toContain(TENANT_GUARDRAIL);
    }
  });
});

group("the guardrail toggle", () => {
  it("removes exactly the guardrail sentence and nothing else, on both arms", () => {
    for (const brief of [GOVERNED_TOOL_BRIEF, SQL_TOOL_BRIEF]) {
      const on = promptFor(brief, true);
      const off = promptFor(brief, false);
      expect(off).not.toContain(TENANT_GUARDRAIL);
      // The only difference is that one line. Asserted by reconstruction
      // rather than by a diff, because a toggle that also changed the wording
      // around it would measure two things and report one.
      expect(on.replace(`- ${TENANT_GUARDRAIL}\n`, "")).toBe(off);
    }
  });
});

group("the baseline's competence, which is what answers the strawman objection", () => {
  // A baseline missing any of these is not the standard implementation, and a
  // comparison against a weakened baseline is not evidence. Each is asserted
  // separately so a later edit that drops one fails on that one.
  const brief = SQL_TOOL_BRIEF.join("\n").toLowerCase();

  it.each([
    ["schema discovery", "list_tables"],
    ["schema inspection", "get_schema"],
    ["query validation", "check_query"],
    ["execution", "run_sql"],
    ["a scoping predicate", "customer_id equality predicate"],
    ["read-only intent", "only select statements"],
    ["pushing computation down", "the database can filter, group, sum and count"],
  ])("tells the baseline about %s", (_label, needle) => {
    expect(brief).toContain(needle.toLowerCase());
  });
});
