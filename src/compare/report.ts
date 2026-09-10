import { formatMs } from "../lib/errors.ts";
import type { Comparison, ScenarioRow } from "./metrics.ts";
import { pad } from "./metrics.ts";

/**
 * The comparison as text.
 *
 * Returns lines rather than printing them, so the wording of a governance
 * claim is testable. The renderer is the one place a figure can be mislabelled
 * without any arithmetic being wrong.
 *
 * Two structural guards against overclaiming, rather than a warning that a
 * reader can skip. The session block is emitted first, by a function that
 * cannot be called with one arm. And every per-question entry emits both arms'
 * rows from a single loop over a pair, so there is no code path that produces
 * one arm's row without the other's.
 */

const heading = (title: string): readonly string[] => ["", title, "-".repeat(title.length), ""];

const width = 10;

/** One labelled row across every arm, so a figure never appears alone. */
const row = (label: string, values: readonly (string | number)[]): string =>
  `  ${label.padEnd(28)}${values.map(value => pad(value, width)).join("")}`;

const session = (comparison: Comparison): readonly string[] => {
  const summaries = comparison.summaries;
  return [
    ...heading("Session"),
    `  ${"".padEnd(28)}${summaries.map(one => pad(one.arm, width)).join("")}`,
    row(
      "input tokens",
      summaries.map(one => one.inputTokens.toLocaleString("en-GB")),
    ),
    row(
      "output tokens",
      summaries.map(one => one.outputTokens.toLocaleString("en-GB")),
    ),
    row(
      "model calls",
      summaries.map(one => one.modelCalls),
    ),
    row(
      "turn ms, median",
      summaries.map(one => one.turnMsMedian.toFixed(0)),
    ),
    "",
    "  Quote this block, or one question below with both its rows.",
  ];
};

const scenarioRow = (one: ScenarioRow): string =>
  `    ${one.arm.padEnd(10)}${pad(one.inputTokens.toFixed(0), 7)} in ${pad(one.outputTokens.toFixed(0), 6)} out ` +
  `${pad(one.modelCalls.toFixed(0), 3)} calls ${pad(one.retrievalCalls.toFixed(0), 3)} data ` +
  `${pad(one.inspectionCalls.toFixed(0), 3)} insp ${pad(one.contextTokens.toFixed(0), 6)} ctx ` +
  `${pad(one.turnMs.toFixed(0), 7)} ms  ${String(one.stability.modal)}/${String(one.stability.repeats)}`;

const perQuestion = (comparison: Comparison): readonly string[] => [
  ...heading(`Per question, median of ${String(comparison.repeats)}`),
  ...comparison.scenarios.flatMap(entry => [
    `  ${entry.scenario.question}`,
    ...entry.rows.map(scenarioRow),
    "",
  ]),
];

/**
 * What the two hidden costs added up to, said in the direction measured.
 *
 * Derived rather than written, because the interesting outcome is not fixed.
 * A tool-schema premium charged on every call and a discovery cost charged per
 * extra call can land either way, and a paragraph asserting a crossover would
 * be wrong on any run that did not produce one.
 */
const schemaVerdict = (comparison: Comparison): readonly string[] => {
  const byCalls = [...comparison.summaries].sort(
    (left, right) => left.modelCalls - right.modelCalls,
  );
  const fewer = byCalls[0];
  const more = byCalls[byCalls.length - 1];
  if (fewer === undefined || more === undefined || fewer.arm === more.arm) return [];

  const lines = [
    "  A tool schema is charged on every model call. Inspection output is charged",
    "  once and again on every later call in the same turn, which is what `carried`",
    `  reports. So ${fewer.arm} pays a fixed amount per call and ${more.arm} pays more the`,
    "  more calls it makes.",
    "",
    `  Measured here: ${fewer.arm} made ${String(fewer.modelCalls)} model call(s) against ` +
      `${more.arm}'s ${String(more.modelCalls)},`,
  ];

  if (fewer.inputTokens > more.inputTokens) {
    lines.push(
      `  and still spent more input tokens, ${fewer.inputTokens.toLocaleString("en-GB")} against ` +
        `${more.inputTokens.toLocaleString("en-GB")},`,
      `  because its tool schemas cost ${fewer.schemaTokensPerCall.toFixed(0)} tok a call against ` +
        `${more.schemaTokensPerCall.toFixed(0)}.`,
      "  Fewer round trips did not mean fewer tokens. The tool surface is the reason,",
      "  and curating the index set is what moves it.",
    );
  } else {
    lines.push(
      `  and spent fewer input tokens with it, ${fewer.inputTokens.toLocaleString("en-GB")} against ` +
        `${more.inputTokens.toLocaleString("en-GB")}.`,
      `  Its ${fewer.schemaTokensPerCall.toFixed(0)} tok of tool schemas per call did not outweigh the calls it saved.`,
    );
  }

  return lines;
};

