import { dataSourceConfig, demoConfig } from "../../config/env.ts";
import { resolveDomain, subjectAccessTag } from "../../domain/index.ts";
import { createControlPlaneClient } from "../../control-plane/client.ts";
import { provision as provisionSurface } from "../../control-plane/provision.ts";

export const provision = async (options: { readonly name?: string }): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const client = createControlPlaneClient();

  // Deliberately not derived from the seeding URL. The service resolves this
  // address itself, from its own network, so the two can and usually do differ.
  const connection = dataSourceConfig();
  console.log(
    `data source     ${connection.addr} (as the service resolves it, tls=${String(connection.tlsEnabled)})`,
  );

  const result = await provisionSurface(client, domain, {
    surfaceName: options.name ?? `${domain.name}-demo`,
    // Any password here is one of the values the SDK's debug redaction masks,
    // so it will not appear in debug output.
    dataSource: { type: "redis", connectionConfig: connection },
    seed: demo.seed,
    accessTag: subjectAccessTag(domain),
    accessTagValue: demo.customerId,
  });

  // Printed first, and unconditionally. The key is returned exactly once and
  // no endpoint reads it back, so it must reach the operator before anything
  // else can go wrong.
  console.log("");
  console.log("Add this to .env. The agent key is returned exactly once:");
  console.log("");
  console.log(`CONTEXT_RETRIEVER_AGENT_KEY=${result.agentKey.key}`);

  if (result.agentKey.mcpUrl !== undefined) {
    console.log(`CONTEXT_RETRIEVER_MCP_URL=${result.agentKey.mcpUrl}`);
  } else {
    console.log("");
    console.log("This deployment advertises no MCP URL, which happens when no ingress");
    console.log("host is configured. The endpoint exists; the service just does not know");
    console.log("its own external address. Set it yourself, for example:");
    console.log("");
    console.log("CONTEXT_RETRIEVER_MCP_URL=http://localhost:8081/mcp");
  }
  console.log("");
  console.log("Next: npm run tools");
};
