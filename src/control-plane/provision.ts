import { ConflictError } from "@redis-iris/context-retriever";
import type { ContextRetrieverClient } from "@redis-iris/context-retriever";
import type { ContextSurface, DataSourceRequest } from "@redis-iris/context-retriever/models";

import type { DomainModel } from "../domain/index.ts";
import { waitUntilActive } from "./wait.ts";

export interface ProvisionOptions {
  readonly surfaceName: string;
  readonly dataSource: DataSourceRequest;
  readonly seed: number;
  /** The `accessTag` declared on the entity's ACL mapping. */
  readonly accessTag: string;
  /** The single value this agent key is permitted to see. */
  readonly accessTagValue: string;
  readonly signal?: AbortSignal;
}

export interface ProvisionResult {
  readonly surface: ContextSurface;
  readonly imported: Readonly<Record<string, number>>;
  readonly agentKey: {
    readonly key: string;
    /** Absent when the deployment advertises no MCP URL; see the note below. */
    readonly mcpUrl: string | undefined;
  };
}

/** Finds a surface by name, following pagination rather than assuming one page. */
const findSurfaceByName = async (
  client: ContextRetrieverClient,
  name: string,
): Promise<ContextSurface> => {
  for (let page = 1; ; page += 1) {
    const { result } = await client.contextSurfaces.listContextSurfaces(page, 100);
    const match = (result.contextSurfaces ?? []).find(candidate => candidate.name === name);
    if (match?.id !== undefined) {
      const { result: surface } = await client.contextSurfaces.getContextSurface(match.id);
      return surface;
    }
    if (result.pagination?.hasNext !== true) {
      throw new Error(
        `Create reported a conflict, but no surface named ${JSON.stringify(name)} exists`,
      );
    }
  }
};

/**
 * Creates the surface from the committed model, waits for it, imports records,
 * and mints an agent key.
 *
 * The data model passed here is the checked-in TypeScript one, deliberately.
 * `inferSchema` can propose a model by sampling the keyspace with an LLM, which
 * is useful when meeting an unfamiliar dataset, but it is not reproducible: two
 * runs can differ on whether a field is a tag or free text. So inference
 * belongs in development, feeding a review, and provisioning always reads
 * reviewed code.
 */
export const provision = async (
  client: ContextRetrieverClient,
  domain: DomainModel,
  options: ProvisionOptions,
): Promise<ProvisionResult> => {
  console.log(`Creating surface ${JSON.stringify(options.surfaceName)}...`);
  let surface: ContextSurface;
  try {
    ({ result: surface } = await client.contextSurfaces.createContextSurface({
      name: options.surfaceName,
      description: domain.description,
      dataSource: options.dataSource,
      dataModel: {
        title: domain.title,
        description: domain.description,
        entities: [...domain.entities],
      },
      metadata: { createdBy: "context-retriever-typescript-demo", domain: domain.name },
    }));
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    console.log("  a surface with that name already exists; continuing with it");
    surface = await findSurfaceByName(client, options.surfaceName);
  }
  console.log(`  surface ${surface.id}`);

  console.log("Waiting for provisioning and index building...");
  const activeOptions = options.signal === undefined ? {} : ({ signal: options.signal } as const);
  surface = await waitUntilActive(client, surface.id, activeOptions);
  console.log(`  active, exposing ${String(surface.tools.length)} tools`);

  const imported: Record<string, number> = {};
  // The same value that scopes the agent key below, so imported records and
  // key scope cannot disagree.
  for (const batch of domain.generate(options.seed, options.accessTagValue)) {
    console.log(`Importing ${String(batch.records.length)} ${batch.entity} records...`);
    const { result } = await client.contextSurfaces.importData(surface.id, {
      entity: batch.entity,
      records: [...batch.records],
      options: { onConflict: "overwrite", onError: "continue" },
    });

    // The import response reports partial failure per record instead of
    // throwing, so a caller that ignores it will believe a half-failed import
    // succeeded. `failed` and `errors` can disagree, so take the larger.
    const failures = result.errors ?? [];
    const failedCount = Math.max(result.failed ?? 0, failures.length);
    imported[batch.entity] = result.imported ?? 0;
    console.log(`  imported ${String(result.imported ?? 0)}, failed ${String(failedCount)}`);
    if (failedCount > 0) {
      for (const failure of failures.slice(0, 10)) {
        console.error(
          `    record ${failure.recordId ?? String(failure.index ?? "?")}: ${failure.error ?? "unknown error"}`,
        );
      }
      throw new Error(`Import of ${batch.entity} completed with ${String(failedCount)} failures`);
    }
  }

  // Access tags are what make `aclFieldMappings` bite, and they are not
  // optional in practice. An entity declaring an ACL mapping is deny-by-default:
  // a key with no matching tag sees none of its records, which is the correct
  // fail-closed behaviour but looks exactly like an empty index. The tag key
  // matches `accessTag` on the mapping; the values are what this key may see.
  //
  // This is per-key scoping. Configuring an identity provider on the surface and
  // passing a user token per request is the dynamic variant, where the tag comes
  // from a verified claim instead of being fixed when the key is minted.
  console.log(`Minting an agent key scoped to ${options.accessTagValue}...`);
  const { result: agentKey } = await client.agentKeys.createAgentKey(surface.id, {
    name: "demo-agent",
    description: "Agent key for the TypeScript demo's data plane",
    ttlSeconds: 60 * 60 * 24 * 30,
    accessTags: { [options.accessTag]: [options.accessTagValue] },
  });

  // `key` is returned exactly once, and no endpoint reads it back. So it is
  // surfaced to the caller before anything else can fail: an earlier version of
  // this function validated the MCP URL first and threw, destroying a key it
  // had just minted. Capture first, validate second.
  const key = agentKey.key;
  if (key === undefined) {
    throw new Error("Agent key creation returned no key");
  }

  // A deployment without an ingress host configured advertises no MCP URL, on
  // the key or on the surface. That is not a failure: the endpoint exists, the
  // service simply does not know its own external address. The caller falls
  // back to a configured value.
  const mcpUrl = agentKey.mcpUrl ?? surface.mcpUrl;

  return { surface, imported, agentKey: { key, mcpUrl } };
};
