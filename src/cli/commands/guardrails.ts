import { dataPlaneConfig, demoConfig } from "../../config/env.ts";
import { otherSubjectValue, resolveDomain } from "../../domain/index.ts";
import { buildFilterArgs, conditionFields } from "../../data-plane/conditions.ts";
import { callTimed, isAggregate, parseRecords } from "../../data-plane/retrieve.ts";
import { SurfaceSession } from "../../data-plane/session.ts";
import { entityTool } from "../../data-plane/tools.ts";
import { display, formatMs } from "../../lib/errors.ts";

/**
 * Demonstrates each guardrail by letting it refuse something.
 *
 * A guardrail nobody has seen bite is a claim. Each section below attempts the
 * wrong thing and shows what stops it, and says whether the schema stopped it,
 * the service stopped it, or the caller has to.
 */

const heading = (title: string): void => {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
};

export const guardrails = async (): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const { mcpUrl, agentApiKey } = dataPlaneConfig();
  const session = new SurfaceSession({ mcpUrl, agentApiKey });

  try {
    const tools = await session.listTools();
    const filterTransaction = entityTool(tools, "filter", "transaction");
    const summarize = entityTool(tools, "summarize", "transaction");
    const getById = entityTool(tools, "get", "transaction", "by_id");
    const countTool = entityTool(tools, "count", "transaction");
    if (
      filterTransaction === undefined ||
      summarize === undefined ||
      getById === undefined ||
      countTool === undefined
    ) {
      throw new Error("this surface does not expose the tools this demonstration needs");
    }

    heading("1. Enumerated values are a closed set in the tool contract");
    const tagFields = conditionFields(filterTransaction, "tag_conditions") ?? [];
    console.log(`${filterTransaction.name} accepts these tag fields: ${tagFields.join(", ")}`);
    const statusField = (
      domain.entities.find(entity => entity.name === domain.subjectField.entity)?.fields ?? []
    ).find(field => field.name === "status");
    const permitted = statusField?.allowedValues ?? [];
    console.log(`status accepts only: ${permitted.join(", ")}`);

    // Two different refusals, and the difference is the lesson. An unknown
    // *field* is caught here, before a request is sent, because the field is an
    // enum in the tool's own schema and this code reads it. A disallowed
    // *value* is caught by the service: `allowedValues` constrains the
    // generated parameter, and nothing client-side needs a second copy of the
    // permitted set for that to hold.
    console.log("");
    console.log("A field that is not in the contract, refused before any request:");
    try {
      buildFilterArgs(filterTransaction, { tags: [{ field: "not_a_field", value: "x" }] });
      console.log("  it was accepted, which it should not have been");
    } catch (error) {
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log("");
    console.log(`A value outside the permitted set, refused by the service:`);
    const invented = "COMPLETED";
    if (permitted.includes(invented)) {
      console.log(`  skipped: ${invented} is permitted on this model, so it proves nothing`);
    } else {
      const rejected = await callTimed(session, filterTransaction.name, {
        tag_conditions: [{ field: "status", value: invented }],
        limit: 1,
      });
      console.log(
        rejected.toolReportedError
          ? `  ${rejected.text}`
          : "  it was accepted, which it should not have been",
      );
      console.log(
        `  ${invented} is a plausible guess and this schema does not use it. The agent has`,
      );
      console.log("  made exactly this mistake unprompted, and corrected itself from the");
      console.log("  permitted set the refusal names.");
    }
    console.log("");
    console.log("Enforced by: the schema. The permitted values are an enum in the");
    console.log("tool's input schema, so the agent cannot express the wrong filter at");
    console.log("all. This is a contract, not a prompt instruction.");

    heading("2. A failed transaction is visibly failed");
    const failed = await callTimed(session, filterTransaction.name, {
      tag_conditions: [
        {
          field: demo.domain === domain.name ? domain.subjectField.field : "customer_id",
          value: demo.customerId,
        },
        { field: "status", value: "FAILED" },
      ],
      limit: 3,
    });
    const schema = domain.resultSchemas["transaction"];
    if (schema !== undefined) {
      const { records } = parseRecords(failed.payload, schema);
      console.log(`${String(records.length)} failed transaction(s), in ${formatMs(failed.ms)}:`);
      for (const record of records) {
        const row = record as Record<string, unknown>;
        console.log(
          `  ${display(row["currency_code"])} ${display(row["amount"])}  status=${display(row["status"])}` +
            `  error=${display(row["error_code"])}`,
        );
      }
    }
    console.log("");
    console.log("Enforced by: nobody. status is a field, not a filter the service");
    console.log("applies for you. Money did not move on these rows, so an agent that");
    console.log("reports them as completed payments is wrong. The caller must ask for");
    console.log("status and must say what it means.");

    heading("3. Totals across currencies are meaningless");
    const ungrouped = await callTimed(session, summarize.name, {
      function: "sum",
      field: "amount",
    });
    const grouped = await callTimed(session, summarize.name, {
      function: "sum",
      field: "amount",
      group_by: "currency_code",
    });
    if (isAggregate(ungrouped.payload)) {
      console.log(`ungrouped sum: ${JSON.stringify(ungrouped.payload)}`);
    }
    if (isAggregate(grouped.payload)) {
      const groups = (
        grouped.payload as { groups?: readonly { group_value?: unknown; value?: unknown }[] }
      ).groups;
      console.log("grouped by currency:");
      for (const group of groups ?? []) {
        console.log(`  ${display(group.group_value)}  ${display(group.value)}`);
      }
    }
    console.log("");
    console.log("Enforced by: nobody. The first figure is a real number and a");
    console.log("meaningless one: it adds dirhams to euros. Grouping by currency_code");
    console.log("is the caller's responsibility, which is why amount's description");
    console.log("tells the agent to pair the two.");

    heading("4. A twenty-digit identifier survives as a string");
    const anyRow = await callTimed(session, filterTransaction.name, {
      tag_conditions: [{ field: "customer_id", value: demo.customerId }],
      limit: 1,
    });
    const rows = (anyRow.payload as { results?: readonly Record<string, unknown>[] }).results ?? [];
    const id = display(rows[0]?.["transaction_id"]);
    console.log(`transaction_id       ${id}`);
    console.log(`typeof               ${typeof rows[0]?.["transaction_id"]}`);
    console.log(`as a JS number       ${String(Number(id))}`);
    console.log(`same value?          ${String(String(Number(id)) === id)}`);
    console.log("");
    console.log("Enforced by: the schema, by modelling the field as a string. The");
    console.log("source type permits twenty digits and JavaScript's largest exact");
    console.log("integer has sixteen, so an int would corrupt this silently.");

    heading("5. A session cannot reach another customer's records");
    const other = otherSubjectValue(domain, demo.customerId);
    const denied = await callTimed(session, filterTransaction.name, {
      tag_conditions: [{ field: domain.subjectField.field, value: other }],
      limit: 5,
    });
    const deniedCount = (denied.payload as { total_count?: unknown }).total_count;
    const unscoped = await callTimed(session, countTool.name, { function: "count" });
    console.log(
      `explicitly requesting ${other}: ${display(deniedCount)} records (${formatMs(denied.ms)})`,
    );
    console.log(`unscoped count of every transaction: ${JSON.stringify(unscoped.payload)}`);
    console.log("");
    console.log("Enforced by: the service. The entity declares an ACL mapping on");
    console.log("customer_id and this agent key carries an access tag naming one");
    console.log("customer, so records outside it do not exist as far as this session");
    console.log("is concerned. Note the second figure: the count is the scoped total,");
    console.log("not the real one, so omitting the filter does not escape the scope.");
    console.log("Aggregates are filtered too, which is where a hand-built version leaks.");

    heading("Summary");
    console.log("schema-enforced   closed value sets, string identifiers");
    console.log("service-enforced  per-customer record and aggregate visibility");
    console.log("caller-enforced   transaction status, currency grouping");
    console.log("");
    console.log("The last row is the important one: two of these five are not");
    console.log("guardrails the platform can apply for you.");
  } finally {
    await session.close();
  }
};
