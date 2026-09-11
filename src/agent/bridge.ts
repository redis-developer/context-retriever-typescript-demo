import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";

import type { DomainModel, InternalToolContext } from "../domain/index.ts";
import type { SurfaceSession } from "../data-plane/session.ts";
import { callTimed } from "../data-plane/retrieve.ts";
import { resultTokensOf } from "../lib/tokens.ts";

/**
 * Where the agent meets the surface.
 *
 * This is the module worth reading closely, because it is where three
 * decisions live.
 *
 * First, the retrieval tools are discovered, never declared. Names and
 * argument shapes are generated from the surface's data model, so they are not
 * known when this code is written. They changed materially between two
 * adjacent patch releases of the engine, so anything that hard-coded a name
 * would already be broken. Each tool's `inputSchema` is handed to the model
 * through the AI SDK's `jsonSchema()` helper exactly as the service supplied
 * it.
 *
 * Second, the model gets one flat tool list assembled from two sources. The
 * generated tools answer questions about business data; they cannot answer who
 * is signed in or what time it is, because those are properties of the session
 * rather than the data. Internal tools fill that gap and run locally.
 *
 * Third, and most important: a tool result is data. It is returned by a service
 * over the network, sourced from records this application may not fully
 * control, and it is not an instruction. Results reach the model only as tool
 * output. Nothing retrieved is ever interpolated into the system prompt, and
 * the server-supplied `description` and `inputSchema` are used for discovery
 * and never treated as trusted configuration.
 */

/**
 * What a call costs, not which arm made it.
 *
 * `retrieval` is any call that left the process to fetch data, so a governed
 * `filter_transaction` and the SQL baseline's `run_sql` are the same kind and
 * land in the same medians. Giving the baseline its own member would have been
 * the obvious change and the wrong one: `bench` filters on `retrieval`, so a
 * separate member would compile, match nothing, and report the baseline as
 * having made no retrieval calls at no latency. A plausible wrong number is
 * the worst failure available.
 *
 * `inspection` is the third category and the reason this union grew: a call
 * that returns no rows and still puts data in the context window. A
 * schema-inspection tool embeds sample rows by default, so it is neither
 * retrieval nor free, and folding it into either hides the cost of the
 * baseline's discovery step.
 */
export type ToolKind = "retrieval" | "internal" | "inspection";

/** One tool call, as the interface shows it and as the report measures it. */
export interface ToolTrace {
  readonly name: string;
  readonly kind: ToolKind;
  /**
   * The SDK's own identifier for the call.
   *
   * Carried so the turn can say which model call issued it. A tool result
   * re-enters the message list on every later call in the same turn, so a
   * result's real cost depends on how early it arrived, and guessing the step
   * from the order traces arrived in is wrong whenever two tools run at once.
   */
  readonly callId: string;
  /** Estimated tokens of the result handed back to the model. */
  readonly resultTokens: number;
  readonly args: Record<string, unknown>;
  readonly ms: number;
  readonly ok: boolean;
  /** Rows returned, where the result carried a countable set. */
  readonly rows?: number;
  /**
   * Why the call was refused, when it was. A failed call with no reason shown
   * is the least useful thing a trace can display: the whole point of showing
   * the trace is that the audience can see the surface refusing, and see on
   * what grounds.
   */
  readonly error?: string;
  /** The statement, verbatim, when the call executed one. The judge reads this. */
  readonly sql?: string;
  /** Tables the call touched or revealed, when it was not a statement. */
  readonly tables?: readonly string[];
}

export interface BridgeOptions {
  readonly session: SurfaceSession;
  readonly domain: DomainModel;
  readonly context: InternalToolContext;
  /** Called for every tool invocation, in order. */
  readonly onTrace: (trace: ToolTrace) => void;
}

const rowCountOf = (payload: unknown): number | undefined => {
  if (payload === null || typeof payload !== "object") return undefined;
  const candidate = payload as Record<string, unknown>;
  if (Array.isArray(candidate["results"])) return candidate["results"].length;
  if (Array.isArray(candidate["ids"])) return candidate["ids"].length;
  return undefined;
};

/** Every discovered retrieval tool. The generated surface, and nothing else. */
export const buildRetrievalTools = async (options: BridgeOptions): Promise<ToolSet> => {
  const discovered = await options.session.listTools();
  const tools: ToolSet = {};

  for (const discoveredTool of discovered) {
    tools[discoveredTool.name] = tool({
      description: discoveredTool.description ?? `Retrieval tool ${discoveredTool.name}`,
      // The service's own schema, handed through unchanged. It is untrusted as
      // configuration but it is exactly what this surface accepts.
      inputSchema: jsonSchema<Record<string, unknown>>(discoveredTool.inputSchema),
      execute: async (callArgs: Record<string, unknown>, { toolCallId }) => {
        const outcome = await callTimed(options.session, discoveredTool.name, callArgs);
        const rows = rowCountOf(outcome.payload);
        // Returned as data. `isError: true` is a normal protocol outcome, so
        // the reason is passed back for the model to read rather than thrown.
        const returned = outcome.toolReportedError ? { error: outcome.text } : outcome.payload;
        options.onTrace({
          name: discoveredTool.name,
          kind: "retrieval",
          callId: toolCallId,
          resultTokens: resultTokensOf(returned),
          args: callArgs,
          ms: outcome.ms,
          ok: !outcome.toolReportedError,
          ...(rows === undefined ? {} : { rows }),
          ...(outcome.toolReportedError ? { error: outcome.text } : {}),
        });
        return returned;
      },
    });
  }

  return tools;
};

/**
 * The tools that answer questions about the session rather than about the data.
 *
 * Who is signed in, and what time it is. Neither is a property of the records,
 * so neither belongs to a way of reaching them: an agent writing SQL needs the
 * caller's identity exactly as much as an agent calling generated tools, and in
 * production both get it from a validated token rather than from a query.
 *
 * That is why the comparison hands these to both of its arms, through
 * `withSessionTools` below rather than through either arm. Without them the
 * SQL baseline had no way to learn which customer it was serving and asked the
 * user for their customer id instead, which measured a missing capability and
 * called it a governance result.
 *
 * Taking no arguments is the security property. A tool accepting a customer id
 * would let the model ask about a different customer.
 */
export const buildInternalTools = (options: {
  readonly domain: DomainModel;
  readonly context: InternalToolContext;
  readonly onTrace: (trace: ToolTrace) => void;
}): ToolSet => {
  const tools: ToolSet = {};
  for (const internal of options.domain.internalTools) {
    tools[internal.name] = tool({
      description: internal.description,
      // No properties, and none accepted. An internal tool that took a
      // customer identifier would let the model ask for a different customer.
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async (_args: Record<string, never>, { toolCallId }) => {
        const started = performance.now();
        const result = await internal.execute(options.context);
        options.onTrace({
          name: internal.name,
          kind: "internal",
          callId: toolCallId,
          resultTokens: resultTokensOf(result),
          args: {},
          ms: performance.now() - started,
          ok: true,
        });
        return result;
      },
    });
  }

  return tools;
};

/**
 * Adds the session tools to a set of data-access tools.
 *
 * One definition, used by the shipped agent and by every arm of the
 * comparison, so the shipped agent and the arm that measures it hold the same
 * tools rather than two lists that happen to match today.
 */
export const withSessionTools = (
  dataTools: ToolSet,
  options: {
    readonly domain: DomainModel;
    readonly context: InternalToolContext;
    readonly onTrace: (trace: ToolTrace) => void;
  },
): ToolSet => ({ ...dataTools, ...buildInternalTools(options) });
