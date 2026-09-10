import type { ContextRetrieverClient } from "@redis-iris/context-retriever";

/** Lists agent keys for a surface, following pagination. */
export const listAgentKeys = async (
  client: ContextRetrieverClient,
  surfaceId: string,
): Promise<readonly { id: string; name: string }[]> => {
  const keys: { id: string; name: string }[] = [];
  for (let page = 1; ; page += 1) {
    const { result } = await client.agentKeys.listAgentKeys(surfaceId, page, 100);
    for (const item of result.agentKeys ?? []) {
      // Both fields are optional in the generated model, so neither is assumed.
      keys.push({ id: item.id ?? "<no id>", name: item.name ?? "<unnamed>" });
    }
    if (result.pagination?.hasNext !== true) return keys;
  }
};
