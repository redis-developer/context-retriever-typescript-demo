import type { DomainRecord, EntityRecords } from "../domain/types.ts";
import type { WideTable } from "./schema.ts";

/**
 * Flattens the generated records into rows of the wide table.
 *
 * Both stores are loaded from the same generator call, so this repeats the
 * join the governed surface leaves to a relationship. Doing it here rather
 * than in SQL keeps the loader independent of whether the related records were
 * ever written to Postgres at all: only the wide table is.
 */

/** A value as it goes to the driver. Numbers stay numbers; nothing is stringified. */
export type CellValue = string | number | boolean;

const cellOf = (record: DomainRecord | undefined, column: string): CellValue => {
  const value = record?.[column];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // The generator populates every declared field, so this is reached only when
  // the model and the generator have drifted apart. An empty string would load
  // silently and leave the two stores holding different data.
  throw new Error(
    `No scalar value for column ${column}. The generator and the entity model have drifted.`,
  );
};

export const toWideRows = (
  table: WideTable,
  batches: readonly EntityRecords[],
): readonly (readonly CellValue[])[] => {
  const byEntity = new Map(batches.map(batch => [batch.entity, batch.records]));

  const base = byEntity.get(table.baseEntity);
  if (base === undefined) {
    throw new Error(`The generator produced no ${table.baseEntity} records to load.`);
  }

  /** Each joined entity's records, indexed by the key the base entity holds. */
  const joined = table.joins.map(join => {
    const records = byEntity.get(join.entity) ?? [];
    const index = new Map<CellValue, DomainRecord>();
    for (const record of records) index.set(cellOf(record, join.targetKey), record);
    return { join, index };
  });

  return base.map(record => {
    const related = new Map<string, DomainRecord | undefined>();
    for (const { join, index } of joined) {
      related.set(join.entity, index.get(cellOf(record, join.sourceField)));
    }
    return table.columns.map(column =>
      column.entity === table.baseEntity
        ? cellOf(record, column.name)
        : cellOf(related.get(column.entity), column.name),
    );
  });
};

/** `insert into t (a, b) values ($1, $2), ($3, $4)`, with its parameter list. */
export const insertStatement = (
  table: WideTable,
  rows: readonly (readonly CellValue[])[],
): { readonly text: string; readonly values: readonly CellValue[] } => {
  const width = table.columns.length;
  const tuples = rows.map(
    (_row, rowIndex) =>
      `(${table.columns.map((_column, index) => `$${String(rowIndex * width + index + 1)}`).join(", ")})`,
  );
  return {
    text:
      `INSERT INTO ${table.name} (${table.columns.map(column => column.name).join(", ")}) ` +
      `VALUES ${tuples.join(", ")}`,
    values: rows.flat(),
  };
};
