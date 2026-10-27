import { createClient } from "redis";
import type { RedisJSON } from "@redis/json";

import type { DomainModel, DomainRecord } from "../domain/index.ts";
import { fingerprintOf } from "../compare/parity.ts";

/**
 * Writes the domain's generated records straight into Redis as JSON.
 *
 * This is deliberately thin, and it is not the interesting part of the
 * repository. Real loading paths differ enormously (a stream consumer, a batch
 * adapter, on-demand hydration) and a sample implementation of any one of them
 * would be mistaken for a recommendation. What matters here is only that
 * records exist in Redis before a surface is created, because schema inference
 * samples an existing keyspace and a surface indexes one.
 *
 * Note that keys are written at their natural, domain-namespaced location. The
 * engine never namespaces user data keys itself, so the prefix is the domain's
 * responsibility and is what lets several domains share one instance.
 */

/** Renders `retail_banking_transaction:{transaction_id}` against a record. */
export const renderKey = (template: string, record: DomainRecord): string =>
  template.replace(/\{(\w+)\}/g, (_match, field: string) => {
    const value = record[field];
    if (value === undefined || value === null || value === "") {
      throw new Error(`record is missing key component ${JSON.stringify(field)}`);
    }
    // A key component has to be a scalar. Interpolating an object or an array
    // would silently produce "[object Object]" in a key, so it is rejected
    // rather than stringified.
    if (typeof value === "object") {
      throw new Error(`key component ${JSON.stringify(field)} must be a scalar, not an object`);
    }
    return String(value);
  });

export interface SeedReport {
  readonly entity: string;
  readonly written: number;
}

/**
 * Where the record fingerprint is written.
 *
 * Outside every entity's key prefix, so `--flush` does not remove it and the
 * surface never indexes it. Both stores carry the same value, which is how the
 * comparison can refuse to run when they have drifted apart.
 */
export const fingerprintKey = (domain: DomainModel): string => `${domain.keyPrefix}_meta:records`;

export const seedDomain = async (
  domain: DomainModel,
  options: {
    readonly redisUrl: string;
    readonly seed: number;
    /** The subject value most records carry, and what the agent key is scoped to. */
    readonly primarySubjectValue: string;
    readonly flush?: boolean;
  },
): Promise<readonly SeedReport[]> => {
  const client = createClient({ url: options.redisUrl });
  client.on("error", () => {
    // Swallowed on purpose: connect() below surfaces the real failure, and an
    // unhandled 'error' event would otherwise crash the process first.
  });
  await client.connect();

  try {
    const templates = new Map(
      domain.entities.map(entity => [entity.name ?? "", entity.redisKeyTemplate ?? ""]),
    );

    if (options.flush === true) {
      for (const entity of domain.entities) {
        const prefix = (templates.get(entity.name ?? "") ?? "").split("{")[0] ?? "";
        if (prefix === "") continue;
        // SCAN rather than KEYS: KEYS blocks the server for the whole sweep,
        // which is a bad habit to demonstrate even at demo scale.
        for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
          if (keys.length > 0) await client.del(keys);
        }
      }
    }

    const reports: SeedReport[] = [];
    for (const batch of domain.generate(options.seed, options.primarySubjectValue)) {
      const template = templates.get(batch.entity);
      if (template === undefined || template === "") {
        throw new Error(`entity ${JSON.stringify(batch.entity)} declares no redisKeyTemplate`);
      }
      // Pipelined in batches: one round trip per record would dominate the
      // wall clock and tell the reader nothing.
      const chunkSize = 200;
      for (let index = 0; index < batch.records.length; index += chunkSize) {
        const chunk = batch.records.slice(index, index + chunkSize);
        await Promise.all(
          // `DomainRecord` is JSON by construction, which is exactly what the
          // client's `RedisJSON` describes; the two types are structurally the
          // same and the assertion only bridges their nominal difference.
          chunk.map(record =>
            client.json.set(renderKey(template, record), "$", record as RedisJSON),
          ),
        );
      }
      reports.push({ entity: batch.entity, written: batch.records.length });
    }

    // Written last, so a fingerprint present in Redis means the records
    // finished loading rather than started.
    await client.set(
      fingerprintKey(domain),
      fingerprintOf(domain.generate(options.seed, options.primarySubjectValue)),
    );
    return reports;
  } finally {
    await client.close();
  }
};

/** The fingerprint Redis holds, or undefined when nothing has been seeded. */
export const storedRedisFingerprint = async (
  domain: DomainModel,
  redisUrl: string,
): Promise<string | undefined> => {
  const client = createClient({ url: redisUrl });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.get(fingerprintKey(domain))) ?? undefined;
  } finally {
    await client.close();
  }
};
