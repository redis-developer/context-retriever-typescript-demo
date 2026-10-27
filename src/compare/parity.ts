import { createHash } from "node:crypto";

import type { DomainRecord, EntityRecords } from "../domain/types.ts";

/**
 * A fingerprint of the records, so both stores can be shown to hold the same data.
 *
 * The comparison's whole claim rests on the two arms answering over identical
 * records. That is easy to assert in a README and easy to break in practice:
 * reseed Redis with a different `DEMO_SEED`, or change the generator, and every
 * command still succeeds while the two arms answer different questions. Both
 * loaders write this hash and `npm run compare` recomputes it, so identical
 * data is a precondition the command enforces rather than a claim the reader
 * has to trust.
 *
 * Keys are sorted before hashing, so reordering a field declaration is not a
 * difference. Changing, adding or removing one is.
 */

const canonical = (record: DomainRecord): string =>
  JSON.stringify(
    Object.keys(record)
      .sort()
      .map(key => [key, record[key]]),
  );

export const fingerprintOf = (batches: readonly EntityRecords[]): string => {
  const hash = createHash("sha256");
  for (const batch of [...batches].sort((left, right) => left.entity.localeCompare(right.entity))) {
    hash.update(batch.entity);
    hash.update(" ");
    for (const record of batch.records) {
      hash.update(canonical(record));
      hash.update(" ");
    }
  }
  return hash.digest("hex").slice(0, 32);
};

/** The message a mismatch produces, which has to say what to run. */
export const parityMismatch = (options: {
  readonly expected: string;
  readonly found: string;
  readonly store: string;
}): Error =>
  new Error(
    `The records in ${options.store} are not the records this domain generates, so the two ` +
      `arms would answer over different data and every figure the comparison prints would be ` +
      `meaningless.\n\n` +
      `  generated here          ${options.expected}\n` +
      `  found in ${options.store}   ${options.found}\n\n` +
      `Reload both stores from the same seed:\n` +
      `  npm run seed -- --flush\n` +
      `  npm run sql:seed -- --flush`,
  );
