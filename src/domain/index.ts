import { retailBanking } from "./retail-banking/index.ts";
import type { DomainModel } from "./types.ts";

/**
 * Every available domain, by name.
 *
 * Adding a real schema means adding a directory that implements `DomainModel`,
 * one entry here, and pointing `DEMO_DOMAIN` at it. Provisioning, seeding and
 * retrieval read only the interface. The agent's instructions and the two
 * scripted demonstrations do not: see `subjectAccessTag` below, and the note in
 * the README on what a swap still costs.
 */
export const domains: Readonly<Record<string, DomainModel>> = {
  [retailBanking.name]: retailBanking,
};

export const DEFAULT_DOMAIN = retailBanking.name;

export const resolveDomain = (name: string): DomainModel => {
  const domain = domains[name];
  if (domain === undefined) {
    const available = Object.keys(domains).sort().join(", ");
    throw new Error(`Unknown domain ${JSON.stringify(name)}. Available: ${available}`);
  }
  return domain;
};

export type {
  CustomerProfile,
  DomainModel,
  DomainRecord,
  EntityRecords,
  InternalTool,
  InternalToolContext,
  JsonValue,
} from "./types.ts";

/**
 * The access tag that scopes an agent key for this domain's subject field.
 *
 * Read from the entity's own ACL mapping rather than assumed. Provisioning
 * previously hardcoded the tag name, which is the worst kind of defect
 * available here: a domain declaring any other tag mints a key whose access
 * tags match nothing, the surface denies by default, and every read comes back
 * empty. That is indistinguishable from an index that failed to build.
 */
export const subjectAccessTag = (domain: DomainModel): string => {
  const subject = domain.entities.find(entity => entity.name === domain.subjectField.entity);
  if (subject === undefined) {
    throw new Error(
      `domain ${domain.name} names ${domain.subjectField.entity} as its subject entity, but declares no such entity`,
    );
  }
  const documentField = `$.${domain.subjectField.field}`;
  const mapping = (subject.aclFieldMappings ?? []).find(
    candidate => candidate.documentField === documentField,
  );
  if (mapping?.accessTag === undefined || mapping.accessTag === "") {
    throw new Error(
      `entity ${domain.subjectField.entity} declares no ACL mapping for ${documentField}, so an agent key cannot be scoped to it`,
    );
  }
  return mapping.accessTag;
};

/**
 * A subject value the agent key is *not* scoped to, taken from the seeded data.
 *
 * Needed by every demonstration that shows a scoped read refusing: something
 * has to play the other customer. Hardcoding one is a trap, because
 * `DEMO_CUSTOMER_ID` can legitimately be set to that same value, at which point
 * the "other" customer is the signed-in one and the demonstration reports the
 * customer's own rows as proof of denial. Deriving it from the generator cannot
 * drift, because the generator is what produced the rows.
 */
export const otherSubjectValue = (domain: DomainModel, signedInValue: string): string => {
  const batches = domain.generate(1, signedInValue);
  const subject = batches.find(batch => batch.entity === domain.subjectField.entity);
  for (const record of subject?.records ?? []) {
    const value = (record as Record<string, unknown>)[domain.subjectField.field];
    if (typeof value === "string" && value !== signedInValue) return value;
  }
  throw new Error(
    `the generated data carries only one ${domain.subjectField.field}, so no scoped read can be shown refusing`,
  );
};
