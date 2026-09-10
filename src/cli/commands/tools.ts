import { dataPlaneConfig, demoConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { SurfaceSession } from "../../data-plane/session.ts";
import { groupByEntity, parameterNames, requiredParameters } from "../../data-plane/tools.ts";
import { formatMs, timed } from "../../lib/errors.ts";

/**
 * Prints the tool surface the deployment actually generated.
 *
 * This exists because the generated surface is not a stable published contract:
 * it changed materially between two adjacent patch releases of the engine. Any
 * documentation of it therefore has to come from a real `listTools()` call
 * rather than from a list someone transcribed once.
 */
export const tools = async (options: {
  readonly schema: boolean;
  readonly entity?: string;
}): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const { mcpUrl, agentApiKey } = dataPlaneConfig();
  const session = new SurfaceSession({ mcpUrl, agentApiKey });

  try {
    const { result: discovered, ms } = await timed(() => session.listTools());
    console.log(`${String(discovered.length)} tools discovered in ${formatMs(ms)}`);
    console.log("");

    const entityNames = domain.entities.map(entity => entity.name ?? "");
    for (const [entity, group] of groupByEntity(discovered, entityNames)) {
      console.log(entity);
      for (const tool of group) {
        const params = parameterNames(tool);
        const required = new Set(requiredParameters(tool));
        const rendered = params.map(name => (required.has(name) ? `${name}*` : name)).join(", ");
        console.log(`  ${tool.name}`);
        console.log(`    params: ${rendered === "" ? "(none)" : rendered}`);
        if (options.schema && (options.entity === undefined || entity === options.entity)) {
          console.log(
            `    schema: ${JSON.stringify(tool.inputSchema, null, 2).split("\n").join("\n            ")}`,
          );
        }
      }
      console.log("");
    }

    console.log("Fields marked * are required. Only tag-indexed and numeric-indexed");
    console.log("fields become filter parameters, which is why the filter tool is");
    console.log("narrower than the entity: a tool schema is re-sent on every turn.");
    console.log("");
    console.log("Tool descriptions and schemas are server-supplied. They are useful for");
    console.log("discovery and are never treated as trusted configuration.");
  } finally {
    await session.close();
  }
};
