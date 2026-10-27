import { demoConfig } from "../config/env.ts";
import type { DomainModel } from "../domain/types.ts";
import type { SurfaceSession } from "../data-plane/session.ts";
import { buildRetrievalTools, withSessionTools, type ToolTrace } from "./bridge.ts";
import { GOVERNED_TOOL_BRIEF, buildPrompt } from "./prompt.ts";
import { runTurn } from "./turn.ts";

/**
 * One question, answered by the governed surface.
 *
 * This lives apart from the HTTP server because two callers need it and they
 * need it identically: the web interface, and `npm run bench`. A benchmark that
 * measured a different code path from the demo would report figures nobody
 * could act on.
 *
 * The model, the step budget and the usage accounting are not here. They moved
 * to `turn.ts`, which the text-to-SQL comparison also calls, so a figure from
 * `bench` and a figure from `compare` are the same kind of figure rather than
 * two similar-looking measurements taken by two copies of the same code.
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

  return async (question: string): Promise<AskResult> => {
    const traces: ToolTrace[] = [];
    const onTrace = (trace: ToolTrace): void => {
      traces.push(trace);
    };
    const context = { customer: { customerId: demo.customerId, name: demo.customerName } };
    const tools = withSessionTools(
      await buildRetrievalTools({
        session: options.session,
        domain: options.domain,
        context,
        onTrace,
      }),
      { domain: options.domain, context, onTrace },
    );

    const turn = await runTurn({
      system: buildPrompt({
        domain: options.domain,
        toolBrief: GOVERNED_TOOL_BRIEF,
        tenantGuardrail: true,
      }),
      question,
      tools,
      // The governed tools call no model of their own.
      nested: [],
    });

    return {
      answer: turn.answer,
      traces,
      usage: {
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        totalTokens: turn.usage.totalTokens,
        modelCalls: turn.usage.modelCalls,
      },
      wallMs: turn.wallMs,
      model: turn.model,
    };
  };
};
