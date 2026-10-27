import { describe as group, expect, it } from "vitest";

import type { ToolTrace } from "../src/agent/bridge.ts";
import { score } from "../src/compare/accuracy.ts";
import {
  carriedTokens,
  compare,
  median,
  signatureOf,
  stabilityOf,
  type Observation,
} from "../src/compare/metrics.ts";
import type { Scenario } from "../src/compare/scenarios.ts";

/**
 * Tests for the measurement layer.
 *
 * Numbers only, no model and no database. The two that matter most are the
 * stability numerator, which is the kind of mistake that reads correctly at
 * the default settings, and the crossover, which is the shape the report
 * exists to make legible.
 */

const trace = (over: Partial<ToolTrace> = {}): ToolTrace => ({
  name: "filter_transaction",
  kind: "retrieval",
  callId: "call-1",
  resultTokens: 100,
  args: {},
  ms: 10,
  ok: true,
  ...over,
});

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
  nestedModelCalls: 0,
  turnMs: 2000,
  schemaTokens: 700,
  verdicts: [],
  score: "unscored",
  ...over,
});

group("stability", () => {
  it("counts the repeats on the most common path, not the number of paths", () => {
    // The mistake this catches returns the count of distinct paths, so three
    // identical runs score 1/3 and a coin flip scores 2/3 -- backwards, and
    // printed into a label that reads as its opposite.
    expect(stabilityOf(["a", "a", "a"])).toEqual({ repeats: 3, modal: 3, distinct: 1 });
    expect(stabilityOf(["a", "a", "b"])).toEqual({ repeats: 3, modal: 2, distinct: 2 });
    expect(stabilityOf(["a", "b", "c"])).toEqual({ repeats: 3, modal: 1, distinct: 3 });
  });

  it("reads correctly at the default repeat count either way, which is why it hid", () => {
    expect(stabilityOf(["a"])).toEqual({ repeats: 1, modal: 1, distinct: 1 });
  });

  it("reports nothing rather than throwing on no repeats", () => {
    expect(stabilityOf([])).toEqual({ repeats: 0, modal: 0, distinct: 0 });
  });
});

group("rows drawn into context", () => {
  it("counts rows a schema-inspection call disclosed, not only retrieved ones", () => {
    // Sample rows in schema output are in the transcript exactly as a queried
    // row would be. Counting only retrieval reported the arm that inspects a
    // schema as having drawn fewer rows than it drew.
    const result = compare([
      observation({
        arm: "sql",
        traces: [
          trace({ name: "get_schema", kind: "inspection", rows: 3 }),
          trace({ name: "run_sql", rows: 1 }),
        ],
      }),
      observation({ arm: "governed" }),
    ]);
    expect(result.summaries.find(one => one.arm === "sql")?.rowsMedian).toBe(4);
  });
});

group("the path a turn took", () => {
  it("is the ordered tool names when the arm wrote no statements", () => {
    const one = observation({
      traces: [trace({ name: "get_customer_profile" }), trace({ name: "summarize_transaction" })],
    });
    expect(signatureOf(one)).toBe("get_customer_profile > summarize_transaction");
  });

  it("is the sorted set of statements when it did, so order is not instability", () => {
    // Two independent statements in either order put the same rows in the
    // context window. Calling that a different path would report noise.
    const forward = observation({
      traces: [trace({ sql: "SELECT a FROM t" }), trace({ sql: "SELECT b FROM t" })],
    });
    const reversed = observation({
      traces: [trace({ sql: "SELECT b FROM t" }), trace({ sql: "SELECT a FROM t" })],
    });
    expect(signatureOf(forward)).toBe(signatureOf(reversed));
  });

  it("treats statements differing only in a literal as one path", () => {
    const first = observation({ traces: [trace({ sql: "SELECT a FROM t WHERE x = 'p'" })] });
    const second = observation({ traces: [trace({ sql: "SELECT a FROM t WHERE x = 'q'" })] });
    expect(signatureOf(first)).toBe(signatureOf(second));
  });
});

