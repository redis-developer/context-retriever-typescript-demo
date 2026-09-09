import { describe as group, expect, it } from "vitest";
import type { ContextSurface } from "@redis-iris/context-retriever/models";

import { assertSurfaceMatches } from "../src/control-plane/surfaces.ts";
import { resolveDomain } from "../src/domain/index.ts";

/**
 * Tests for the check that decides whether an existing surface is reusable.
 *
 * Worth pinning because both failure modes are silent. A rerun after the
 * committed schema changed would keep serving the previous tool surface, and a
 * name collision with an unrelated surface would import records into it and
 * mint a supposedly scoped key against a model whose ACL mappings may scope
 * nothing.
 */

const domain = resolveDomain("retail-banking");

/** A surface carrying exactly the model this domain declares. */
const surfaceOf = (entities: unknown): ContextSurface =>
  ({ name: "retail-banking-demo", dataModel: { entities } }) as ContextSurface;

const declared = (): unknown => JSON.parse(JSON.stringify(domain.entities));

group("reusing an existing surface", () => {
  it("accepts a surface whose model matches the declared one", () => {
    expect(() => {
      assertSurfaceMatches(surfaceOf(declared()), domain);
    }).not.toThrow();
  });

  it("accepts a model whose entities and fields arrive in a different order", () => {
    // The service is free to reorder what it stores, and reordering is not a
    // difference. Comparing the serialised model directly would fail here.
    const entities = declared() as { fields: unknown[] }[];
    entities.reverse();
    entities[0]?.fields.reverse();
    expect(() => {
      assertSurfaceMatches(surfaceOf(entities), domain);
    }).not.toThrow();
  });

  it("refuses when a field has been added since the surface was created", () => {
    const entities = declared() as { fields: { name: string }[] }[];
    entities[0]?.fields.push({ name: "settlement_reference" });
    expect(() => {
      assertSurfaceMatches(surfaceOf(entities), domain);
    }).toThrow(/already exists, but its data model/);
  });

  it("refuses when an entity is missing", () => {
    const entities = (declared() as unknown[]).slice(1);
    expect(() => {
      assertSurfaceMatches(surfaceOf(entities), domain);
    }).toThrow(/already exists, but its data model/);
  });

  it("refuses when the ACL mapping differs, which is the dangerous case", () => {
    // A surface that indexes the same fields but scopes on a different tag
    // would mint a key that reads everything. The fingerprint includes the
    // mappings for exactly this reason.
    const entities = declared() as { aclFieldMappings?: { accessTag: string }[] }[];
    const mapped = entities.find(entity => entity.aclFieldMappings !== undefined);
    if (mapped?.aclFieldMappings?.[0] !== undefined) {
      mapped.aclFieldMappings[0].accessTag = "tenant";
    }
    expect(() => {
      assertSurfaceMatches(surfaceOf(entities), domain);
    }).toThrow(/already exists, but its data model/);
  });

  it("names the commands that resolve it, so the message is actionable", () => {
    const entities = (declared() as unknown[]).slice(1);
    expect(() => {
      assertSurfaceMatches(surfaceOf(entities), domain);
    }).toThrow(/npm run teardown/);
  });

  it("refuses a surface carrying no model at all", () => {
    expect(() => {
      assertSurfaceMatches({ name: "x" } as ContextSurface, domain);
    }).toThrow(/already exists, but its data model/);
  });
});
