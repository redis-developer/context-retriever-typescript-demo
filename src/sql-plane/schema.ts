import type { EntityDescription, FieldDescription } from "@redis-iris/context-retriever/models";

import type { DomainModel } from "../domain/index.ts";
import { FieldType } from "../domain/field-types.ts";

/**
 * The one wide table the SQL baseline queries.
 *
 * The comparison exists because the adopter is weighing this repository's
 * governed surface against an agent writing SQL over a single wide
 * transactions table. So the baseline gets exactly that: one table carrying
 * every field of every entity, joined along the declared relationship. The
 * governed surface normalises the same data into two entities, which costs it
 * a second call on any question about a counterparty's name. Removing that
 * cost from the baseline is what makes the comparison the one being weighed
 * rather than a flattering variant of it.
 *
 * The DDL is derived from the committed entity model rather than written by
 * hand, for two reasons. It cannot drift from the entities, so a field added
 * to the model is a column here or a loud failure. And nothing structural
 * about the source schema had to be copied into this repository to produce it.
 */

/**
 * The table name.
 *
 * Not the entity's own name: `transaction` is a keyword in Postgres, and while
 * an unquoted table by that name does parse, every statement the model
 * generates against it would be one quoting mistake from a syntax error, which
 * would show up as a baseline defect rather than as the naming choice it is.
 */
export const WIDE_TABLE = "bank_transaction";

/** The table carrying the parity fingerprint, so both stores can be shown to agree. */
export const META_TABLE = "demo_meta";

/**
 * How the engine's field types become Postgres column types.
 *
 * Every one of the three interesting decisions falls out of the declared type
 * rather than out of a column name, which is why this is a table and not a
 * series of special cases.
 *
 * `str` becomes `text`, which is what keeps a twenty-digit identifier intact.
 * `bigint` would round-trip correctly through node-postgres, since it returns
 * `int8` as a string, and would silently lose precision in most other
 * clients — a defect invisible in exactly the place it was introduced.
 *
 * `int` becomes `bigint` rather than `timestamptz`, even though every `int`
 * field in this model is epoch milliseconds. A timestamp column would hand the
 * baseline `date_trunc` and interval arithmetic that the governed surface
 * cannot express, changing what a question like "last month" costs on one side
 * only.
 *
 * `float` becomes `numeric(18,2)`, which gives the baseline exact decimal
 * arithmetic that the governed side's float64 sums do not have. That is
 * deliberate, and it matches the `NUMBER(18,2)` the source column used.
 */
const COLUMN_TYPES: Readonly<Record<string, string>> = {
  [FieldType.Str]: "text",
  [FieldType.Int]: "bigint",
  [FieldType.Float]: "numeric(18,2)",
  [FieldType.Bool]: "boolean",
};

export interface WideColumn {
  readonly name: string;
  readonly type: string;
  /** The entity the field was declared on, so the DDL can say where it came from. */
  readonly entity: string;
}

/** How a related entity's fields were folded in, so the loader can repeat the join. */
export interface WideJoin {
  readonly entity: string;
  /** The column on the base entity holding the related record's key. */
  readonly sourceField: string;
  /** The related entity's key component. */
  readonly targetKey: string;
}

export interface WideTable {
  readonly name: string;
  readonly primaryKey: string;
  readonly subjectColumn: string;
  readonly baseEntity: string;
  readonly columns: readonly WideColumn[];
  readonly joins: readonly WideJoin[];
}

const keyComponentOf = (entity: EntityDescription): string => {
  const key = (entity.fields ?? []).find(field => field.isKeyComponent === true);
  if (key?.name === undefined) {
    throw new Error(`Entity ${entity.name ?? "(unnamed)"} declares no key component.`);
  }
  return key.name;
};

const columnOf = (field: FieldDescription, entity: string): WideColumn => {
  const type = COLUMN_TYPES[field.type];
  if (type === undefined) {
    // Reached only by a domain declaring a list or object field. Failing here
    // rather than guessing keeps the two stores holding identical data, which
    // the comparison depends on.
    throw new Error(
      `Field ${entity}.${field.name} is declared ${field.type}, which this schema does not map ` +
        `to a column type. Decide the mapping in src/sql-plane/schema.ts before comparing.`,
    );
  }
  return { name: field.name, type, entity };
};

