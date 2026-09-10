import type { InternalTool } from "../types.ts";

/**
 * Tools the application supplies, merged with the generated ones by the bridge.
 *
 * None of them accepts an argument, and that is the point rather than an
 * omission. A `get_customer_profile` that took a customer identifier would let
 * the agent pivot to any customer by passing a different value, which is
 * precisely the failure user-scoped retrieval exists to prevent. Identity
 * flows one way: the application knows it, the tool reports it, the agent
 * consumes it.
 */
export const internalTools: readonly InternalTool[] = [
  {
    name: "get_customer_profile",
    description:
      "Returns the signed-in customer's id and name. Call this first: every other tool needs customer_id to scope its results. Takes no arguments and cannot return a different customer.",
    execute: async context => Promise.resolve(context.customer),
  },
  {
    name: "get_current_time",
    description:
      "Returns the current instant as epoch milliseconds and as an ISO 8601 string. Call this before answering anything about a period relative to now, such as the last thirty days: transaction_date is epoch milliseconds and you have no clock of your own.",
    execute: async () => {
      const now = new Date();
      return Promise.resolve({
        epoch_ms: now.getTime(),
        iso: now.toISOString(),
        timezone: "UTC",
      });
    },
  },
];

/**
 * Why there is no `dataset_overview`.
 *
 * An earlier version supplied one, reporting record counts per entity by
 * scanning the keyspace directly. It was removed rather than fixed. It read
 * over the seeding credentials, so it counted every customer's records and
 * reported them to an agent scoped to one customer, which is precisely the
 * boundary the surface's ACL exists to hold. It also put raw keyspace access on
 * the request path, in a demonstration whose claim is that the agent reaches
 * data only through the surface.
 *
 * `count_transaction` answers the same question, is generated from the schema,
 * and is scoped. An internal tool is the right place for what the application
 * knows and the schema cannot express; it is the wrong place for a second,
 * unguarded route to the data.
 */
