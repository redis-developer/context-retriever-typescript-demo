import { dataPlaneConfig, demoConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { SurfaceSession } from "../../data-plane/session.ts";
import { createAsk } from "../../agent/ask.ts";
import { QUESTIONS, type BenchQuestion } from "../../agent/questions.ts";
import { formatMs } from "../../lib/errors.ts";

/**
 * Runs the committed question set and reports what each answer cost.
 *
 * The interface reports the same figures for a single question, which is enough
 * to make a point on a screen and not enough to quote in a document. Three
 * things this adds are the reason it exists.
 *
 * It separates retrieval latency from turn latency. They differ by three orders
 * of magnitude, and reporting only the second buries the number this
 * repository is about.
 *
 * It separates the first question from the rest. The first pays for the MCP
 * connection and the first tool discovery, so quoting a cold figure as typical
 * overstates steady-state cost, and quoting a warm figure as typical hides a
 * real first-request cost from anyone sizing a deployment.
 *
 * And it repeats. A single run of a model-driven question set is a sample of
 * one: the same question can produce a different tool plan on consecutive
 * attempts, so a figure without a spread beside it invites a conclusion the
 * data does not support.
 *
 * This command calls a live model once per question per repeat, so it costs
 * money. Nothing else in this repository does.
 */

interface Observation {
  readonly question: BenchQuestion;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turnMs: number;
  readonly retrievalCalls: number;
  readonly retrievalMs: number;
  readonly rowsReturned: number;
  readonly refusedCalls: number;
  /** True when the answer retrieved nothing, which for a refusal is correct. */
  readonly declined: boolean;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

const sum = (values: readonly number[]): number => values.reduce((total, one) => total + one, 0);

/** Pads to a fixed width so columns line up without a table library. */
const pad = (value: string | number, width: number): string => String(value).padStart(width);

export const bench = async (options: { readonly repeat: number }): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const { mcpUrl, agentApiKey } = dataPlaneConfig();
  const session = new SurfaceSession({ mcpUrl, agentApiKey });
  const ask = createAsk({ session, domain });

  const totalTurns = QUESTIONS.length * options.repeat;
  console.log(
    `${String(QUESTIONS.length)} question(s), ${String(options.repeat)} repeat(s), ${String(totalTurns)} model turn(s) against ${demo.chatModel}.`,
  );
  console.log("This calls a live model and therefore costs money.");

  const observations: Observation[] = [];

  try {
    for (let round = 1; round <= options.repeat; round += 1) {
      for (const question of QUESTIONS) {
        const result = await ask(question.question);
        const retrieval = result.traces.filter(trace => trace.kind === "retrieval");
        observations.push({
          question,
          modelCalls: result.usage.modelCalls,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          turnMs: result.wallMs,
          retrievalCalls: retrieval.length,
          retrievalMs: sum(retrieval.map(trace => trace.ms)),
          rowsReturned: sum(retrieval.map(trace => trace.rows ?? 0)),
          refusedCalls: retrieval.filter(trace => !trace.ok).length,
          declined: retrieval.length === 0,
        });
        process.stdout.write(".");
      }
    }
    console.log("");

    console.log("");
    console.log("Per question, median across repeats");
    console.log("-----------------------------------");
    console.log("");
    console.log("  in tok   out tok  calls  retr  retr ms   turn ms  rows  question");
    for (const question of QUESTIONS) {
      const runs = observations.filter(one => one.question === question);
      console.log(
        `  ${pad(median(runs.map(one => one.inputTokens)), 6)}   ` +
          `${pad(median(runs.map(one => one.outputTokens)), 7)}  ` +
          `${pad(median(runs.map(one => one.modelCalls)), 5)}  ` +
          `${pad(median(runs.map(one => one.retrievalCalls)), 4)}  ` +
          `${pad(median(runs.map(one => one.retrievalMs)).toFixed(1), 7)}  ` +
          `${pad(median(runs.map(one => one.turnMs)).toFixed(0), 8)}  ` +
          `${pad(median(runs.map(one => one.rowsReturned)), 4)}  ` +
          question.question,
      );
    }

    // Retrieval against turn. The whole point of separating them.
    const allRetrieval = observations.flatMap(one =>
      one.retrievalCalls === 0 ? [] : [one.retrievalMs / one.retrievalCalls],
    );
    const first = observations.slice(0, QUESTIONS.length === 0 ? 0 : 1);
    const rest = observations.slice(1);

    console.log("");
    console.log("Where the time goes");
    console.log("-------------------");
    console.log("");
    console.log(
      `  retrieval, per call      median ${formatMs(median(allRetrieval))} over ${String(allRetrieval.length)} call(s)`,
    );
    console.log(
      `  a whole turn             median ${formatMs(median(observations.map(one => one.turnMs)))}`,
    );
    const retrievalShare =
      median(observations.map(one => one.retrievalMs)) /
      Math.max(median(observations.map(one => one.turnMs)), 1);
    console.log(
      `  retrieval's share of a turn  ${(retrievalShare * 100).toFixed(1)}%, so the model is the cost`,
    );

    console.log("");
    console.log("Cold against warm");
    console.log("-----------------");
    console.log("");
    if (rest.length === 0) {
      console.log("  Only one turn was run, so there is nothing to compare it against.");
    } else {
      console.log(
        `  first turn of the process   ${formatMs(median(first.map(one => one.turnMs)))}, which pays for the MCP connection and the first tool discovery`,
      );
      console.log(
        `  every turn after it         ${formatMs(median(rest.map(one => one.turnMs)))} median`,
      );
    }

    console.log("");
    console.log("Stability");
    console.log("---------");
    console.log("");
    if (options.repeat < 2) {
      console.log("  One repeat, so no spread is reported. Use --repeat 3 or more before");
      console.log("  quoting any figure above: the same question can produce a different");
      console.log("  tool plan on consecutive attempts.");
    } else {
      let unstable = 0;
      for (const question of QUESTIONS) {
        const runs = observations.filter(one => one.question === question);
        const plans = new Set(runs.map(one => one.retrievalCalls));
        if (plans.size > 1) {
          unstable += 1;
          console.log(
            `  varied   ${question.question} took ${[...plans].sort((left, right) => left - right).join(" or ")} retrieval call(s)`,
          );
        }
      }
      if (unstable === 0) {
        console.log(`  Every question took the same number of retrieval calls on each repeat.`);
      }
    }

    const wrongShape = observations.filter(
      one => one.question.expect === "refusal" && !one.declined && one.rowsReturned > 0,
    );
    const refusals = sum(observations.map(one => one.refusedCalls));

    console.log("");
    console.log("Guardrails observed while measuring");
    console.log("-----------------------------------");
    console.log("");
    console.log(
      `  ${String(refusals)} tool call(s) refused by the service across ${String(observations.length)} turn(s)`,
    );
    console.log(
      `  ${String(observations.filter(one => one.question.expect === "refusal" && one.declined).length)} turn(s) correctly answered without retrieving anything`,
    );
    if (wrongShape.length > 0) {
      console.log("");
      console.log(
        `  Note: ${String(wrongShape.length)} turn(s) retrieved rows for a question expected to be`,
      );
      console.log("  declined. That is not necessarily wrong, because retrieving rows and then");
      console.log("  declining to total them is a correct answer here, but the answers are");
      console.log("  worth reading rather than trusting.");
    }
  } finally {
    await session.close();
  }
};