group("what a tool result cost", () => {
  it("bills a result once for every model call strictly after the one that issued it", () => {
    // A result that arrives first is carried furthest, which is why schema
    // inspection costs more than its size suggests. The call that issued the
    // tool call is not one of them: it had already been sent before the result
    // existed, so counting it inflates every figure here.
    expect(carriedTokens(trace({ resultTokens: 100 }), 0, 4)).toBe(300);
    expect(carriedTokens(trace({ resultTokens: 100 }), 1, 4)).toBe(200);
    expect(carriedTokens(trace({ resultTokens: 100 }), 2, 4)).toBe(100);
  });

  it("bills nothing for a result no later call consumed", () => {
    // A turn that ended on the step budget leaves its last tool result unsent.
    // Flooring this at one charged for context the model never received.
    expect(carriedTokens(trace({ resultTokens: 100 }), 3, 4)).toBe(0);
    expect(carriedTokens(trace({ resultTokens: 100 }), 5, 2)).toBe(0);
  });

  it("charges a nested model call for nothing, since it is sent neither", () => {
    // The SQL baseline's query checker is a model call that receives its own
    // prompt and no tool schemas or earlier results. Passing the count that
    // includes it would charge the arm that has such a tool for context it was
    // never sent.
    const one = observation({
      modelCalls: 4,
      nestedModelCalls: 2,
      traces: [trace({ resultTokens: 100, callId: "a" })],
      stepOfCall: new Map([["a", 0]]),
    });
    // Two outer calls, so one call carried the result.
    const outer = one.modelCalls - one.nestedModelCalls;
    expect(carriedTokens(trace({ resultTokens: 100 }), 0, outer)).toBe(100);
  });
});

group("the crossover the report exists to show", () => {
  it("reports one arm dearer on an early question and cheaper across the session", () => {
    // The shape that makes a single row misleading: a fixed per-call premium
    // against a per-extra-call cost.
    const observations = [
      observation({ arm: "governed", scenario: scenario("q1"), inputTokens: 800, modelCalls: 2 }),
      observation({ arm: "sql", scenario: scenario("q1"), inputTokens: 500, modelCalls: 4 }),
      observation({ arm: "governed", scenario: scenario("q2"), inputTokens: 900, modelCalls: 2 }),
      observation({ arm: "sql", scenario: scenario("q2"), inputTokens: 2000, modelCalls: 9 }),
    ];
    const result = compare(observations);

    const q1 = result.scenarios.find(one => one.scenario.question === "q1");
    expect(q1?.rows.find(one => one.arm === "governed")?.inputTokens).toBe(800);
    expect(q1?.rows.find(one => one.arm === "sql")?.inputTokens).toBe(500);

    // Dearer on q1, cheaper over the session. Both true, and neither is the
    // comparison on its own.
    const governed = result.summaries.find(one => one.arm === "governed");
    const sql = result.summaries.find(one => one.arm === "sql");
    expect(governed?.inputTokens).toBe(1700);
    expect(sql?.inputTokens).toBe(2500);
  });

  it("emits a row for every arm on every scenario, or none", () => {
    const result = compare([
      observation({ arm: "governed" }),
      observation({ arm: "sql" }),
      observation({ arm: "governed", scenario: scenario("q2") }),
      observation({ arm: "sql", scenario: scenario("q2") }),
    ]);
    for (const entry of result.scenarios) {
      expect(entry.rows.map(one => one.arm)).toEqual(result.arms);
    }
  });

  it("excludes guardrail-off turns from the headline and reports the toggle separately", () => {
    // A run with the sentence removed is a different experiment. Folding it
    // into the totals would report the average of two conditions as one.
    const result = compare([
      observation({ arm: "sql", inputTokens: 100 }),
      observation({ arm: "sql", inputTokens: 9999, guardrail: false }),
    ]);
    expect(result.summaries.find(one => one.arm === "sql")?.inputTokens).toBe(100);
    expect(result.guardrailOff.map(one => one.arm)).toEqual(["sql"]);
  });
});

group("accuracy scoring", () => {
  it("ignores digit-group separators, which are formatting and not data", () => {
    expect(score("You spent AED 1,254,560.66.", { containsAll: ["1254560.66"] })).toBe("correct");
  });

  it("still fails a rounded figure, which is a different answer", () => {
    expect(score("You spent about AED 1.25 million.", { containsAll: ["1254560.66"] })).toBe(
      "wrong",
    );
  });

  it("fails an answer carrying an identifier it should never have seen", () => {
    expect(score("Here is 42000000000000000010.", { notContains: ["42000000000000000010"] })).toBe(
      "wrong",
    );
  });

  it("passes a notContains with nothing to look for rather than failing closed", () => {
    // Empty when the generator produced no out-of-scope identifiers. A check
    // with nothing to check must not become a check that always fails.
    expect(score("anything", { notContains: [] })).toBe("correct");
  });

  it("reports no fixture as unscored, so the denominator is the scored set", () => {
    expect(score("anything", undefined)).toBe("unscored");
  });
});

group("medians", () => {
  it("averages the middle pair on an even sample", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns zero rather than NaN on an empty sample", () => {
    expect(median([])).toBe(0);
  });
});
