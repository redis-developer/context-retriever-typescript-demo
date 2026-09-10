import { describe as group, expect, it } from "vitest";

import { resolveDomain } from "../src/domain/index.ts";
import { buildDdl, judgeSchemaOf, wideTableOf } from "../src/sql-plane/schema.ts";
import { insertStatement, toWideRows } from "../src/sql-plane/rows.ts";

/**
 * Tests for the wide table the SQL baseline queries.
 *
 * The table is derived from the committed entity model rather than written by
 * hand, so these pin the derivation. Two failures they exist to catch are
 * silent: a field added to the model that never becomes a column, which would
 * leave the two stores holding different data while every query still
 * succeeded; and a twenty-digit identifier landing in a numeric column, which
 * corrupts the value in the place it is hardest to notice.
 */

const domain = resolveDomain("retail-banking");
const table = wideTableOf(domain);

group("deriving the table from the entity model", () => {
  it("carries a column for every field of every entity", () => {
    const declared = new Set(
      domain.entities.flatMap(entity => (entity.fields ?? []).map(field => field.name)),
    );
    expect(new Set(table.columns.map(column => column.name))).toEqual(declared);
  });

  it("folds the related entity in once, without repeating the join column", () => {
    const names = table.columns.map(column => column.name);
    expect(names.filter(name => name === "beneficiary_id")).toHaveLength(1);
    // Twenty-five transaction fields plus six of the beneficiary's seven: the
    // seventh is the join column, already present.
    expect(names).toHaveLength(31);
  });

  it("keys on the base entity's key component and knows its subject column", () => {
    expect(table.primaryKey).toBe("transaction_id");
    expect(table.subjectColumn).toBe("customer_id");
  });

  it("records the join so the loader repeats what the relationship declares", () => {
    expect(table.joins).toEqual([
      { entity: "beneficiary", sourceField: "beneficiary_id", targetKey: "beneficiary_id" },
    ]);
  });
});

group("column types, where the interesting decisions are", () => {
  const typeOf = (name: string): string | undefined =>
    table.columns.find(column => column.name === name)?.type;

  it("gives every identifier a text column, so twenty digits survive", () => {
    for (const name of ["transaction_id", "customer_id", "account_id", "beneficiary_id"]) {
      expect(typeOf(name)).toBe("text");
    }
  });

  it("keeps epoch milliseconds as bigint rather than a timestamp", () => {
    // A timestamp column would hand the baseline date_trunc and interval
    // arithmetic the governed surface cannot express, changing what a question
    // about "last month" costs on one side only.
    for (const name of ["transaction_date", "value_date", "created_date", "updated_date"]) {
      expect(typeOf(name)).toBe("bigint");
    }
  });

  it("gives money exact decimal arithmetic, which is the generous direction", () => {
    for (const name of ["amount", "balance_before", "balance_after"]) {
      expect(typeOf(name)).toBe("numeric(18,2)");
    }
  });
});

group("the DDL", () => {
  const ddl = buildDdl(table);

  it("defaults every text column to the empty string rather than accepting null", () => {
    // The generator emits '' for an absent terminal_id and error_code. Mapping
    // those to null would give the baseline three-valued logic on fields the
    // governed surface exposes as tag filters over ''.
    expect(ddl).toContain("terminal_id text NOT NULL DEFAULT ''");
    expect(ddl).toContain("error_code text NOT NULL DEFAULT ''");
  });

  it("declares every column NOT NULL", () => {
    // Both stores hold the same records, so a nullable column here would be a
    // difference the comparison cannot see.
    const body = ddl.split(`CREATE TABLE ${table.name} (`)[1]?.split(");")[0] ?? "";
    const lines = body.split("\n").filter(line => line.trim() !== "");
    expect(lines).toHaveLength(table.columns.length);
    expect(lines.filter(line => !line.includes("NOT NULL"))).toEqual([]);
  });

  it("indexes the subject column, so the baseline is not slowed by our choices", () => {
    expect(ddl).toContain("(customer_id)");
    expect(ddl).toContain("(customer_id, transaction_date DESC)");
  });
});

group("flattening the generated records", () => {
  const rows = toWideRows(table, domain.generate(1, "CUST001"));

  it("produces one row per transaction", () => {
    expect(rows).toHaveLength(400);
  });

  it("carries every identifier as a string, at a width a number would corrupt", () => {
    const index = table.columns.findIndex(column => column.name === "transaction_id");
    const id = rows[0]?.[index];
    expect(typeof id).toBe("string");
    expect(String(Number(id))).not.toBe(id);
  });

  it("resolves the counterparty's name onto the transaction row", () => {
    const index = table.columns.findIndex(column => column.name === "beneficiary_name");
    expect(typeof rows[0]?.[index]).toBe("string");
    expect(rows[0]?.[index]).not.toBe("");
  });

  it("keeps amounts as numbers, so the driver sends them as numerics", () => {
    const index = table.columns.findIndex(column => column.name === "amount");
    expect(typeof rows[0]?.[index]).toBe("number");
  });
});

group("the insert statement", () => {
  it("numbers placeholders across every row of the batch", () => {
    const { text, values } = insertStatement(table, [
      table.columns.map(() => "x"),
      table.columns.map(() => "y"),
    ]);
    expect(text).toContain("$1,");
    expect(text).toContain(`$${String(table.columns.length + 1)},`);
    expect(values).toHaveLength(table.columns.length * 2);
  });
});

group("the judge's view of this table", () => {
  it("declares one table with one subject column", () => {
    // The judge distinguishes a table declared to carry no subject column from
    // one it has never heard of. With a single wide table there is only the
    // first kind of entry, and this is where it comes from.
    expect(judgeSchemaOf(table)).toEqual({
      subjectColumnByTable: { bank_transaction: "customer_id" },
    });
  });
});
