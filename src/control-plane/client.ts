import { createContextRetriever } from "@redis-iris/context-retriever";
import type { ContextRetrieverClient } from "@redis-iris/context-retriever";

import { controlPlaneConfig } from "../config/env.ts";

/**
 * The control-plane client: administrative REST, authenticated with an admin key.
 *
 * This module never imports from `src/data-plane/`, and the data plane never
 * imports from here. The two halves use different protocols and different
 * credentials, and the SDK documents mixing them up as the usual cause of a
 * puzzling 401. Keeping them in separate directories with no edge between them
 * makes holding the wrong credential a structural impossibility rather than a
 * mistake to remember not to make.
 *
 * An admin key must never reach an agent.
 */
export const createControlPlaneClient = (): ContextRetrieverClient => {
  const { serverUrl, adminApiKey } = controlPlaneConfig();
  return createContextRetriever({
    serverURL: serverUrl,
    // A function rather than a string: the SDK re-resolves a credential
    // provider on every request, including every retry, which is how a key is
    // rotated without restarting. Reading from the environment here is the
    // trivial case; in production this would read from a secret manager.
    auth: { type: "apiKey", apiKey: () => adminApiKey },
  });
};
