import { dataPlaneConfig, demoConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { SurfaceSession } from "../../data-plane/session.ts";
import {
  callTimed,
  isAggregate,
  parseRecords,
  summariseLatency,
} from "../../data-plane/retrieve.ts";
import { entityTool } from "../../data-plane/tools.ts";
import { buildFilterArgs } from "../../data-plane/conditions.ts";
import { display, formatMs } from "../../lib/errors.ts";

/**
 * One retrieval call, timed, validated and reported.
 *
 * The default is a scoped read of the signed-in customer's most recent
 * transactions, because that is the question every other question builds on.
 * `--tool` and `--args` run an arbitrary call instead, and `--repeat` reports a
 * latency distribution rather than a single sample.
 */
export const query = async (options: {
  readonly tool?: string;
  readonly args?: string;
  readonly repeat: number;
  readonly limit: number;
}): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const { mcpUrl, agentApiKey } = dataPlaneConfig();
  const session = new SurfaceSession({ mcpUrl, agentApiKey });

  try {
    const discovered = await session.listTools();

    // No tool name is hard-coded. The default is derived from the domain's own
    // entity name using the engine's naming convention, and the code copes with
    // the tool being absent, because whether a tool generates depends on the
    // entity's indexes and the data source's capabilities.
    const subject = domain.subjectField;
    let toolName = options.tool;
    let args: Record<string, unknown>;

    if (toolName === undefined) {
      const filterTool = entityTool(discovered, "filter", subject.entity);
      const listTool = entityTool(discovered, "list", subject.entity);
      const chosen = filterTool ?? listTool;
      if (chosen === undefined) {
        console.error(`No filter or list tool found for ${subject.entity}. Discovered:`);
        for (const tool of discovered) console.error(`  ${tool.name}`);
        throw new Error("cannot build a default query against this surface");
      }
      toolName = chosen.name;
      // Built from the tool's own schema rather than assumed. The composite
      // filter takes condition arrays whose `field` is an enum of the entity's
      // indexed fields, so an unsupported field fails locally with the
      // permitted set rather than as a remote error.
      args = buildFilterArgs(chosen, {
        tags: [{ field: subject.field, value: demo.customerId }],
        limit: options.limit,
        sortBy: "transaction_date",
        sortOrder: "desc",
      });
    } else {
      args =
        options.args === undefined ? {} : (JSON.parse(options.args) as Record<string, unknown>);
    }

    console.log(`tool   ${toolName}`);
    console.log(`args   ${JSON.stringify(args)}`);
    console.log("");

    const outcome = await callTimed(session, toolName, args);

    if (outcome.toolReportedError) {
      // A tool-level failure is a protocol outcome, not an exception: the tool
      // ran and told us why it could not answer.
      console.log(`The tool reported an error, which is a normal outcome rather than a crash:`);
      console.log(`  ${outcome.text}`);
      return;
    }

    // An aggregate answers with a value or groups, not rows, so it is reported
    // as what it is rather than validated against a record schema.
    if (isAggregate(outcome.payload)) {
      console.log(`aggregate answered in ${formatMs(outcome.ms)}`);
      console.log(`  ${JSON.stringify(outcome.payload)}`);
      return;
    }

    const schema = domain.resultSchemas[subject.entity];
    if (schema !== undefined) {
      const { records, problems } = parseRecords(outcome.payload, schema);
      console.log(`${String(records.length)} record(s) returned in ${formatMs(outcome.ms)}`);
      if (problems.length > 0) {
        // A validation failure is reported as one, not swallowed: it means the
        // surface returned a shape the domain does not describe.
        console.log("");
        console.log("Validation problems (the surface returned an unexpected shape):");
        for (const problem of problems.slice(0, 5)) console.log(`  ${problem}`);
      }
      console.log("");
      // A compact projection. The full record is far wider than a terminal and
      // the point here is that the right rows came back, not every field.
      for (const record of records.slice(0, Math.min(5, options.limit))) {
        const row = record as Record<string, unknown>;
        const when =
          typeof row["transaction_date"] === "number"
            ? new Date(row["transaction_date"]).toISOString().slice(0, 10)
            : "?";
        console.log(
          `  ${when}  ${display(row["currency_code"])} ${display(row["amount"])}` +
            `  ${display(row["transaction_type"])}/${display(row["status"])}` +
            `  ${display(row["payment_purpose"])}`,
        );
      }
      if (records.length > 5) console.log(`  ... and ${String(records.length - 5)} more`);
    } else {
      console.log(`returned in ${formatMs(outcome.ms)}`);
      console.log(JSON.stringify(outcome.payload, null, 2).slice(0, 2000));
    }

    if (options.repeat > 1) {
      const durations: number[] = [outcome.ms];
      for (let index = 1; index < options.repeat; index += 1) {
        durations.push((await callTimed(session, toolName, args)).ms);
      }
      const summary = summariseLatency(durations);
      console.log("");
      console.log(`latency over ${String(summary.samples)} calls, measured client-side`);
      console.log(`  median  ${formatMs(summary.medianMs)}`);
      console.log(`  p95     ${formatMs(summary.p95Ms)}`);
      console.log(`  min/max ${formatMs(summary.minMs)} / ${formatMs(summary.maxMs)}`);
      console.log("");
      console.log("Measured: the full MCP round trip from this process, including");
      console.log("transport and result validation. Excluded: process start, the MCP");
      console.log("handshake (paid once per session, not per call), and any model time.");
    }
  } finally {
    await session.close();
  }
};
