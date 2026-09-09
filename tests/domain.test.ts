import { describe, expect, it } from "vitest";

import { resolveDomain } from "../src/domain/index.ts";
import { FieldType } from "../src/domain/field-types.ts";

const domain = resolveDomain("retail-banking");

const entity = (name: string) => {
  const found = domain.entities.find(e => e.name === name);
  if (found === undefined) throw new Error(`no entity ${name}`);
  return found;
};

const fieldsOf = (name: string) => entity(name).fields ?? [];

/** Reads a record field as a string, rejecting the object cases JsonValue allows. */
const str = (value: unknown): string => {
  if (typeof value === "object" && value !== null) throw new Error("expected a scalar");
  return String(value);
};

/** `EntityDescription.name` is optional in the SDK type; ours are always set. */
const nameOf = (entity: { name?: string | undefined }): string => entity.name ?? "<unnamed>";

const indexTypes = (entityName: string, kinds: readonly string[]): string[] =>
  fieldsOf(entityName)
    .filter(f => f.redisIndices.some(i => kinds.includes(String(i.type))))
    .map(f => f.name)
    .sort();

describe("the entity model", () => {
  it("has exactly the two entities, with one relationship between them", () => {
    expect(domain.entities.map(e => e.name).sort()).toEqual(["beneficiary", "transaction"]);
    expect((entity("transaction").relationships ?? []).map(r => r.target)).toEqual(["beneficiary"]);
    expect(entity("beneficiary").relationships ?? []).toHaveLength(0);
  });

  it("gives every field a description, so generated tools are self-documenting", () => {
    for (const e of domain.entities) {
      for (const f of e.fields ?? []) {
        expect(f.description.length, `${nameOf(e)}.${f.name}`).toBeGreaterThan(0);
      }
    }
  });

  // Only tag and numeric indexes become filter-tool parameters, and tool
  // schemas are re-sent every turn. This asserts the curated set, so an
  // accidental index addition is caught rather than silently charged to every
  // turn of every conversation.
  it("exposes exactly the curated twelve filterable fields on transaction", () => {
    expect(indexTypes("transaction", ["tag", "numeric"])).toEqual([
      "account_id",
      "amount",
      "balance_after",
      "beneficiary_id",
      "channel_code",
      "currency_code",
      "customer_id",
      "reference_no",
      "status",
      "transaction_code",
      "transaction_date",
      "transaction_type",
    ]);
  });

  // The engine rejects any index on a key component, because the key is the
  // address. Exact lookup comes from get_<entity>_by_id instead.
  it("puts no index on any key component", () => {
    const keyComponents = domain.entities.flatMap(e =>
      (e.fields ?? []).filter(f => f.isKeyComponent === true),
    );
    expect(keyComponents.map(f => f.name).sort()).toEqual(["beneficiary_id", "transaction_id"]);
    for (const f of keyComponents) {
      expect(f.redisIndices, f.name).toHaveLength(0);
    }
  });

  // A tag index over a numeric JSONPath value does not merely fail for that
  // field: it stops the document indexing at all, silently emptying the
  // entity's index. So the pairings are asserted rather than assumed.
  it("pairs every index type with a field type the engine allows", () => {
    const allowed: Readonly<Record<string, readonly string[]>> = {
      str: ["text", "tag"],
      int: ["numeric"],
      float: ["numeric"],
      bool: ["tag"],
      "list[float]": ["vector"],
      "list[str]": ["tag"],
    };
    for (const e of domain.entities) {
      for (const f of e.fields ?? []) {
        for (const index of f.redisIndices) {
          expect(allowed[f.type] ?? [], `${nameOf(e)}.${f.name} (${f.type})`).toContain(
            String(index.type),
          );
        }
      }
    }
  });

  it("text-indexes the free-text fields without making them filter parameters", () => {
    expect(indexTypes("transaction", ["text"])).toEqual(["payment_purpose", "remarks"]);
    expect(indexTypes("beneficiary", ["text"])).toEqual(["beneficiary_bank", "beneficiary_name"]);
  });

  it("declares allowed values on every enumerated field, within the engine's limit of 128", () => {
    const enumerated = fieldsOf("transaction").filter(f => (f.allowedValues ?? []).length > 0);
    expect(enumerated.map(f => f.name).sort()).toEqual([
      "channel_code",
      "status",
      "transaction_code",
      "transaction_type",
    ]);
    for (const f of enumerated) {
      expect((f.allowedValues ?? []).length).toBeLessThanOrEqual(128);
      expect(f.redisIndices.some(i => String(i.type) === "tag")).toBe(true);
    }
  });

  it("models every identifier as a string, because the source type overflows a JS number", () => {
    const identifiers = domain.entities.flatMap(e =>
      (e.fields ?? []).filter(f => f.name.endsWith("_id")),
    );
    expect(identifiers.length).toBeGreaterThan(0);
    for (const f of identifiers) {
      expect(f.type, f.name).toBe(FieldType.Str);
    }
  });

  it("declares no vector index, since semantic retrieval is out of scope", () => {
    for (const e of domain.entities) {
      for (const f of e.fields ?? []) {
        expect(f.redisIndices.map(i => String(i.type))).not.toContain("vector");
      }
    }
  });

  it("keeps the ACL mapping and the declared subject field in agreement", () => {
    const subject = domain.subjectField;
    const mappings = entity(subject.entity).aclFieldMappings ?? [];
    // The engine requires a top-level JSONPath, so the mapping is `$.field`.
    expect(mappings.map(m => m.documentField)).toContain(`$.${subject.field}`);
    for (const mapping of mappings) {
      expect(mapping.documentField ?? "").toMatch(/^\$\.[A-Za-z_][A-Za-z0-9_]*$/);
      expect(mapping.accessTag ?? "").toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
  });

  it("namespaces every key template by domain", () => {
    for (const e of domain.entities) {
      expect(e.redisKeyTemplate ?? "").toMatch(new RegExp(`^${domain.keyPrefix}_`));
    }
  });
});

describe("the record generator", () => {
  it("is deterministic in its seed", () => {
    expect(JSON.stringify(domain.generate(1, "CUST001"))).toEqual(
      JSON.stringify(domain.generate(1, "CUST001")),
    );
    expect(JSON.stringify(domain.generate(1, "CUST001"))).not.toEqual(
      JSON.stringify(domain.generate(2, "CUST001")),
    );
  });

  // The source columns are NUMBER(20). Held as JavaScript numbers these values
  // are silently corrupted, so the generator emits them at full width to keep
  // the hazard real rather than hypothetical.
  it("emits every identifier at a width a JavaScript number would corrupt", () => {
    const records = domain.generate(1, "CUST001").flatMap(batch => batch.records);
    for (const field of ["transaction_id", "account_id", "beneficiary_id"]) {
      const id = str(records.find(record => record[field] !== undefined)?.[field]);
      expect(id, field).toMatch(/^\d{20}$/);
      expect(Number(id), field).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
      expect(String(Number(id)), field).not.toEqual(id);
    }
  });

  it("emits records whose fields all exist in the declared model", () => {
    for (const batch of domain.generate(1, "CUST001")) {
      const declared = new Set(fieldsOf(batch.entity).map(f => f.name));
      for (const record of batch.records) {
        for (const key of Object.keys(record)) {
          expect(declared, `${batch.entity}.${key} is not declared`).toContain(key);
        }
      }
    }
  });

  it("validates its own output against the domain result schemas", () => {
    for (const batch of domain.generate(1, "CUST001")) {
      const schema = domain.resultSchemas[batch.entity];
      expect(schema, `no schema for ${batch.entity}`).toBeDefined();
      for (const record of batch.records) {
        expect(() => schema?.parse(record)).not.toThrow();
      }
    }
  });

  it("carries the variety every claim in the demo depends on", () => {
    const rows =
      domain.generate(1, "CUST001").find(batch => batch.entity === domain.subjectField.entity)
        ?.records ?? [];
    const subject = domain.subjectField.field;
    // Other customers, so scoping has something to exclude. Failed and pending
    // rows, so status handling can be shown. More than one currency, so a
    // cross-currency total can be shown to be meaningless. Each of these is a
    // claim the README makes; a generator change that quietly removed any of
    // them would leave the claim standing with nothing behind it.
    expect(new Set(rows.map(row => row[subject])).size).toBeGreaterThan(1);
    expect(new Set(rows.map(row => row["status"]))).toEqual(
      new Set(["SUCCESS", "FAILED", "PENDING"]),
    );
    expect(new Set(rows.map(row => row["currency_code"])).size).toBeGreaterThan(1);
  });
});

describe("internal tools", () => {
  it("expose no arguments, so the agent cannot ask for another customer's profile", () => {
    expect(domain.internalTools.length).toBeGreaterThan(0);
    for (const tool of domain.internalTools) {
      // The interface has no inputSchema field at all; this asserts the shape
      // stays that way, since adding one is how the guardrail would be lost.
      expect(Object.keys(tool)).toEqual(["name", "description", "execute"]);
    }
  });

  it("returns the injected customer from get_customer_profile", async () => {
    const tool = domain.internalTools.find(t => t.name === "get_customer_profile");
    const result = await tool?.execute({
      customer: { customerId: "CUST042", name: "Test Person" },
    });
    expect(result).toEqual({ customerId: "CUST042", name: "Test Person" });
  });
});
