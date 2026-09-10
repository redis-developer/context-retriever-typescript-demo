import { createContextRetriever } from "@redis-iris/context-retriever";

import {
  configuredGroups,
  controlPlaneConfig,
  dataPlaneConfig,
  demoConfig,
  redisConfig,
} from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { formatMs, timed } from "../../lib/errors.ts";

/**
 * Establishes what is reachable, and distinguishes the three ways it can fail.
 *
 * A missing variable, an unreachable service and a rejected credential are
 * different problems with different fixes, and a demo that reports them
 * identically wastes the reader's time. Each check below says which of the
 * three it hit.
 */

const tick = (ok: boolean): string => (ok ? "ok  " : "fail");

export const doctor = async (): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);

  console.log(`domain            ${domain.name} (${String(domain.entities.length)} entities)`);
  console.log(`signed-in as      ${demo.customerId} (${demo.customerName})`);
  console.log(`chat model        ${demo.chatModel}`);
  console.log("");

  const groups = configuredGroups();
  console.log("configuration");
  for (const [group, ok] of Object.entries(groups)) {
    console.log(`  ${tick(ok)}  ${group}`);
  }
  console.log("");

  console.log("control plane");
  if (!groups["control plane"]) {
    console.log(
      "  skipped, not configured. Set CONTEXT_RETRIEVER_SERVER_URL and CONTEXT_RETRIEVER_API_KEY_AUTH.",
    );
  } else {
    const { serverUrl, adminApiKey } = controlPlaneConfig();
    console.log(`  server          ${serverUrl}`);
    // Readiness is unauthenticated and never retried by the SDK, so a failure
    // answers immediately and means the service, not the credential.
    const unauthenticated = createContextRetriever({
      serverURL: serverUrl,
      auth: { type: "apiKey", apiKey: () => "unused-for-health-probes" },
    });
    try {
      const { ms } = await timed(() => unauthenticated.health.getReadiness());
      console.log(`  ${tick(true)}  reachable and ready (${formatMs(ms)})`);
    } catch (error) {
      console.log(
        `  ${tick(false)}  unreachable or not ready: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log("        the service is the problem here, not the credential");
    }

    const client = createContextRetriever({
      serverURL: serverUrl,
      auth: { type: "apiKey", apiKey: () => adminApiKey },
    });
    try {
      const { result } = await client.contextSurfaces.listContextSurfaces(1, 100);
      const surfaces = result.contextSurfaces ?? [];
      console.log(
        `  ${tick(true)}  admin key accepted, ${String(surfaces.length)} surface(s) visible`,
      );
      for (const surface of surfaces) {
        const identity =
          surface.identityProvider?.enabled === true
            ? "identity provider enabled"
            : "no identity provider";
        console.log(
          `        ${surface.name ?? "<unnamed>"}  ${surface.status ?? "unknown"}  ${identity}`,
        );
      }
      if (surfaces.length > 0) {
        // Scoping is enforced without an identity provider: the ACL mapping
        // pairs with the access tags on the agent key, and the engine denies by
        // default. An identity provider would let a user token carry the tags
        // instead of the key, which is what production wants, but it is not
        // what makes the refusal happen.
        console.log("        note: reads are scoped by this surface's ACL mapping against the");
        console.log("              access tags on the agent key, and denial is the default. A key");
        console.log("              minted without matching tags sees nothing, which looks exactly");
        console.log("              like an empty index.");
      }
    } catch (error) {
      console.log(
        `  ${tick(false)}  admin key rejected or listing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log("");

  console.log("data plane");
  if (!groups["data plane"]) {
    console.log(
      "  skipped, not configured. Run `npm run provision` and copy the two printed values.",
    );
  } else {
    const { mcpUrl, agentApiKey } = dataPlaneConfig();
    const { serverUrl } = groups["control plane"] ? controlPlaneConfig() : { serverUrl: mcpUrl };
    console.log(`  mcp             ${mcpUrl}`);
    // A one-shot call is exactly right here: the point is a single probe, and
    // paying for a handshake and teardown once costs nothing. A hot path would
    // hold a persistent session instead.
    const client = createContextRetriever({
      serverURL: serverUrl,
      auth: { type: "apiKey", apiKey: () => "unused-for-mcp" },
    });
    try {
      const { result: tools, ms } = await timed(() =>
        client.mcp.listTools({ mcpURL: mcpUrl, agentApiKey }),
      );
      console.log(
        `  ${tick(true)}  agent key accepted, ${String(tools.length)} tool(s) (${formatMs(ms)})`,
      );
    } catch (error) {
      console.log(`  ${tick(false)}  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log("");

  console.log("seeding");
  console.log(`  redis           ${redisConfig().url}`);
  console.log("");
  console.log("agent");
  console.log(
    `  ${tick(groups["agent"] ?? false)}  OPENAI_API_KEY ${groups["agent"] ? "set" : "not set"}`,
  );
  console.log("  note: no embedding provider is needed; no entity carries a vector");
};
