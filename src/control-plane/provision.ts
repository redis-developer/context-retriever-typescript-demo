import type { ContextRetrieverClient } from "@redis-iris/context-retriever";
import type { ContextSurface, DataSourceRequest } from "@redis-iris/context-retriever/models";

import type { DomainModel } from "../domain/index.ts";
import { assertSurfaceMatches, findSurfacesByName } from "./surfaces.ts";
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
  // Look before creating. The service does not enforce unique surface names, so
  // relying on a conflict to detect an existing surface silently accumulates
  // duplicates instead: every rerun creates another, and any later lookup by
  // name then picks one of them arbitrarily.
  let surface: ContextSurface;
  const existing = await findSurfacesByName(client, options.surfaceName);
  if (existing.length > 1) {
    throw new Error(
      `${String(existing.length)} surfaces are already named ${JSON.stringify(options.surfaceName)}, ` +
        `so this cannot tell which one you mean. Delete them and provision again, or pass ` +
        `--name to use a distinct name.`,
    );
  }
  const reusable = existing[0];
  if (reusable !== undefined) {
    // See assertSurfaceMatches for the two ways a same-name surface is the
    // wrong one to reuse.
    assertSurfaceMatches(reusable, domain);
    console.log(
      `Surface ${JSON.stringify(options.surfaceName)} already exists and matches this model; continuing with it.`,
    );
    surface = reusable;
  } else {
    console.log(`Creating surface ${JSON.stringify(options.surfaceName)}...`);
    ({ result: surface } = await client.contextSurfaces.createContextSurface({
      name: options.surfaceName,
      description: domain.description,
      dataModel: {
        title: domain.title,
        description: domain.description,
        entities: [...domain.entities],
      },
      dataSource: options.dataSource,
      metadata: { createdBy: "context-retriever-typescript-demo", domain: domain.name },
    }));
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
