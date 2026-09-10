import type { ToolSet } from "ai";

import type { ToolTrace } from "../agent/bridge.ts";
import type { Score } from "./accuracy.ts";
import { skeletonOf, type Scoping, type Verdict } from "./judge.ts";
import type { Scenario } from "./scenarios.ts";
import { tokensOf } from "../lib/tokens.ts";

/**
 * Everything the comparison reports, computed in one place.
 *
 * One aggregation function, called by the command and by the web interface, so
 * that the terminal and the browser cannot disagree about a governance figure.
 * Two implementations would be convenient and would leave a reader with no way
 * to know which of them was lying.
 *
 * Pure: no configuration, no clock, no input or output. The tests build
 * observations by hand and assert on the arithmetic.
 */

/** Statistics shared with `npm run bench`, so both agree what a median is. */
export const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

export const sum = (values: readonly number[]): number =>
  values.reduce((total, one) => total + one, 0);

/** Pads to a fixed width so columns line up without a table library. */
export const pad = (value: string | number, width: number): string => String(value).padStart(width);

/**
 * What a tool result actually cost, rather than what it weighed.
 *
 * A result enters the message list and is re-sent on every later model call in
 * the same turn, so a result that arrived early is billed more times than a
 * late one. Reporting only its size understates schema inspection
 * specifically, because inspection happens first and is therefore carried
 * furthest, and that is exactly the cost the baseline's discovery step incurs.
 */
export const carriedTokens = (trace: ToolTrace, step: number, modelCalls: number): number =>
  trace.resultTokens * Math.max(1, modelCalls - step);

/**
 * What an arm's tool definitions cost on every model call.
 *
 * Computed from the definitions themselves rather than inferred from a
 * provider's usage, so it is known before any question is asked. This is the
 * governed arm's hidden cost and the mirror of the baseline's: sixteen
 * generated tools whose descriptions carry every indexed field's description,
 * re-sent whether a tool is used or not, against four hand-written ones.
 * Leaving it out flatters whichever arm has the smaller tool set.
 */
export const schemaTokensOf = (tools: ToolSet): number =>
  tokensOf(
    JSON.stringify(
      Object.entries(tools).map(([name, definition]) => ({
        name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      })),
    ),
  );

/** One question, answered by one arm, once. */
export interface Observation {
  readonly arm: string;
  readonly scenario: Scenario;
  /** Whether the tenant guardrail sentence was present. */
  readonly guardrail: boolean;
  readonly answer: string;
  readonly traces: readonly ToolTrace[];
  readonly stepOfCall: ReadonlyMap<string, number>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelCalls: number;
  readonly turnMs: number;
  /** Estimated tokens of this arm's tool definitions, charged on every call. */
  readonly schemaTokens: number;
  readonly verdicts: readonly Verdict[];
  readonly score: Score;
}

const retrieval = (one: Observation): readonly ToolTrace[] =>
  one.traces.filter(trace => trace.kind === "retrieval");

const inspection = (one: Observation): readonly ToolTrace[] =>
  one.traces.filter(trace => trace.kind === "inspection");

/** Estimated tokens of tool results, the one figure comparable across arms. */
const contextTokens = (one: Observation): number =>
  sum(one.traces.map(trace => trace.resultTokens));

const carried = (one: Observation, traces: readonly ToolTrace[]): number =>
  sum(
    traces.map(trace =>
      carriedTokens(trace, one.stepOfCall.get(trace.callId) ?? 0, one.modelCalls),
    ),
  );

export interface Stability {
  readonly repeats: number;
  /** How many of the repeats took the most common path. */
  readonly modal: number;
  /** How many distinct paths appeared. Reported beside `modal`, never instead. */
  readonly distinct: number;
}

/**
 * How repeatable a path was.
 *
 * `modal` is the numerator the label `2/3` promises. The obvious
 * implementation returns the count of distinct paths instead, which reads
 * backwards: three identical runs score 1/3 and a coin flip scores 2/3. That
 * mistake survives review because the default repeat count is one and `1/1` is
 * right either way, so both fields are kept here and a test asserts they
 * differ on the same input.
 */
export const stabilityOf = (signatures: readonly string[]): Stability => {
  const counts = new Map<string, number>();
  for (const signature of signatures) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  return {
    repeats: signatures.length,
    modal: [...counts.values()].reduce((most, one) => Math.max(most, one), 0),
    distinct: counts.size,
  };
};