const hiddenCosts = (comparison: Comparison): readonly string[] => [
  ...heading("Hidden costs"),
  "  Neither figure appears in a provider's usage report.",
  "",
  ...comparison.summaries.flatMap(one => [
    `  ${one.arm.padEnd(10)} tool schemas, per model call   ${pad(one.schemaTokensPerCall.toFixed(0), 6)} tok est.`,
    `  ${one.arm.padEnd(10)} inspection output              ${pad(one.inspectionTokensMedian.toFixed(0), 6)} tok median, ` +
      `${one.inspectionTokensCarried.toFixed(0)} carried`,
  ]),
  "",
  ...schemaVerdict(comparison),
  "",
  ...comparison.summaries.map(
    one =>
      `  ${one.arm.padEnd(10)} the two figures above account for ${(one.attributedShare * 100).toFixed(0)}% ` +
      `of its measured input tokens`,
  ),
  "",
  "  That share is how far to trust the estimate, and it is the reason it is",
  "  printed. Above 100% the four-characters-per-token rule is over-counting,",
  "  which it does on schema text: a tool definition is dense punctuation and",
  "  repeated keys, and a real tokeniser packs more of it into each token than",
  "  prose. Read the two arms against each other, not either against its own",
  "  provider total.",
];

const rowsAndBytes = (comparison: Comparison): readonly string[] => [
  ...heading("Rows and bytes drawn into context"),
  ...comparison.summaries.map(
    one =>
      `  ${one.arm.padEnd(10)} ${pad(one.rowsMedian.toFixed(0), 5)} row(s) per turn, ${one.contextTokensMedian.toFixed(0)} ctx tok, both median`,
  ),
  "",
  "  ctx tok is comparable: it is the result text handed to the model, measured",
  "  the same way on both sides. rows is not, so no ratio is shown. One arm",
  "  reports what a tool declared it returned, and an aggregate answers with one",
  "  number and no rows. The other reports the driver's own count.",
];

const governance = (comparison: Comparison): readonly string[] => {
  const lines: string[] = [
    ...heading("Governance"),
    "  Judged per repeat from the statements each arm generated.",
    "",
    `  ${"arm".padEnd(10)}statements    scoped  unscoped  cannot tell  non-SELECT`,
  ];

  for (const one of comparison.summaries) {
    if (one.statements === 0) {
      lines.push(
        `  ${one.arm.padEnd(10)}${pad(0, 10)}${pad("--", 10)}${pad("--", 10)}${pad("--", 13)}${pad("--", 12)}`,
      );
      continue;
    }
    lines.push(
      `  ${one.arm.padEnd(10)}${pad(one.statements, 10)}${pad(one.scoping.scoped, 10)}` +
        `${pad(one.scoping.unscoped, 10)}${pad(one.scoping["cannot tell"], 13)}${pad(one.nonSelect, 12)}`,
    );
  }

  for (const scoping of ["unscoped", "cannot tell"] as const) {
    const findings = comparison.findings.filter(one => one.scoping === scoping);
    if (findings.length === 0) continue;
    lines.push("", `  ${scoping}`);
    for (const finding of findings) {
      lines.push(`    ${String(finding.repeats)}/${String(finding.of)}  ${finding.scenario}`);
      lines.push(`          ${finding.statement}`);
      lines.push(`          ${finding.reason}`);
    }
  }

  const structural = comparison.summaries.filter(one => one.statements === 0);
  if (structural.length > 0) {
    lines.push("");
    for (const one of structural) {
      lines.push(
        `  ${one.arm}: unreachable, structurally. No model was called for this line. No tool`,
        "  argument expresses another customer, so there is no statement to judge and this",
        "  claim has no denominator.",
      );
    }
  }

  lines.push(
    "",
    "  The three columns are counted separately and never added. A cannot tell is",
    "  neither a pass nor a violation: the judge recognises a single-quoted equality",
    "  and declines the rest.",
  );

  for (const one of comparison.summaries) {
    if (one.statements === 0) continue;
    lines.push(
      `  ${one.arm}: ${String(one.noSubjectColumnConcessions)} statement(s) cleared because no table they read`,
      "  carries a subject column, a rule that resolves doubt in this arm's favour.",
    );
  }

  for (const toggle of comparison.guardrailOff) {
    lines.push(
      "",
      `  guardrail sentence removed: ${toggle.arm} went from ${String(toggle.unscopedOn)} unscoped to ${String(toggle.unscopedOff)}.`,
    );
  }

  return lines;
};

