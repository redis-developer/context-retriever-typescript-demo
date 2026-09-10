import { demoConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { createControlPlaneClient } from "../../control-plane/client.ts";
import { findSurfacesByName } from "../../control-plane/surfaces.ts";

/**
 * Deletes the demo surface.
 *
 * Deliberately a separate command rather than a `finally` block in
 * provisioning. Deleting a successfully created surface because some later,
 * unrelated step failed is almost never what real provisioning wants, and a
 * demo that teaches that pattern teaches a bad one.
 */
export const teardown = async (options: { readonly name?: string }): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const target = options.name ?? `${domain.name}-demo`;
  const client = createControlPlaneClient();

  // Paginated, and plural. Reading only the first page reported "nothing to do"
  // for a surface that existed on page two; and because the service permits
  // duplicate names, deleting the first match would delete an arbitrary one.
  const surfaces = await findSurfacesByName(client, target);
  if (surfaces.length === 0) {
    console.log(`No surface named ${JSON.stringify(target)}; nothing to do.`);
    return;
  }
  if (surfaces.length > 1) {
    console.log(`${String(surfaces.length)} surfaces are named ${JSON.stringify(target)}:`);
    for (const candidate of surfaces) console.log(`  ${candidate.id}`);
    console.log("");
    console.log("Deleting all of them, because they are all this demo's.");
    for (const candidate of surfaces) {
      await client.contextSurfaces.deleteContextSurface(candidate.id);
      console.log(`  deleted ${candidate.id}`);
    }
    console.log("Records in Redis are untouched: a surface indexed them, it did not own them.");
    return;
  }
  const surface = surfaces[0];
  if (surface?.id === undefined) {
    console.log(`No surface named ${JSON.stringify(target)}; nothing to do.`);
    return;
  }

  await client.contextSurfaces.deleteContextSurface(surface.id);
  console.log(`Deleted surface ${target} (${surface.id}).`);
  console.log("Records in Redis are untouched: the surface indexed them, it did not own them.");
};
