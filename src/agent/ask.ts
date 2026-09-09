import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";

import { agentConfig, demoConfig, redisConfig } from "../config/env.ts";
import type { DomainModel } from "../domain/types.ts";
import type { SurfaceSession } from "../data-plane/session.ts";
import { countRecords } from "../seed/seed.ts";
import { buildToolSet, systemPrompt, type ToolTrace } from "./bridge.ts";

/**
 * One question, answered.
 *
 * This lives apart from the HTTP server because two callers need it and they
 * need it identically: the web interface, and `npm run bench`. A benchmark that
 * measured a different code path from the demo would report figures nobody
 * could act on.
 */

export interface AskResult {
  readonly answer: string;
  readonly traces: readonly ToolTrace[];
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly totalTokens: number | undefined;
    readonly modelCalls: number;
  };
  readonly wallMs: number;
  readonly model: string;
}

/** How many turns the agent may take: identity, clock, retrieval, answer. */
const MAX_STEPS = 10;

/**
 * Builds the ask function against one session.
 *
 * The tool set is rebuilt per question rather than cached, because
 * `listTools()` is how the surface reports what it currently generates and a
 * long-lived process should not answer from a stale contract. It is one round
 * trip against a service answering in tens of milliseconds.
 */
export const createAsk = (options: {
  readonly session: SurfaceSession;
  readonly domain: DomainModel;
}): ((question: string) => Promise<AskResult>) => {
  const demo = demoConfig();
  const { openaiApiKey } = agentConfig();
  const openai = createOpenAI({ apiKey: openaiApiKey });

  return async (question: string): Promise<AskResult> => {
    const traces: ToolTrace[] = [];
    const tools = await buildToolSet({
      session: options.session,
      domain: options.domain,
      context: {
        customer: { customerId: demo.customerId, name: demo.customerName },
        countRecords: () => countRecords(options.domain, redisConfig().url),
      },
      onTrace: trace => traces.push(trace),
    });

    const started = performance.now();
    const result = await generateText({
      model: openai(demo.chatModel),
      system: systemPrompt(options.domain),
      prompt: question,
      tools,
      // Bounded so a confused loop terminates.
      stopWhen: stepCountIs(MAX_STEPS),
      // The current OpenAI models reason by default, and the default effort
      // buys deliberation this agent does not need: the hard part is choosing
      // among sixteen tools, not thinking about the answer. Low keeps the model
      // planning across tool calls while holding the turn short, which matters
      // because latency is one of the things this repository measures.
      //
      // Not `none`, which is documented as being for tasks without
      // multi-chained tool calls, and measurably behaves that way here: on
      // `none` the agent stopped chaining and answered "I cannot narrow that"
      // to a question it answers correctly on `low`.
      providerOptions: { openai: { reasoningEffort: "low" } },
    });

    return {
      answer: result.text,
      traces,
      usage: {
        // `usage` aggregates across every step, which is what a per-question
        // figure has to be: a single tool-using answer costs several model
        // calls and the tool schemas are re-sent on each one.
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        modelCalls: result.steps.length,
      },
      wallMs: performance.now() - started,
      model: demo.chatModel,
    };
  };
};