const accuracy = (comparison: Comparison): readonly string[] => [
  ...heading("Accuracy"),
  `  ${"arm".padEnd(10)}   correct    scored`,
  ...comparison.summaries.map(
    one => `  ${one.arm.padEnd(10)}${pad(one.correct, 10)}${pad(one.scored, 10)}`,
  ),
  "",
  "  Fixtures over known generated values, scored identically for both arms.",
  "  Reported rather than headlined: the internal benchmark found no significant",
  "  difference on correctness, and this is too small a set to find one either.",
  "",
  ...comparison.summaries.map(
    one =>
      `  ${one.arm.padEnd(10)}${pad(one.declinedWithoutRetrieving, 4)} turn(s) answered without retrieving anything`,
  ),
];

const stability = (comparison: Comparison): readonly string[] => {
  const modals = [
    ...new Set(
      comparison.summaries.flatMap(one => one.stabilityBuckets.map(bucket => bucket.modal)),
    ),
  ].sort((left, right) => right - left);
  return [
    ...heading(`Stability across ${String(comparison.repeats)} repeats`),
    `  ${"arm".padEnd(10)}${modals.map(modal => pad(`${String(modal)}/${String(comparison.repeats)}`, 6)).join("")}`,
    ...comparison.summaries.map(
      one =>
        `  ${one.arm.padEnd(10)}` +
        modals
          .map(modal =>
            pad(one.stabilityBuckets.find(bucket => bucket.modal === modal)?.count ?? 0, 6),
          )
          .join(""),
    ),
    "",
    "  How many questions took the most common path in that many repeats. One arm's",
    "  path is its ordered tool names; the other's is its set of statements,",
    "  normalised and sorted, because two statements in either order draw the same",
    "  rows.",
  ];
};

const closing = (): readonly string[] => [
  ...heading("What this compares, and what it does not"),
  "  Measured: tokens, model calls, latency, bytes drawn into context, statement",
  "  scoping, path stability, and correctness against known-answer fixtures.",
  "",
  "  Not measured: anything about how either side scales. The dataset is 400 rows",
  "  on one local node and both stores are on loopback, which is what makes the",
  "  latency figures comparable and also what makes them useless for sizing.",
];

/**
 * The whole report.
 *
 * There is deliberately no way to render one section. A presenter who could
 * print the per-question block on its own would be able to quote a row whose
 * sign the hidden-cost block explains.
 */
export const render = (comparison: Comparison): readonly string[] => [
  `${String(comparison.scenarios.length)} question(s) x ${String(comparison.repeats)} repeat(s) x ` +
    `${String(comparison.arms.length)} arm(s) = ${String(comparison.turns)} model turn(s).`,
  "Token figures are estimated at four characters per token, the same way on both",
  "arms, so the ratios hold and the absolute numbers are approximate.",
  ...session(comparison),
  ...perQuestion(comparison),
  ...hiddenCosts(comparison),
  ...rowsAndBytes(comparison),
  ...governance(comparison),
  ...accuracy(comparison),
  ...stability(comparison),
  ...closing(),
];

/** Re-exported so a caller does not import two modules to print a duration. */
export { formatMs };