/**
 * The path an observation took.
 *
 * Ordered tool names where the arm wrote no statements, because the governed
 * prompt prescribes an order and a reordering means the model knew something
 * different when it chose. The sorted set of normalised statements where it
 * did, because two independent statements issued in either order put the same
 * rows in the context window, and calling that instability would report noise.
 * The asymmetry is real and the report names it. Normalising through the
 * judge's own lexer makes two statements differing only in a literal count as
 * one path.
 */
export const signatureOf = (one: Observation): string => {
  const statements = one.traces.flatMap(trace => (trace.sql === undefined ? [] : [trace.sql]));
  if (statements.length > 0) {
    return statements
      .map(statement => skeletonOf(statement).text.trim())
      .sort()
      .join(" | ");
  }
  return one.traces.map(trace => trace.name).join(" > ");
};

/** One arm's figures for one scenario, at the median across repeats. */
export interface ScenarioRow {
  readonly arm: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelCalls: number;
  readonly retrievalCalls: number;
  readonly inspectionCalls: number;
  readonly rows: number;
  readonly contextTokens: number;
  readonly turnMs: number;
  readonly stability: Stability;
}

/** One arm's totals across the whole run. */
export interface ArmSummary {
  readonly arm: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelCalls: number;
  readonly turnMsMedian: number;
  /** Estimated tool-definition tokens charged on every model call. */
  readonly schemaTokensPerCall: number;
  readonly inspectionTokensMedian: number;
  readonly inspectionTokensCarried: number;
  readonly attributedShare: number;
  readonly rowsMedian: number;
  readonly contextTokensMedian: number;
  readonly statements: number;
  readonly scoping: Readonly<Record<Scoping, number>>;
  readonly nonSelect: number;
  readonly noSubjectColumnConcessions: number;
  readonly correct: number;
  readonly scored: number;
  readonly declinedWithoutRetrieving: number;
  readonly stabilityBuckets: readonly { readonly modal: number; readonly count: number }[];
}

/** A statement worth printing, with how many repeats produced it. */
export interface Finding {
  readonly scenario: string;
  readonly scoping: Scoping;
  readonly statement: string;
  readonly reason: string;
  readonly repeats: number;
  readonly of: number;
}

export interface Comparison {
  readonly arms: readonly string[];
  readonly scenarios: readonly {
    readonly scenario: Scenario;
    readonly rows: readonly ScenarioRow[];
  }[];
  readonly summaries: readonly ArmSummary[];
  readonly findings: readonly Finding[];
  /** Guardrail-off counts, keyed by arm, where the toggle was run. */
  readonly guardrailOff: readonly {
    readonly arm: string;
    readonly unscopedOn: number;
    readonly unscopedOff: number;
  }[];
  readonly repeats: number;
  readonly turns: number;
}

const scopingCounts = (verdicts: readonly Verdict[]): Record<Scoping, number> => ({
  scoped: verdicts.filter(one => one.scoping === "scoped").length,
  unscoped: verdicts.filter(one => one.scoping === "unscoped").length,
  "cannot tell": verdicts.filter(one => one.scoping === "cannot tell").length,
});

const summarise = (arm: string, all: readonly Observation[]): ArmSummary => {
  const guarded = all.filter(one => one.guardrail);
  const verdicts = guarded.flatMap(one => one.verdicts);
  const attributed = sum(
    guarded.map(one => one.schemaTokens * one.modelCalls + carried(one, one.traces)),
  );
  const providerInput = sum(guarded.map(one => one.inputTokens));

  const byScenario = new Map<string, Observation[]>();
  for (const one of guarded) {
    const key = one.scenario.question;
    byScenario.set(key, [...(byScenario.get(key) ?? []), one]);
  }
  const buckets = new Map<number, number>();
  for (const runs of byScenario.values()) {
    const { modal } = stabilityOf(runs.map(signatureOf));
    buckets.set(modal, (buckets.get(modal) ?? 0) + 1);
  }

  return {
    arm,
    inputTokens: providerInput,
    outputTokens: sum(guarded.map(one => one.outputTokens)),
    modelCalls: sum(guarded.map(one => one.modelCalls)),
    turnMsMedian: median(guarded.map(one => one.turnMs)),
    schemaTokensPerCall: median(guarded.map(one => one.schemaTokens)),
    inspectionTokensMedian: median(
      guarded.map(one => sum(inspection(one).map(t => t.resultTokens))),
    ),
    inspectionTokensCarried: median(guarded.map(one => carried(one, inspection(one)))),
    attributedShare: providerInput === 0 ? 0 : attributed / providerInput,
    rowsMedian: median(guarded.map(one => sum(retrieval(one).map(trace => trace.rows ?? 0)))),
    contextTokensMedian: median(guarded.map(contextTokens)),
    statements: verdicts.length,
    scoping: scopingCounts(verdicts),
    nonSelect: verdicts.filter(one => one.nonSelect).length,
    // Reported so that a rule working against us is visible rather than
    // assumed. With one wide table carrying the subject column on every row
    // this is zero, and the report says so: a rule that only shows up when it
    // fires is a rule nobody can check.
    noSubjectColumnConcessions: verdicts.filter(one => one.concession).length,
    correct: guarded.filter(one => one.score === "correct").length,
    scored: guarded.filter(one => one.score !== "unscored").length,
    declinedWithoutRetrieving: guarded.filter(one => retrieval(one).length === 0).length,
    stabilityBuckets: [...buckets.entries()]
      .sort((left, right) => right[0] - left[0])
      .map(([modal, count]) => ({ modal, count })),
  };
};

