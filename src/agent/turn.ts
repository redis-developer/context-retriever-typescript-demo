import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import type { ToolSet } from "ai";

import { agentConfig, demoConfig } from "../config/env.ts";

/**
 * One question, one model, one step budget.
 *
 * The only place in this repository that calls a model. That is the point:
 * the shipped agent and both arms of the text-to-SQL comparison come through
 * here, so a figure printed by `npm run bench` and a figure printed by
 * `npm run compare` are the same kind of figure. A comparison whose two sides
 * were driven by two copies of this function would be one edit away from
 * measuring two different things, and nothing would fail when it did.
 *
 * Nothing here knows how the tools were built. That is what makes the
 * comparison's fairness structural rather than asserted: the model, the step
 * budget and the reasoning effort are not available to an arm to choose.
 */

/** How many turns an arm may take. Ten covers the longest honest plan either has. */
const MAX_STEPS = 10;

/** Tokens spent by a model call an arm's own tool made, which `usage` cannot see. */
export interface NestedUsage {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
}

export interface TurnMeasurement {
  readonly answer: string;
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly totalTokens: number | undefined;
    readonly modelCalls: number;
    /** Of `modelCalls`, how many were made by a tool rather than by the loop. */
    readonly nestedModelCalls: number;
  };
  readonly wallMs: number;
  readonly model: string;
  /**
   * Which model call issued each tool call, by the SDK's call identifier.
   *
   * Read off the SDK's own step list rather than inferred from the order
   * traces arrived in, because two tools invoked in one step run at once and
   * an order-based guess attributes one of them to the wrong step. What it is
   * for: a tool result re-enters the message list on every later call in the
   * turn, so a result that arrived early is billed more times than a late one,
   * and that is exactly the shape of the baseline's schema-inspection cost.
   */
  readonly stepOfCall: ReadonlyMap<string, number>;
}

/**
 * Runs one turn.
 *
 * `nested` is read after the model returns rather than passed in complete,
 * because a tool that calls a model does so while `generateText` is still
 * running. The SQL baseline's query checker is such a tool, and its tokens are
 * invisible to the outer result. Leaving them out would understate the
 * baseline, which is the direction this comparison is supposed to err in, but
 * an omission to disclose is not the same as a design.
 */
export const runTurn = async (request: {
  readonly system: string;
  readonly question: string;
  readonly tools: ToolSet;
  readonly nested: readonly NestedUsage[];
}): Promise<TurnMeasurement> => {
  const demo = demoConfig();
  const { openaiApiKey } = agentConfig();
  const openai = createOpenAI({ apiKey: openaiApiKey });

  const started = performance.now();
  const result = await generateText({
    model: openai(demo.chatModel),
    system: request.system,
    prompt: request.question,
    tools: request.tools,
    // Bounded so a confused loop terminates.
    stopWhen: stepCountIs(MAX_STEPS),
    // The current OpenAI models reason by default, and the default effort buys
    // deliberation this agent does not need: the hard part is choosing among
    // sixteen tools, not thinking about the answer. Low keeps the model
    // planning across tool calls while holding the turn short, which matters
    // because latency is one of the things this repository measures.
    //
    // Not `none`, which is documented as being for tasks without
    // multi-chained tool calls, and measurably behaves that way here: on
    // `none` the agent stopped chaining and answered "I cannot narrow that"
    // to a question it answers correctly on `low`.
    providerOptions: { openai: { reasoningEffort: "low" } },
  });

  const wallMs = performance.now() - started;
  const nested = request.nested;
  const add = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);

  const nestedInput = nested.reduce<number | undefined>(
    (total, one) => add(total, one.inputTokens),
    undefined,
  );
  const nestedOutput = nested.reduce<number | undefined>(
    (total, one) => add(total, one.outputTokens),
    undefined,
  );

  const stepOfCall = new Map<string, number>();
  result.steps.forEach((step, index) => {
    for (const call of step.toolCalls) stepOfCall.set(call.toolCallId, index);
  });

  return {
    answer: result.text,
    usage: {
      // `usage` aggregates across every step, which is what a per-question
      // figure has to be: a single tool-using answer costs several model calls
      // and the tool schemas are re-sent on each one.
      inputTokens: add(result.usage.inputTokens, nestedInput),
      outputTokens: add(result.usage.outputTokens, nestedOutput),
      totalTokens: add(result.usage.totalTokens, add(nestedInput, nestedOutput)),
      modelCalls: result.steps.length + nested.length,
      nestedModelCalls: nested.length,
    },
    wallMs,
    model: demo.chatModel,
    stepOfCall,
  };
};

/**
 * One model call with no tools, for a tool that itself needs a model.
 *
 * The SQL baseline's query checker is such a tool, as the standard
 * implementation's is. It goes through here rather than through the provider
 * directly so that the checker cannot be run on a cheaper model than the arm
 * it belongs to, and so that its tokens are reported rather than lost.
 */
export const askOnce = async (request: {
  readonly system: string;
  readonly prompt: string;
}): Promise<{ readonly text: string; readonly usage: NestedUsage }> => {
  const demo = demoConfig();
  const { openaiApiKey } = agentConfig();
  const openai = createOpenAI({ apiKey: openaiApiKey });

  const result = await generateText({
    model: openai(demo.chatModel),
    system: request.system,
    prompt: request.prompt,
    providerOptions: { openai: { reasoningEffort: "low" } },
  });

  return {
    text: result.text,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
};