/**
 * Flattens a domain into one table.
 *
 * The base entity is the one carrying the subject field, since that is the
 * entity a customer's questions are about. Every relationship it declares is
 * followed once and the target's fields are appended, minus the field the
 * relationship joins on, which the base entity already carries. One hop only:
 * a deeper graph would need a join order, and this model has none.
 */
export const wideTableOf = (domain: DomainModel): WideTable => {
  const byName = new Map(domain.entities.map(entity => [entity.name, entity]));
  const base = byName.get(domain.subjectField.entity);
  if (base === undefined) {
    throw new Error(
      `The domain names ${domain.subjectField.entity} as its subject entity, but declares no such entity.`,
    );
  }

  const columns: WideColumn[] = (base.fields ?? []).map(field => columnOf(field, base.name ?? ""));
  const seen = new Set(columns.map(column => column.name));

  const joins: WideJoin[] = [];
  for (const relationship of base.relationships ?? []) {
    const label = `${base.name ?? ""}.${relationship.name ?? "(unnamed)"}`;
    const target = byName.get(relationship.target);
    if (target === undefined) {
      throw new Error(
        `Relationship ${label} targets ${relationship.target ?? "(unnamed)"}, which the ` +
          `domain does not declare.`,
      );
    }
    for (const field of target.fields ?? []) {
      if (seen.has(field.name)) continue;
      columns.push(columnOf(field, target.name ?? ""));
      seen.add(field.name);
    }
    if (relationship.sourceField === undefined) {
      throw new Error(
        `Relationship ${label} declares no sourceField, so the loader has no column to join on.`,
      );
    }
    joins.push({
      entity: target.name ?? "",
      sourceField: relationship.sourceField,
      targetKey: keyComponentOf(target),
    });
  }

  return {
    name: WIDE_TABLE,
    primaryKey: keyComponentOf(base),
    subjectColumn: domain.subjectField.field,
    baseEntity: base.name ?? "",
    columns,
    joins,
  };
};

/**
 * A column definition.
 *
 * Every text column defaults to the empty string rather than accepting null,
 * because the generator emits `''` for an absent `terminal_id` or
 * `error_code`. Mapping those to null would give the baseline three-valued
 * logic on fields the governed surface exposes as tag filters over `''`, so
 * the two stores would no longer hold identical data.
 */
const definitionOf = (column: WideColumn): string =>
  column.type === "text"
    ? `  ${column.name} text NOT NULL DEFAULT ''`
    : `  ${column.name} ${column.type} NOT NULL`;

/**
 * The DDL, indexed generously.
 *
 * Indexing the columns the baseline is most likely to filter and sort on is
 * the generous direction, and generosity towards the baseline is the rule
 * throughout this comparison: an under-indexed table would show up as
 * baseline latency and flatter the governed side.
 */
export const buildDdl = (table: WideTable): string =>
  [
    `DROP TABLE IF EXISTS ${table.name};`,
    `DROP TABLE IF EXISTS ${META_TABLE};`,
    "",
    `CREATE TABLE ${table.name} (`,
    table.columns.map(definitionOf).join(",\n"),
    `);`,
    "",
    `ALTER TABLE ${table.name} ADD PRIMARY KEY (${table.primaryKey});`,
    `CREATE INDEX ON ${table.name} (${table.subjectColumn});`,
    `CREATE INDEX ON ${table.name} (${table.subjectColumn}, transaction_date DESC);`,
    "",
    `CREATE TABLE ${META_TABLE} (`,
    "  fingerprint text NOT NULL,",
    "  seeded_at bigint NOT NULL",
    ");",
  ].join("\n");

/**
 * The role the SQL arm connects as.
 *
 * `SELECT` on everything, and nothing else. This is the realistic default and
 * the reference implementation's choice: it keeps the demo from being able to
 * damage anything, and it deliberately does not narrow what the agent can
 * read, because what the agent can read is the thing being measured. A
 * read-only role is also not a defence against a full scan, which is why the
 * arm sets a statement timeout as well.
 */
export const readerRoleSql = (role: string, password: string, database: string): string =>
  [
    "DO $$",
    "BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN`,
    `    CREATE ROLE ${role} LOGIN PASSWORD '${password}';`,
    "  END IF;",
    "END",
    "$$;",
    `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
    `GRANT USAGE ON SCHEMA public TO ${role};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role};`,
  ].join("\n");

/** The judge's view of this table: one table, one subject column. */
export const judgeSchemaOf = (
  table: WideTable,
): { subjectColumnByTable: Record<string, string> } => ({
  subjectColumnByTable: { [table.name]: table.subjectColumn },
});