export const compare = (observations: readonly Observation[]): Comparison => {
  const arms = [...new Set(observations.map(one => one.arm))];
  const questions = [...new Set(observations.map(one => one.scenario.question))];
  const guarded = observations.filter(one => one.guardrail);
  const repeats = Math.max(
    1,
    guarded.filter(one => one.arm === arms[0] && one.scenario.question === questions[0]).length,
  );

  const scenarios = questions.flatMap(question => {
    const forQuestion = guarded.filter(one => one.scenario.question === question);
    const scenario = forQuestion[0]?.scenario;
    if (scenario === undefined) return [];
    return [
      {
        scenario,
        rows: arms.map(arm => {
          const runs = forQuestion.filter(one => one.arm === arm);
          return {
            arm,
            inputTokens: median(runs.map(one => one.inputTokens)),
            outputTokens: median(runs.map(one => one.outputTokens)),
            modelCalls: median(runs.map(one => one.modelCalls)),
            retrievalCalls: median(runs.map(one => retrieval(one).length)),
            inspectionCalls: median(runs.map(one => inspection(one).length)),
            rows: median(runs.map(one => sum(retrieval(one).map(trace => trace.rows ?? 0)))),
            contextTokens: median(runs.map(contextTokens)),
            turnMs: median(runs.map(one => one.turnMs)),
            stability: stabilityOf(runs.map(signatureOf)),
          };
        }),
      },
    ];
  });

  // Every statement worth printing, grouped so a reader sees how many of the
  // repeats produced it. A verdict from one repeat is a sample of one model's
  // behaviour on one day, so the denominator travels with the finding.
  const grouped = new Map<string, Finding>();
  for (const one of guarded) {
    for (const verdict of one.verdicts) {
      if (verdict.scoping === "scoped") continue;
      const statement = skeletonOf(verdict.statement).text.trim();
      const key = `${one.scenario.question}|${verdict.scoping}|${verdict.reasons.join(";")}|${statement}`;
      const existing = grouped.get(key);
      grouped.set(key, {
        scenario: one.scenario.question,
        scoping: verdict.scoping,
        statement: verdict.statement.replace(/\s+/g, " ").trim(),
        reason: verdict.reasons.join("; "),
        repeats: (existing?.repeats ?? 0) + 1,
        of: repeats,
      });
    }
  }

  const guardrailOff = arms.flatMap(arm => {
    const off = observations.filter(one => one.arm === arm && !one.guardrail);
    if (off.length === 0) return [];
    const unscoped = (set: readonly Observation[]): number =>
      sum(set.map(one => one.verdicts.filter(verdict => verdict.scoping === "unscoped").length));
    return [
      {
        arm,
        unscopedOn: unscoped(guarded.filter(one => one.arm === arm)),
        unscopedOff: unscoped(off),
      },
    ];
  });

  return {
    arms,
    scenarios,
    summaries: arms.map(arm =>
      summarise(
        arm,
        observations.filter(one => one.arm === arm),
      ),
    ),
    findings: [...grouped.values()].sort((left, right) => right.repeats - left.repeats),
    guardrailOff,
    repeats,
    turns: observations.length,
  };
};
