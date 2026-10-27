import type { DomainModel, DomainRecord } from "../domain/index.ts";

/**
 * Known answers, read out of the generator rather than written down.
 *
 * An earlier version copied the figures in by hand after running the
 * generator once. That is wrong for a reason worth stating: the generator is
 * seeded, so every amount, status and counterparty moves when `DEMO_SEED`
 * moves, while a copied figure does not. `compare` verifies both stores
 * against the configured seed and would then have scored a correct answer as
 * wrong, with nothing failing to say so.
 *
 * Deriving them also removes the only place in the repository where a number
 * had to be kept in step with the data by hand.
 */

export interface KnownAnswers {
  /** Gross total per currency for the signed-in subject, at two decimal places. */
  readonly totalsByCurrency: readonly string[];
  /** The signed-in subject's most recent record identifiers, most recent first. */
  readonly mostRecentIds: readonly string[];
  /** The counterparty the signed-in subject transacted with most often. */
  readonly topCounterpartyName: string;
  /** The most common failure reason among the signed-in subject's records. */
  readonly commonestErrorCode: string;
  /** Identifiers belonging to another subject, which an answer must never carry. */
  readonly otherSubjectIds: readonly string[];
}

const text = (record: DomainRecord, field: string): string => {
  const value = record[field];
  return typeof value === "string" ? value : "";
};

const number = (record: DomainRecord, field: string): number => {
  const value = record[field];
  return typeof value === "number" ? value : 0;
};

/** The key of the highest-counted entry, or an empty string when there are none. */
const commonest = (counts: ReadonlyMap<string, number>): string => {
  let best = "";
  let most = 0;
  // Ties break on the key, so the answer does not depend on insertion order.
  for (const [key, count] of [...counts.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (count > most) {
      best = key;
      most = count;
    }
  }
  return best;
};

const countBy = (records: readonly DomainRecord[], field: string): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = text(record, field);
    if (key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

export const knownAnswers = (options: {
  readonly domain: DomainModel;
  readonly seed: number;
  readonly signedInSubject: string;
  readonly otherSubject: string;
}): KnownAnswers => {
  const { domain } = options;
  const subjectField = domain.subjectField.field;
  const keyField = `${domain.subjectField.entity}_id`;

  const batches = domain.generate(options.seed, options.signedInSubject);
  const records = batches.find(batch => batch.entity === domain.subjectField.entity)?.records ?? [];
  const mine = records.filter(record => text(record, subjectField) === options.signedInSubject);

  const totals = new Map<string, number>();
  for (const record of mine) {
    const currency = text(record, "currency_code");
    totals.set(currency, (totals.get(currency) ?? 0) + number(record, "amount"));
  }

  const mostRecent = [...mine]
    .sort((left, right) => number(right, "transaction_date") - number(left, "transaction_date"))
    .map(record => text(record, keyField));

  // Resolved through the same join the wide table performs, so the name a
  // fixture expects is the name either arm can reach.
  const counterpartyCounts = countBy(mine, "beneficiary_id");
  const topCounterpartyId = commonest(counterpartyCounts);
  const counterparties = batches.find(
    batch => batch.entity !== domain.subjectField.entity,
  )?.records;
  const topCounterparty = (counterparties ?? []).find(
    record => text(record, "beneficiary_id") === topCounterpartyId,
  );

  return {
    totalsByCurrency: [...totals.values()].map(total => total.toFixed(2)),
    mostRecentIds: mostRecent.slice(0, 2),
    topCounterpartyName:
      topCounterparty === undefined ? "" : text(topCounterparty, "beneficiary_name"),
    commonestErrorCode: commonest(
      countBy(
        mine.filter(record => text(record, "status") === "FAILED"),
        "error_code",
      ),
    ),
    otherSubjectIds: records
      .filter(record => text(record, subjectField) === options.otherSubject)
      .map(record => text(record, keyField))
      .slice(0, 3),
  };
};
