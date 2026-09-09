import type { ContextRetrieverClient } from "@redis-iris/context-retriever";
import type { ContextSurface } from "@redis-iris/context-retriever/models";

import type { DomainModel } from "../domain/index.ts";

/**
 * Finding a surface, and deciding whether an existing one is the one you meant.
 *
 * Both operations are shared because both were originally written twice, and
 * the second copy was wrong: teardown read only the first page of surfaces and
 * then reported that the surface did not exist, leaving it and its resources in
 * place on any deployment with more than a hundred of them.
 */

/**
 * Every surface with this name, following pagination rather than assuming one
 * page.
 *
 * Plural because the service does not enforce unique names. Creating a surface
 * whose name is already taken succeeds and returns a second surface, so a
 * lookup that returned the first match would pick one of several arbitrarily,
 * and a teardown built on it would delete an arbitrary one.
 */
export const findSurfacesByName = async (
  client: ContextRetrieverClient,
  name: string,
): Promise<readonly ContextSurface[]> => {
  const ids: string[] = [];
  for (let page = 1; ; page += 1) {
    const { result } = await client.contextSurfaces.listContextSurfaces(page, 100);
    for (const candidate of result.contextSurfaces ?? []) {
      if (candidate.name === name && candidate.id !== undefined) ids.push(candidate.id);
    }
    if (result.pagination?.hasNext !== true) break;
  }
  const surfaces: ContextSurface[] = [];
  for (const id of ids) {
    const { result } = await client.contextSurfaces.getContextSurface(id);
    surfaces.push(result);
  }
  return surfaces;
};

/**
 * A structural fingerprint of a data model: entity names, each entity's field
 * names, and the ACL mappings that decide scoping.
 *
 * Deliberately not a deep comparison of the whole model. The service is free to
 * normalise what it stores, so comparing everything would report differences
 * that are not differences. These three carry what actually matters: the field
 * names determine the generated tool surface, and the ACL mappings determine
 * who can read what.
 */
/** Optional strings coerced once, so the fingerprint is comparable either way. */
const str = (value: string | undefined): string => value ?? "";

const fingerprint = (entities: DomainModel["entities"]): string =>
  JSON.stringify(
    [...entities]
      .map(entity => ({
        name: str(entity.name),
        fields: (entity.fields ?? []).map(field => str(field.name)).sort(),
        acl: (entity.aclFieldMappings ?? [])
          .map(mapping => `${str(mapping.documentField)}=${str(mapping.accessTag)}`)
          .sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );

/**
 * Refuses an existing surface whose model is not the one being asked for.
 *
 * Reusing a same-name surface is convenient and, for an unchanged model, right.
 * It is wrong in two cases that look identical from the outside: a rerun after
 * the committed schema changed, which would keep serving the old tool surface;
 * and a name collision with somebody else's surface, which would import records
 * into it and mint a supposedly scoped key against a model whose ACL mappings
 * may not scope anything. Both are silent, so this fails loudly instead.
 */
export const assertSurfaceMatches = (surface: ContextSurface, domain: DomainModel): void => {
  const existing = fingerprint(surface.dataModel?.entities ?? []);
  const requested = fingerprint(domain.entities);
  if (existing === requested) return;
  throw new Error(
    `A surface named ${JSON.stringify(str(surface.name))} already exists, but its data model ` +
      `is not the one this domain declares, so reusing it would serve a tool surface that no ` +
      `longer matches the code and may not scope reads the way this model expects.\n\n` +
      `Delete it and provision again:\n` +
      `  npm run teardown -- --name ${str(surface.name)}\n` +
      `  npm run provision\n\n` +
      `Records in Redis are not touched by either command.`,
  );
};
