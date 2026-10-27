import type { ToolSet } from "ai";

import { buildRetrievalTools } from "../../agent/bridge.ts";
import { GOVERNED_TOOL_BRIEF } from "../../agent/prompt.ts";
import type { DomainModel } from "../../domain/index.ts";
import type { SurfaceSession } from "../../data-plane/session.ts";
import type { Arm, ArmContext } from "../arm.ts";

/**
 * The governed arm: the surface this repository is about.
 *
 * Short on purpose. It builds the same tool set the shipped agent builds and
 * uses the same tool brief, so the thing being measured is the thing a reader
 * runs, not a variant assembled for the comparison. If this file grew logic of
 * its own, the comparison would stop being about the repository.
 */
export const governedArm = (options: {
  readonly session: SurfaceSession;
  readonly domain: DomainModel;
}): Arm => ({
  id: "governed",
  label: "governed",
  toolBrief: GOVERNED_TOOL_BRIEF,
  // Only the data-access tools. The session tools -- who is signed in, what
  // time it is -- are added by the runner for every arm, so neither arm can
  // have an identity capability the other lacks.
  buildTools: async (context: ArmContext): Promise<ToolSet> =>
    buildRetrievalTools({
      session: options.session,
      domain: options.domain,
      context: { customer: { customerId: context.caller.id, name: context.caller.name } },
      onTrace: context.onTrace,
    }),
  // Nothing to judge, and that is the finding rather than an omission. No
  // argument to any generated tool expresses another customer's records, so
  // this arm produces no statements and its claim carries no denominator. The
  // report says so in those words rather than printing a zero that looks like
  // the SQL arm's zero.
  verdicts: () => [],
  // The session is owned by the caller, which also uses it for the shipped
  // agent, so closing it here would close it out from under them.
  close: () => Promise.resolve(),
});
