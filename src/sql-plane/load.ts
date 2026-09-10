import type { DomainModel } from "../domain/index.ts";
import { fingerprintOf } from "../compare/parity.ts";
import { withAdmin } from "./client.ts";
import { insertStatement, toWideRows } from "./rows.ts";
import { META_TABLE, buildDdl, readerRoleSql, wideTableOf } from "./schema.ts";

/**
 * Loads the SQL baseline's copy of the records.
 *
 * Mirrors `src/seed/seed.ts`, which does the same job for Redis, and shares
 * its generator call: both stores are loaded from `domain.generate`, so the
 * comparison's claim that the two arms answer over identical data holds by
 * construction rather than by discipline. The fingerprint written at the end is
 * what lets `npm run compare` prove it before it prints a figure.
 *
 * Best practices for loading data are out of scope here, as they are for the
 * Redis seeder. This is a utility, not a reference pipeline.
 */

/**
 * The role the arm connects as, read out of the arm's own connection URL.
 *
 * Derived rather than configured separately, so the role the loader creates
 * and the role the arm logs in as cannot disagree. A separate setting for each
 * would let them drift, and the failure would read as an authentication
 * problem rather than as the misconfiguration it is.
 */
const roleFromUrl = (readerUrl: string): { role: string; password: string } => {
  const parsed = new URL(readerUrl);
  const role = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (role === "" || password === "") {
    throw new Error(
      `DEMO_PG_READER_URL must carry the role and password the SQL baseline logs in as, ` +
        `because \`npm run sql:seed\` creates that role rather than assuming one exists.`,
    );
  }
  return { role, password };
};

export interface SqlSeedReport {
  readonly table: string;
  readonly columns: number;
  readonly rows: number;
  readonly fingerprint: string;
  readonly role: string;
  readonly roleCreated: boolean;
}

export const loadSqlBaseline = async (
  domain: DomainModel,
  options: {
    readonly adminUrl: string;
    readonly seed: number;
    readonly primarySubjectValue: string;
    readonly readerUrl: string;
  },
): Promise<SqlSeedReport> => {
  const table = wideTableOf(domain);
  const batches = domain.generate(options.seed, options.primarySubjectValue);
  const rows = toWideRows(table, batches);
  const fingerprint = fingerprintOf(batches);

  return withAdmin(options.adminUrl, async client => {
    await client.query(buildDdl(table));

    // Chunked because a single INSERT carrying 400 rows of 31 columns is
    // 12,400 bind parameters, and Postgres caps a statement at 65,535.
    const chunk = 200;
    for (let start = 0; start < rows.length; start += chunk) {
      const { text, values } = insertStatement(table, rows.slice(start, start + chunk));
      await client.query(text, [...values]);
    }

    await client.query(`INSERT INTO ${META_TABLE} (fingerprint, seeded_at) VALUES ($1, $2)`, [
      fingerprint,
      Date.now(),
    ]);

    const database = new URL(options.adminUrl).pathname.replace(/^\//, "");
    const { role, password } = roleFromUrl(options.readerUrl);
    let roleCreated = true;
    try {
      await client.query(readerRoleSql(role, password, database));
    } catch {
      // Reported rather than fatal. A managed Postgres may refuse role
      // creation, and a reader who has already made the role by hand should
      // not be blocked by a second attempt failing.
      roleCreated = false;
    }

    return {
      table: table.name,
      columns: table.columns.length,
      rows: rows.length,
      fingerprint,
      role,
      roleCreated,
    };
  });
};

/** The fingerprint Postgres holds, or undefined when nothing has been loaded. */
export const storedFingerprint = async (adminUrl: string): Promise<string | undefined> =>
  withAdmin(adminUrl, async client => {
    const result = await client.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ${META_TABLE} ORDER BY seeded_at DESC LIMIT 1`,
    );
    return result.rows[0]?.fingerprint;
  });
