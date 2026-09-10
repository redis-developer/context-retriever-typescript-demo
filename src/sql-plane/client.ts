import pg from "pg";

/**
 * The Postgres connections the comparison uses.
 *
 * Two of them, deliberately. The loader needs to create a role and a table;
 * the arm under measurement needs `SELECT` and nothing else. Handing the arm
 * the loader's connection would make its read-only claim untrue while every
 * command still worked, so the separation is enforced by there being two
 * functions and no way to reach the admin pool from `src/compare/arms/`.
 */

/**
 * Both arms have to hand the model the same shapes, or a representation
 * difference reads as a data difference.
 *
 * node-postgres returns `numeric` and `int8` as strings, because either can
 * exceed what a JavaScript number holds exactly. Left alone, the governed arm
 * would report an amount as `7589.92` and a date as `1781770337599` while the
 * baseline reported `"7589.92"` and `"1781770337599"`, and the baseline would
 * look worse for a reason that has nothing to do with how it reaches data.
 *
 * `numeric` is converted unconditionally: the column is `numeric(18,2)` and
 * retail amounts sit far inside a double's exact range, which is the same
 * trade the governed side already makes by modelling money as `float`.
 *
 * `int8` is converted only when the value survives the round trip. Every
 * `int8` column here is epoch milliseconds, three orders of magnitude below
 * the limit, but a `count(*)` or a `sum()` the model writes is also `int8`, so
 * the guard is what keeps this from being the silent corruption the schema
 * chose `text` identifiers to avoid.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, value => Number(value));
pg.types.setTypeParser(pg.types.builtins.INT8, value => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});

/** The reader connection, which can only read. */
export interface Reader {
  /**
   * Runs one statement in a read-only transaction with a statement timeout.
   *
   * Read-only is belt to the role's braces: the role holds no write grant, and
   * a transaction that declares itself read-only refuses a write before the
   * privilege check, so a write attempt fails the same way whichever is
   * removed first. The timeout is the part the role cannot supply. A read-only
   * role does not protect availability, and an unbounded scan of a production
   * table is a read.
   */
  readonly run: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number;
  }>;
  readonly close: () => Promise<void>;
}

export const createReader = (options: {
  readonly url: string;
  readonly statementTimeoutMs: number;
}): Reader => {
  const pool = new pg.Pool({ connectionString: options.url, max: 4 });
  return {
    run: async (sql, values) => {
      const client = await pool.connect();
      try {
        await client.query(
          `BEGIN READ ONLY; SET LOCAL statement_timeout = ${String(options.statementTimeoutMs)}`,
        );
        const result =
          values === undefined
            ? await client.query<Record<string, unknown>>(sql)
            : await client.query<Record<string, unknown>>(sql, [...values]);
        return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
      } finally {
        // Always, including after a failed statement: an aborted transaction
        // left open would make the pooled connection reject everything after
        // it with a message about the wrong statement.
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
};

/** The loader connection, which may create a role and a table. */
export const withAdmin = async <T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};
