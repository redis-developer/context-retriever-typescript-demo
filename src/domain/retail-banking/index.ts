import type { DomainModel } from "../types.ts";

import { KEY_PREFIX, entities } from "./entities.ts";
import { internalTools } from "./internal-tools.ts";
import { DEFAULT_GENERATE_OPTIONS, generate } from "./records.ts";
import { resultSchemas } from "./schemas.ts";

export const retailBanking: DomainModel = {
  name: "retail-banking",
  title: "Retail banking transactions",
  description:
    "Retail bank transactions and the counterparties they were paid to, modelled for an assistant answering a customer's questions about their own money.",
  entities,
  keyPrefix: KEY_PREFIX,
  generate: (seed, primarySubjectValue) =>
    generate(seed, { ...DEFAULT_GENERATE_OPTIONS, primaryCustomerId: primarySubjectValue }),
  resultSchemas,
  subjectField: { entity: "transaction", field: "customer_id" },
  internalTools,
};

export { DEFAULT_GENERATE_OPTIONS };
export * from "./schemas.ts";
