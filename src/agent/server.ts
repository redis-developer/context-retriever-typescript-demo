import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { dataPlaneConfig, demoConfig, sqlConfig } from "../config/env.ts";
import { resolveDomain } from "../domain/index.ts";
import { SurfaceSession } from "../data-plane/session.ts";
import { reportError } from "../lib/errors.ts";
import { createAsk } from "./ask.ts";
import { governedArm } from "../compare/arms/governed.ts";
import { sqlArm } from "../compare/arms/sql.ts";
import { runArm } from "../compare/run.ts";
import { createReader } from "../sql-plane/client.ts";
import { wideTableOf } from "../sql-plane/schema.ts";

/**
 * A small HTTP server behind a single-file interface.
 *
 * The front end is deliberately minimal: the SDK usage in `bridge.ts` is the
 * subject, and a framework here would bury it. One session is held for the
 * process lifetime, which is the right shape for a request path: one client per
 * (MCP URL, agent key) pair, checked and replaced when it dies, never one per
 * request and never one per end user.
 */

const demo = demoConfig();
const domain = resolveDomain(demo.domain);
const { mcpUrl, agentApiKey } = dataPlaneConfig();
const session = new SurfaceSession({ mcpUrl, agentApiKey });
const ask = createAsk({ session, domain });

/**
 * The comparison arms, when Postgres is configured.
 *
 * Optional on purpose. The comparison is an extension, and the agent has to
 * start on a machine that has never run `docker compose up`. When it is not
 * configured, `/api/session` says so and the interface hides the control
 * rather than offering a button that fails.
 */
const comparison = (() => {
  try {
    const sql = sqlConfig();
    const reader = createReader({ url: sql.readerUrl, statementTimeoutMs: sql.statementTimeoutMs });
    return {
      arms: [
        governedArm({ session, domain }),
        // The standard implementation's default. `npm run compare
        // -- --sample-rows 0` is where to change it.
        sqlArm({ reader, table: wideTableOf(domain), sampleRows: 3 }),
      ],
      close: async (): Promise<void> => {
        await reader.close();
      },
    };
  } catch {
    return undefined;
  }
})();

const indexHtml = await readFile(
  fileURLToPath(new URL("./web/index.html", import.meta.url)),
  "utf8",
);

const server = createServer((request, response) => {
  const send = (status: number, type: string, body: string): void => {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  };

  if (request.method === "GET" && (request.url === "/" || request.url === "/index.html")) {
    send(200, "text/html; charset=utf-8", indexHtml);
    return;
  }

  if (request.method === "GET" && request.url === "/api/session") {
    send(
      200,
      "application/json",
      JSON.stringify({
        customer: { customerId: demo.customerId, name: demo.customerName },
        model: demo.chatModel,
        domain: domain.name,
        comparison: comparison !== undefined,
      }),
    );
    return;
  }

  if (request.method === "POST" && request.url === "/api/ask") {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { question?: unknown };
          const question = typeof body.question === "string" ? body.question.trim() : "";
          if (question === "") {
            send(400, "application/json", JSON.stringify({ error: "question is required" }));
            return;
          }
          const result = await ask(question);
          send(200, "application/json", JSON.stringify(result));
        } catch (error) {
          reportError(error);
          send(
            500,
            "application/json",
            JSON.stringify({ error: error instanceof Error ? error.message : "unknown failure" }),
          );
        }
      })();
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/compare") {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      void (async () => {
        try {
          if (comparison === undefined) {
            send(
              503,
              "application/json",
              JSON.stringify({
                error:
                  "The SQL baseline is not configured. Run `docker compose up -d` and " +
                  "`npm run sql:seed`, then set DEMO_PG_ADMIN_URL and DEMO_PG_READER_URL.",
              }),
            );
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { question?: unknown };
          const question = typeof body.question === "string" ? body.question.trim() : "";
          if (question === "") {
            send(400, "application/json", JSON.stringify({ error: "question is required" }));
            return;
          }

          const scenario = {
            question,
            exercises: "asked from the interface",
            governedSurface: "answers",
          } as const;
          const caller = { id: demo.customerId, name: demo.customerName };

          // One after the other, never at once. Asked concurrently the two arms
          // contend for this process and the same rate limit, and their
          // latencies converge on each other, so the one figure a viewer is
          // watching becomes a measurement of the contention.
          const results = [];
          for (const arm of comparison.arms) {
            const observation = await runArm({ arm, scenario, domain, caller, guardrail: true });
            results.push({
              arm: observation.arm,
              answer: observation.answer,
              traces: observation.traces,
              usage: {
                inputTokens: observation.inputTokens,
                outputTokens: observation.outputTokens,
                modelCalls: observation.modelCalls,
              },
              wallMs: observation.turnMs,
              schemaTokens: observation.schemaTokens,
              verdicts: observation.verdicts,
            });
          }
          send(200, "application/json", JSON.stringify({ arms: results }));
        } catch (error) {
          reportError(error);
          send(
            500,
            "application/json",
            JSON.stringify({ error: error instanceof Error ? error.message : "unknown failure" }),
          );
        }
      })();
    });
    return;
  }

  send(404, "text/plain", "not found");
});

// Without this, a taken port surfaces as an unhandled 'error' event and a
// twenty-line stack trace, which reads like a defect in the demo rather than
// something the reader can fix in one command.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${String(demo.agentPort)} is already in use.`);
    console.error("Set DEMO_AGENT_PORT to a free port, or stop whatever holds it:");
    console.error(`  lsof -nP -iTCP:${String(demo.agentPort)} -sTCP:LISTEN`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

// Bound to loopback explicitly. Node would otherwise listen on every
// interface while the banner below says "localhost", and this endpoint
// authenticates nobody — a difference the reader should not have to discover.
server.listen(demo.agentPort, "127.0.0.1", () => {
  console.log(`Agent ready on http://localhost:${String(demo.agentPort)}`);
  console.log(`  signed in as  ${demo.customerId} (${demo.customerName})`);
  console.log(`  model         ${demo.chatModel}`);
  console.log(`  surface       ${mcpUrl}`);
  console.log("");
  console.log("The agent authenticates nobody: the signed-in customer comes from");
  console.log("configuration. In production a validated token supplies it.");
});

const shutdown = (): void => {
  server.close(() => {
    // Both connections are closed so the service and Postgres release them
    // rather than waiting for a timeout, and a failed teardown does not abort
    // the drain.
    void Promise.allSettled([session.close(), comparison?.close()]).finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
