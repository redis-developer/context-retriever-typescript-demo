import { dataPlaneConfig, demoConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { callTimed, parseRecords } from "../../data-plane/retrieve.ts";
import { SurfaceSession } from "../../data-plane/session.ts";
import { entityTool, findTool } from "../../data-plane/tools.ts";
import { display, formatMs } from "../../lib/errors.ts";

/**
 * Answers one real question across both entities, showing every stage.
 *
 * The question is "how much have I sent to counterparties matching this
 * text?", which no single tool answers. It needs a lexical search on one
 * entity, an aggregation on another, and a join between them. Each stage
 * prints its tool, its arguments and its duration, so a reader can see which
 * part the surface did and which part this code did.
 *
 * The aggregation is the point. Asking for grouped totals returns one small
 * result whatever the row count; asking for the rows and adding them up
 * returns everything, and the model pays for all of it.
 */

/** `expand_results` answers with Redis keys, so the bare identifier is extracted. */
const bareId = (key: string): string => key.slice(key.lastIndexOf(":") + 1);

export const compose = async (options: { readonly query: string }): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const { mcpUrl, agentApiKey } = dataPlaneConfig();
  const session = new SurfaceSession({ mcpUrl, agentApiKey });

  try {
    const tools = await session.listTools();
    const searchBeneficiary = entityTool(tools, "search", "beneficiary", "by_text");
    const summarize = entityTool(tools, "summarize", "transaction");
    const filterTransaction = entityTool(tools, "filter", "transaction");
    const expand = findTool(tools, "expand_results");
    const getBeneficiary = entityTool(tools, "get", "beneficiary", "by_id");
    if (
      searchBeneficiary === undefined ||
      summarize === undefined ||
      filterTransaction === undefined
    ) {
      throw new Error("this surface does not expose the tools this demonstration needs");
    }

    console.log(`Question: how much have I sent to counterparties matching "${options.query}"?`);
    console.log("");

    // Stage 1: lexical search on the counterparty entity.
    const found = await callTimed(session, searchBeneficiary.name, {
      query: options.query,
      limit: 10,
    });
    const beneficiarySchema = domain.resultSchemas["beneficiary"];
    const matched =
      beneficiarySchema === undefined ? [] : parseRecords(found.payload, beneficiarySchema).records;
    console.log(
      `1. ${searchBeneficiary.name}  query=${JSON.stringify(options.query)}  ${formatMs(found.ms)}`,
    );
    for (const record of matched) {
      const row = record as Record<string, unknown>;
      console.log(
        `     ${display(row["beneficiary_name"])}  [bank: ${display(row["beneficiary_bank"])}]`,
      );
    }
    // Worth showing the bank: a text search covers every text-indexed field on
    // the entity, so a term can match the counterparty's name or its bank. Rows
    // that look like false positives usually matched the other field.
    console.log("     (search covers every text-indexed field, so the bank matches too)");
    if (matched.length === 0) {
      console.log("     no counterparties matched, so there is nothing to total");
      return;
    }

    // Stage 2: one aggregation over every transaction the session can see.
    // Grouping by counterparty gives every total at once, so the join happens
    // here rather than in a request per counterparty. Note that summarize takes
    // no conditions: it aggregates the whole visible set, which is why the
    // selection is done by grouping and then picking.
    const totals = await callTimed(session, summarize.name, {
      function: "sum",
      field: "amount",
      group_by: "beneficiary_id",
      limit: 100,
    });
    const groups =
      (totals.payload as { groups?: readonly { group_value?: unknown; value?: unknown }[] })
        .groups ?? [];
    console.log("");
    console.log(
      `2. ${summarize.name}  sum(amount) grouped by beneficiary_id  ${formatMs(totals.ms)}`,
    );
    console.log(`     ${String(groups.length)} counterparty totals in one call, no rows returned`);

    // Stage 3: the join, done here because it spans two entities.
    const byId = new Map(groups.map(group => [display(group.group_value), display(group.value)]));
    console.log("");
    console.log("3. join, performed by this code rather than by the surface");
    let answered = 0;
    for (const record of matched) {
      const row = record as Record<string, unknown>;
      const id = display(row["beneficiary_id"]);
      const total = byId.get(id);
      if (total === undefined) continue;
      answered += 1;
      console.log(
        `     ${display(row["beneficiary_name"])}: ${total} (${display(row["beneficiary_country"])})`,
      );
    }
    if (answered === 0)
      console.log("     matched counterparties, but none of them have transactions");
    console.log("");
    console.log("Totals are per counterparty and each counterparty settles in one");
    console.log("currency here, so these are comparable. Across mixed currencies they");
    console.log("would not be; see `npm run guardrails`.");

    // The contrast that makes the token argument concrete.
    const rows = await callTimed(session, filterTransaction.name, {
      tag_conditions: [
        {
          field: "beneficiary_id",
          value: display((matched[0] as Record<string, unknown>)["beneficiary_id"]),
        },
      ],
      limit: 100,
    });
    const rowCount = (rows.payload as { total_count?: unknown }).total_count;
    console.log("");
    console.log("Cost of the alternative");
    console.log("-----------------------");
    console.log(`Rows for just the first counterparty: ${display(rowCount)}`);
    console.log("Summing client-side means retrieving every one of those rows, for");
    console.log("every counterparty, and a model pays for all of it. The aggregation");
    console.log("above answered the same question with one small result.");

    // Engine-side traversal, which is the one tool that changes entity.
    if (expand !== undefined && getBeneficiary !== undefined) {
      const traversed = await callTimed(session, expand.name, {
        set: { entity: "transaction", tag_conditions: [{ field: "status", value: "FAILED" }] },
        relationship: "beneficiary",
        limit: 5,
      });
      const payload = traversed.payload as {
        ids?: readonly string[];
        count?: unknown;
        complete?: unknown;
      };
      console.log("");
      console.log("Engine-side traversal");
      console.log("---------------------");
      console.log(`${expand.name}  failed transactions -> beneficiary  ${formatMs(traversed.ms)}`);
      console.log(
        `  ${display(payload.count)} counterparties, complete=${display(payload.complete)}`,
      );
      const first = payload.ids?.[0];
      if (first !== undefined) {
        const hydrated = await callTimed(session, getBeneficiary.name, { id: bareId(first) });
        const one =
          beneficiarySchema === undefined
            ? []
            : parseRecords(hydrated.payload, beneficiarySchema).records;
        const row = one[0] as Record<string, unknown> | undefined;
        console.log(
          `  hydrated one: ${display(row?.["beneficiary_name"])} (${formatMs(hydrated.ms)})`,
        );
      }
      console.log("");
      console.log("This stage crossed entities inside the service rather than here. It");
      console.log("returns keys over the whole matching set, not a page of it, so the");
      console.log("set can be larger than a response could carry. Hydrating a record");
      console.log("afterwards is a second call, so a hop is still a round trip.");
    }
  } finally {
    await session.close();
  }
};
