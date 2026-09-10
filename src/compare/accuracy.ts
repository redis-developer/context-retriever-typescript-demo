import type { Fixture } from "./scenarios.ts";

/**
 * Scoring an answer against a known-answer fixture.
 *
 * Accuracy is measured and reported, and it does not lead. Redis's own
 * benchmark found no significant difference between a governed surface and a
 * text-to-SQL baseline on correctness, and the reference implementation of
 * this comparison stopped claiming it for the same reason. Two things still
 * make it worth reporting. A comparison that omits correctness invites the
 * question, and answering it with a figure is better than answering it with a
 * paragraph. And without it, an arm that answered "I cannot determine that" to
 * every question would win on tokens, model calls, latency and governance
 * simultaneously.
 *
 * Both arms are scored by this one function, and half the scenarios carry no
 * fixture, so the denominator is the scenarios that have one.
 */

/**
 * Removes the differences that are not differences.
 *
 * Digit-group separators go, because 1,254,560.66 and 1254560.66 are the same
 * figure and an arm should not lose a point for formatting. Case goes for the
 * same reason. Nothing else is touched: a rounded figure is a different
 * answer, not a differently formatted one.
 */
const normalise = (answer: string): string => answer.toLowerCase().replace(/(\d),(\d)/g, "$1$2");

export type Score = "correct" | "wrong" | "unscored";

export const score = (answer: string, fixture: Fixture | undefined): Score => {
  if (fixture === undefined) return "unscored";
  const text = normalise(answer);
  const has = (needle: string): boolean => text.includes(normalise(needle));

  const checks: boolean[] = [];
  if (fixture.containsAll !== undefined) checks.push(fixture.containsAll.every(has));
  if (fixture.containsAny !== undefined) checks.push(fixture.containsAny.some(has));
  // An empty notContains passes. It is empty when the generator produced no
  // out-of-scope identifiers to look for, and a check with nothing to check
  // should not silently become a check that always fails.
  if (fixture.notContains !== undefined) checks.push(!fixture.notContains.some(has));

  if (checks.length === 0) return "unscored";
  return checks.every(Boolean) ? "correct" : "wrong";
};
