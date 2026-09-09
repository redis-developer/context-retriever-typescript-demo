import { retailBanking } from "./retail-banking/index.ts";
import type { DomainModel } from "./types.ts";

/**
 * Every available domain, by name.
 *
 * Adding a real schema means adding a directory that implements `DomainModel`,
 * one entry here, and pointing `DEMO_DOMAIN` at it. Nothing outside
 * `src/domain/` changes.
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
