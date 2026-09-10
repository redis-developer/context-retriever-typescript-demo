import { withSessionTools, type ToolTrace } from "../agent/bridge.ts";
import { buildPrompt } from "../agent/prompt.ts";
import { askOnce, runTurn, type NestedUsage } from "../agent/turn.ts";
import type { DomainModel } from "../domain/index.ts";
import { score } from "./accuracy.ts";
import type { Arm } from "./arm.ts";
import { schemaTokensOf, type Observation } from "./metrics.ts";
import type { Scenario } from "./scenarios.ts";

/**
 * The only way an arm is run.
 *
 * Both arms come through this function, and it is the function that decides
 * the model, the prompt scaffold and the step budget, so neither arm can
 * differ on any of them. What an arm contributes is its tool set and one block
 * of prose; everything else here is shared by construction rather than by
 * convention.
 *
 * The two arms are run one after another rather than at once, deliberately.
 * Asking both concurrently makes them contend for the same process and the
 * same rate limit, and their latencies converge on each other: the reference
 * implementation once reported 3339 ms against 3329 ms, a dead tie produced
 * entirely by contention. Sequential costs wall-clock and buys a number worth
 * quoting.
 */
export const runArm = async (options: {
  readonly arm: Arm;
  readonly scenario: Scenario;
  readonly domain: DomainModel;
  readonly caller: { readonly id: string; readonly name: string };
  readonly guardrail: boolean;
}): Promise<Observation> => {
  const traces: ToolTrace[] = [];
  const nested: NestedUsage[] = [];

  const onTrace = (trace: ToolTrace): void => {
    traces.push(trace);
  };

  const dataTools = await options.arm.buildTools({
    caller: options.caller,
    onTrace,
    // Wired here rather than handed to the arm as a provider, so that an arm
    // cannot spend model tokens without them being counted. The counting is on
    // this side of the boundary.
    askModel: async request => {
      const { text, usage } = await askOnce(request);
      nested.push(usage);
      return text;
    },
  });

  // Added here rather than by the arm, so an arm cannot be given an identity
  // or a clock the other lacks. Without them the SQL baseline had no way to
  // learn which customer it was serving, and asked the user for their customer
  // id instead: a missing capability reported as a governance result.
  const tools = withSessionTools(dataTools, {
    domain: options.domain,
    context: { customer: { customerId: options.caller.id, name: options.caller.name } },
    onTrace,
  });

  const turn = await runTurn({
    system: buildPrompt({
      domain: options.domain,
      toolBrief: options.arm.toolBrief,
      tenantGuardrail: options.guardrail,
    }),
    question: options.scenario.question,
    tools,
    nested,
  });

  return {
    arm: options.arm.id,
    scenario: options.scenario,
    guardrail: options.guardrail,
    answer: turn.answer,
    traces,
    stepOfCall: turn.stepOfCall,
    inputTokens: turn.usage.inputTokens ?? 0,
    outputTokens: turn.usage.outputTokens ?? 0,
    modelCalls: turn.usage.modelCalls,
    turnMs: turn.wallMs,
    schemaTokens: schemaTokensOf(tools),
    verdicts: options.arm.verdicts(traces, options.caller.id),
    score: score(turn.answer, options.scenario.expect),
  };
};
