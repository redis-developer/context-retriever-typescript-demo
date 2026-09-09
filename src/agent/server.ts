import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { dataPlaneConfig, demoConfig } from "../config/env.ts";
import { resolveDomain } from "../domain/index.ts";
import { SurfaceSession } from "../data-plane/session.ts";
import { reportError } from "../lib/errors.ts";
import { createAsk } from "./ask.ts";

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
    // Sessions are closed so the service releases them rather than waiting for
    // them to time out, and a failed teardown does not abort the drain.
    void session.close().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
