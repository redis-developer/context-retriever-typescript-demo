import { parseArgs } from "node:util";

import { runCommand } from "../lib/errors.ts";
import { bench } from "./commands/bench.ts";
import { compose } from "./commands/compose.ts";
import { doctor } from "./commands/doctor.ts";
import { guardrails } from "./commands/guardrails.ts";
import { probe } from "./commands/probe.ts";
import { provision } from "./commands/provision.ts";
import { query } from "./commands/query.ts";
import { seed } from "./commands/seed.ts";
import { teardown } from "./commands/teardown.ts";
import { tools } from "./commands/tools.ts";

const USAGE = `
Context Retriever TypeScript demo

  npm run doctor                  What is configured and what is reachable
  npm run seed -- [--flush]       Write generated records into Redis
  npm run provision -- [--name X] Create the surface, import, mint an agent key
  npm run tools -- [options]      Print the tool surface this deployment generated
  npm run query -- [options]      One retrieval call, timed and validated
  npm run guardrails              Each guardrail, shown refusing something
  npm run probe                   What the tool surface cannot express, with no model
  npm run bench -- [--repeat N]   The committed question set, timed and costed
  npm run compose -- [--query X]  One question answered across both entities
  npm run teardown -- [--name X]  Delete the demo surface

tools options
  --schema        Print each tool's full input schema
  --entity NAME   Restrict --schema to one entity's tools

query options
  --tool NAME     Call a specific tool instead of the default scoped read
  --args JSON     Arguments for --tool, as a JSON object
  --repeat N      Repeat the call and report a latency distribution
  --limit N       Rows to request, default 10

Run the commands in the order above. Each one prints what to do next.
`;

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      flush: { type: "boolean", default: false },
      schema: { type: "boolean", default: false },
      name: { type: "string" },
      entity: { type: "string" },
      tool: { type: "string" },
      args: { type: "string" },
      query: { type: "string" },
      repeat: { type: "string", default: "1" },
      limit: { type: "string", default: "10" },
      help: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(USAGE.trim());
    return;
  }

  const positiveInt = (raw: string, label: string): number => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`--${label} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return parsed;
  };

  switch (command) {
    case "doctor":
      await doctor();
      return;
    case "seed":
      await seed({ flush: values.flush });
      return;
    case "provision":
      await provision(values.name === undefined ? {} : { name: values.name });
      return;
    case "tools":
      await tools({
        schema: values.schema,
        ...(values.entity === undefined ? {} : { entity: values.entity }),
      });
      return;
    case "guardrails":
      await guardrails();
      return;
    case "probe":
      await probe();
      return;
    case "bench":
      await bench({ repeat: positiveInt(values.repeat, "repeat") });
      return;
    case "query":
      await query({
        ...(values.tool === undefined ? {} : { tool: values.tool }),
        ...(values.args === undefined ? {} : { args: values.args }),
        repeat: positiveInt(values.repeat, "repeat"),
        limit: positiveInt(values.limit, "limit"),
      });
      return;
    case "compose":
      // A term that matches several counterparties, so the composition has
      // more than one branch to follow.
      await compose({ query: values.query ?? "Bank" });
      return;
    case "teardown":
      await teardown(values.name === undefined ? {} : { name: values.name });
      return;
    default:
      console.error(`Unknown command ${JSON.stringify(command)}.\n`);
      console.log(USAGE.trim());
      process.exitCode = 1;
      return;
  }
};

await runCommand(main);
