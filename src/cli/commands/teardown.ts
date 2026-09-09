import { demoConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { createControlPlaneClient } from "../../control-plane/client.ts";

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

  const { result } = await client.contextSurfaces.listContextSurfaces(1, 100);
  const surface = (result.contextSurfaces ?? []).find(candidate => candidate.name === target);
  if (surface?.id === undefined) {
    console.log(`No surface named ${JSON.stringify(target)}; nothing to do.`);
    return;
  }

  await client.contextSurfaces.deleteContextSurface(surface.id);
  console.log(`Deleted surface ${target} (${surface.id}).`);
  console.log("Records in Redis are untouched: the surface indexed them, it did not own them.");
};
