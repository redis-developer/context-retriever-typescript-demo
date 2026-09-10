import type { ToolSet } from "ai";

import type { ToolTrace } from "../agent/bridge.ts";
import type { Verdict } from "./judge.ts";

/**
 * One arm of the comparison.
 *
 * This interface is the fairness invariant. Note what it has no member for: a
 * model, a system prompt, a step budget, a reasoning effort, a temperature.
 * An arm that wanted to differ on any of them has nowhere to say so, which is
 * a stronger guarantee than a reviewer noticing. `src/compare/arms/` is also
 * barred by lint from importing the model provider or the configuration, so an
 * arm cannot reach around this interface to get at one.
 *
 * What an arm is: a set of tools, a paragraph saying how to use them, and a
 * reading of its own traces. Nothing else.
 */

export interface ArmContext {
  /** The signed-in customer, as both arms are told about them. */
  readonly caller: { readonly id: string; readonly name: string };
  readonly onTrace: (trace: ToolTrace) => void;
  /**
   * One model call, for an arm whose tools need one.
   *
   * The SQL baseline's query checker is model-backed, as the standard
   * implementation's is, and those tokens are invisible to the outer turn. The
   * capability is granted here rather than imported so that two things hold at
   * once: the arm cannot choose a different model, and it cannot spend tokens
   * without them being counted, because the counting happens on this side of
   * the boundary rather than in the arm.
   */
  readonly askModel: (request: {
    readonly system: string;
    readonly prompt: string;
  }) => Promise<string>;
}

export interface Arm {
  readonly id: "governed" | "sql";
  readonly label: string;
  /**
   * How to reach data with this arm's tools.
   *
   * The only prose an arm contributes. It says nothing about the business and
   * carries no rules: both of those are in the shared brief, which an arm
   * cannot edit.
   */
  readonly toolBrief: readonly string[];
  readonly buildTools: (context: ArmContext) => Promise<ToolSet>;
  /**
   * What this arm's traces say about scoping.
   *
   * Asked of the arm rather than computed centrally, because the two arms
   * answer the question in different kinds. The governed arm's answer is
   * structural and has no denominator: no argument to any generated tool
   * expresses another customer, so there is no statement to judge and this
   * returns nothing at all. The SQL arm's answer is a reading of the
   * statements a model wrote on the day. The report keeps that difference
   * visible instead of printing two zeroes as though they were the same zero.
   */
  readonly verdicts: (traces: readonly ToolTrace[], caller: string) => readonly Verdict[];
  readonly close: () => Promise<void>;
}
