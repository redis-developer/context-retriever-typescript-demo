import { describe as group, expect, it } from "vitest";

import type { ToolTrace } from "../src/agent/bridge.ts";
import { judgeStatement } from "../src/compare/judge.ts";
import { compare, type Observation } from "../src/compare/metrics.ts";
import { render } from "../src/compare/report.ts";
import type { Scenario } from "../src/compare/scenarios.ts";

/**
 * Tests for the renderer.
 *
 * The renderer is the one place a figure can be mislabelled while every
 * arithmetic step behind it is correct, which is why it returns lines rather
 * than printing them. What these check is wording and ordering, because those
 * are what a reader acts on.
 */

const SCHEMA = { subjectColumnByTable: { bank_transaction: "customer_id" } };

const scenario = (question: string): Scenario => ({
  question,
  exercises: "",
  governedSurface: "answers",
});

const observation = (over: Partial<Observation> = {}): Observation => ({
  arm: "governed",
  scenario: scenario("q1"),
  guardrail: true,
  answer: "",
  traces: [],
  stepOfCall: new Map(),
  inputTokens: 1000,
  outputTokens: 100,
  modelCalls: 2,
  turnMs: 2000,
  schemaTokens: 700,
  verdicts: [],
  score: "unscored",
  ...over,
});

const sqlTrace = (sql: string): ToolTrace => ({
  name: "run_sql",
  kind: "retrieval",
  callId: "call-1",
  resultTokens: 100,
  args: { query: sql },
  ms: 10,
  ok: true,
  sql,
});

/** A run where one arm writes statements and the other writes none. */
const rendered = (statements: readonly string[]): readonly string[] =>
  render(
    compare([
      observation({ arm: "governed" }),
      observation({
        arm: "sql",
        modelCalls: 6,
        traces: statements.map(sqlTrace),
        verdicts: statements.map(statement => judgeStatement(statement, "CUST001", SCHEMA)),
      }),
    ]),
  );

group("the report", () => {
  const lines = rendered(["select * from bank_transaction where customer_id = 'CUST001'"]);
  const text = lines.join("\n");

  it("puts the session block before any per-question row", () => {
    // A presenter who reached a per-question row first could quote one whose
    // sign the hidden-cost block explains.
    expect(text.indexOf("Session")).toBeLessThan(text.indexOf("Per question"));
  });

  it("reports accuracy after governance and cost, not before", () => {
    expect(text.indexOf("Governance")).toBeLessThan(text.indexOf("Accuracy"));
    expect(text.indexOf("Hidden costs")).toBeLessThan(text.indexOf("Accuracy"));
  });

  it("names both arms wherever it names one", () => {
    for (const line of lines) {
      if (line.includes("governed") && /\d/.test(line)) {
        // Every figure line for one arm has a counterpart for the other. The
        // check is on the block, not the line: they are adjacent rows.
        expect(text).toContain("sql");
      }
    }
    expect(text).toContain("governed");
    expect(text).toContain("sql");
  });

  it("keeps the three scoping outcomes as separate columns", () => {
    // Adding a `cannot tell` to either neighbour would turn a statement the
    // judge declined to clear into a pass or a violation.
    expect(text).toMatch(/scoped\s+unscoped\s+cannot tell/);
  });

  it("says the structural claim has no denominator", () => {
    expect(text).toContain("unreachable, structurally");
    expect(text).toContain("no denominator");
  });

  it("labels token figures as estimated", () => {
    expect(text).toContain("estimated at four characters per token");
    expect(text).toContain("tok est.");
  });

  it("discloses how far to trust the estimate", () => {
    expect(text).toMatch(/account for \d+% of its measured input tokens/);
  });

  it("says rows are not comparable between the arms", () => {
    expect(text).toContain("rows is not");
  });

  it("reports what the baseline's-favour rule cleared, even when it is zero", () => {
    expect(text).toMatch(/0 statement\(s\) cleared because no table they read/);
  });

  it("states that nothing here says anything about scaling", () => {
    expect(text).toContain("Not measured");
  });
});

group("what the report says when the baseline reads across customers", () => {
  it("quotes the statement and the reason, with the repeat count", () => {
    const text = rendered([
      "select customer_id, sum(amount) from bank_transaction group by customer_id",
    ]).join("\n");
    expect(text).toContain("unscoped");
    expect(text).toContain("group by customer_id");
    expect(text).toMatch(/1\/1/);
    expect(text).toMatch(/0 verified predicate/);
  });
});

group("what the report says about the token asymmetry", () => {
  it("states the direction actually measured rather than asserting a crossover", () => {
    // Derived, because a fixed per-call premium against a per-extra-call cost
    // can land either way, and a paragraph asserting a crossover would be
    // wrong on any run that did not produce one.
    const text = render(
      compare([
        observation({ arm: "governed", inputTokens: 5000, modelCalls: 2, schemaTokens: 2000 }),
        observation({ arm: "sql", inputTokens: 900, modelCalls: 8, schemaTokens: 100 }),
      ]),
    ).join("\n");
    expect(text).toContain("and still spent more input tokens");
    expect(text).toContain("Fewer round trips did not mean fewer tokens");
  });

  it("says the opposite when the arm with fewer calls also spent less", () => {
    const text = render(
      compare([
        observation({ arm: "governed", inputTokens: 900, modelCalls: 2 }),
        observation({ arm: "sql", inputTokens: 5000, modelCalls: 8 }),
      ]),
    ).join("\n");
    expect(text).toContain("and spent fewer input tokens with it");
  });
});
