import { describe as group, expect, it } from "vitest";

import { knownAnswers } from "../src/compare/fixtures.ts";
import { scenariosFor } from "../src/compare/scenarios.ts";
import { otherSubjectValue, resolveDomain } from "../src/domain/index.ts";

/**
 * Tests for the accuracy fixtures.
 *
 * These exist because of a specific defect: the fixtures were once figures
 * copied in by hand after running the generator at its default seed. The
 * generator is seeded, so the data moves with `DEMO_SEED` and a copied figure
 * does not, and `compare` would have scored a correct answer as wrong on any
 * other seed with nothing failing to say so.
 */

const domain = resolveDomain("retail-banking");
const SIGNED_IN = "CUST001";
const other = otherSubjectValue(domain, SIGNED_IN);

const answersAt = (seed: number) =>
  knownAnswers({ domain, seed, signedInSubject: SIGNED_IN, otherSubject: other });

group("known answers", () => {
  it("changes with the seed, which is the whole reason they are derived", () => {
    const first = answersAt(1);
    const second = answersAt(7);
    expect(first.totalsByCurrency).not.toEqual(second.totalsByCurrency);
    expect(first.mostRecentIds).not.toEqual(second.mostRecentIds);
    expect(first.topCounterpartyName).not.toBe(second.topCounterpartyName);
  });

  it("is stable for a given seed", () => {
    expect(answersAt(3)).toEqual(answersAt(3));
  });

  it("totals every currency the signed-in subject transacted in", () => {
    const totals = answersAt(1).totalsByCurrency;
    expect(totals.length).toBeGreaterThan(1);
    for (const total of totals) expect(total).toMatch(/^\d+\.\d{2}$/);
  });

  it("names a counterparty that exists in the generated data", () => {
    const { topCounterpartyName } = answersAt(1);
    const counterparties = domain
      .generate(1, SIGNED_IN)
      .find(batch => batch.entity === "beneficiary")?.records;
    expect((counterparties ?? []).map(record => record["beneficiary_name"])).toContain(
      topCounterpartyName,
    );
  });

  it("reports the other subject's identifiers, which an answer must never carry", () => {
    const { otherSubjectIds } = answersAt(1);
    expect(otherSubjectIds.length).toBeGreaterThan(0);
    // Derived, so a regenerated dataset cannot leave them stale. A stale
    // identifier would make the leak check pass by matching nothing.
    const records =
      domain.generate(1, SIGNED_IN).find(batch => batch.entity === "transaction")?.records ?? [];
    for (const id of otherSubjectIds) {
      const record = records.find(one => one["transaction_id"] === id);
      expect(record?.["customer_id"]).toBe(other);
    }
  });
});

group("the scenarios that use them", () => {
  it("carries no figure that was not derived from the requested seed", () => {
    const atOne = scenariosFor(domain, SIGNED_IN, 1);
    const atSeven = scenariosFor(domain, SIGNED_IN, 7);
    const fixturesOf = (set: readonly { readonly expect?: unknown }[]): string =>
      JSON.stringify(set.map(one => one.expect ?? null));
    expect(fixturesOf(atOne)).not.toBe(fixturesOf(atSeven));
  });

  it("scores half the set and leaves the rest unscored, deliberately", () => {
    const set = scenariosFor(domain, SIGNED_IN, 1);
    const scored = set.filter(one => one.expect !== undefined);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.length).toBeLessThan(set.length);
  });
});
