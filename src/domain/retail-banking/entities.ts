import type {
  EntityDescription,
  FieldDescription,
  RedisIndexConfig,
} from "@redis-iris/context-retriever/models";
import { DocumentType, RedisIndexType } from "@redis-iris/context-retriever/models";

import { FieldType } from "../field-types.ts";

export const KEY_PREFIX = "retail_banking";

/**
 * Index helpers.
 *
 * Only `tag` and `numeric` indexes become parameters on the generated
 * `filter_<entity>` tool. A `text` index makes a field searchable through
 * `search_<entity>_by_text` without adding a filter parameter, and an
 * unindexed field is still stored and returned but cannot be filtered.
 *
 * That makes the index set the lever on tool-schema size, and tool schemas are
 * re-sent to the model on every turn. Curation below is therefore a token
 * decision as much as a query one.
 */
const tag = (): RedisIndexConfig => ({ type: RedisIndexType.Tag });
const numeric = (): RedisIndexConfig => ({ type: RedisIndexType.Numeric, sortable: true });
const text = (weight: number): RedisIndexConfig => ({ type: RedisIndexType.Text, weight });

/** An indexed field. */
const indexed = (
  name: string,
  type: FieldType,
  description: string,
  indices: readonly RedisIndexConfig[],
  extra: Partial<FieldDescription> = {},
): FieldDescription => ({
  name,
  type,
  description,
  redisIndices: [...indices],
  ...extra,
});

/**
 * A key component: part of the Redis key template.
 *
 * The engine rejects any index on a key component, because the key *is* the
 * address. Exact lookup is served by the generated `get_<entity>_by_id` tool
 * rather than by a secondary index, so nothing is lost.
 */
const keyComponent = (name: string, description: string): FieldDescription => ({
  name,
  type: FieldType.Str,
  description,
  isKeyComponent: true,
  redisIndices: [],
});

/** A field that is stored and returned but never filtered or searched on. */
const stored = (name: string, type: FieldType, description: string): FieldDescription => ({
  name,
  type,
  description,
  redisIndices: [],
});

/** Enumerated values become a closed set on the generated filter parameter. */
const enumerated = (
  name: string,
  description: string,
  allowedValues: readonly string[],
): FieldDescription =>
  indexed(name, FieldType.Str, description, [tag()], { allowedValues: [...allowedValues] });

export const TRANSACTION_TYPES = ["DEBIT", "CREDIT", "TRANSFER"] as const;
export const TRANSACTION_CODES = ["ATM", "POS", "ACH", "SWIFT"] as const;
export const CHANNEL_CODES = ["MOBILE", "ATM", "BRANCH", "UPI", "POS"] as const;
export const TRANSACTION_STATUSES = ["SUCCESS", "FAILED", "PENDING"] as const;
export const DR_CR_FLAGS = ["D", "C"] as const;

/**
 * The transaction entity.
 *
 * Derived from a single wide source table that also held the attributes of
 * three things it only carried keys for: customer, account and channel. Those
 * are inlined here as fields rather than modelled as entities. Relationships
 * generate no traversal tool, so each hop would be a caller round trip charged
 * in latency and tokens, and none of the three carries enough attributes to
 * answer a question of its own.
 *
 * Thirteen of the twenty-five fields are indexed. Two omissions are decisions
 * rather than economies, and both are noted at the field.
 */
/*
 * A note on field descriptions, learned by measuring.
 *
 * The engine folds every indexed field's `description` into the generated
 * tool's own description. A tool description is re-sent to the model on every
 * turn, so these strings are agent-facing prompt text charged per turn, not
 * internal documentation. They say what an agent needs in order to choose and
 * use the field, and nothing else. Rationale for a human reader lives in
 * comments like this one, which cost nothing.
 */
const transaction: EntityDescription = {
  name: "transaction",
  description:
    "A single posted or attempted movement of money on a customer account, including its channel, counterparty and outcome.",
  documentType: DocumentType.Json,
  redisKeyTemplate: `${KEY_PREFIX}_transaction:{transaction_id}`,
  // Declares which field carries the end-user identity. Enforcement additionally
  // needs an identity provider on the surface and a user token on the MCP
  // session; this repository declares the mapping without enforcing it.
  // `documentField` is a top-level JSONPath, not a bare field name: the engine
  // requires the `$.` prefix and rejects anything deeper than one level.
  aclFieldMappings: [{ documentField: "$.customer_id", accessTag: "customer" }],
  relationships: [
    {
      name: "beneficiary",
      target: "beneficiary",
      sourceField: "beneficiary_id",
      description: "The counterparty this transaction paid or was received from.",
    },
  ],
  fields: [
    keyComponent(
      "transaction_id",
      "Unique transaction identifier. An opaque string; look one up with get_transaction_by_id.",
    ),
    indexed(
      "customer_id",
      FieldType.Str,
      "Opaque identifier of the customer who owns the account. Scope every question to one customer.",
      [tag()],
    ),
    indexed("account_id", FieldType.Str, "Opaque identifier of the debited or credited account.", [
      tag(),
    ]),
    indexed(
      "transaction_date",
      FieldType.Int,
      "When the transaction was posted, epoch milliseconds UTC. Call get_current_time before filtering on a period relative to now.",
      [numeric()],
    ),
    enumerated(
      "transaction_type",
      "Direction of the movement from the account's point of view.",
      TRANSACTION_TYPES,
    ),
    enumerated("transaction_code", "The clearing rail the transaction used.", TRANSACTION_CODES),
    indexed(
      "amount",
      FieldType.Float,
      "Value in the units of currency_code. Always pair with currency_code: totals across currencies are meaningless.",
      [numeric()],
    ),
    indexed("currency_code", FieldType.Str, "ISO 4217 currency of amount and the balances.", [
      tag(),
    ]),
    indexed(
      "balance_after",
      FieldType.Float,
      "Balance immediately after this transaction. The newest one is the current balance.",
      [numeric()],
    ),
    indexed("reference_no", FieldType.Str, "Bank-assigned reference for exact lookup.", [tag()]),
    enumerated("channel_code", "The channel the customer used.", CHANNEL_CODES),
    indexed(
      "beneficiary_id",
      FieldType.Str,
      "Opaque counterparty identifier. Filter on this to find a beneficiary's transactions.",
      [tag()],
    ),
    enumerated(
      "status",
      "Outcome. FAILED and PENDING have not moved money; never report either as completed.",
      TRANSACTION_STATUSES,
    ),

    // Text-indexed: searchable through search_transaction_by_text, but a text
    // index is not one of the two types that become filter parameters, so
    // these cost nothing in the filter tool's schema.
    indexed("payment_purpose", FieldType.Str, "Customer-stated purpose of the payment.", [
      text(1.0),
    ]),
    indexed("remarks", FieldType.Str, "Free-text narrative recorded against the transaction.", [
      text(1.0),
    ]),

    // Stored but unindexed. Returned in results, never filterable.
    stored("value_date", FieldType.Int, "Value date, as epoch milliseconds UTC."),
    // Deliberately unindexed: redundant with transaction_type. Indexing both
    // would give the agent two ways to express one predicate, and therefore a
    // way to express two contradictory ones.
    stored("dr_cr_flag", FieldType.Str, "Debit or credit marker, D or C."),
    stored(
      "balance_before",
      FieldType.Float,
      "Account balance immediately before this transaction.",
    ),
    stored(
      "external_ref_no",
      FieldType.Str,
      "Counterparty or scheme reference, where one was supplied.",
    ),
    stored(
      "channel_name",
      FieldType.Str,
      "Human-readable channel name, derivable from channel_code.",
    ),
    stored("device_id", FieldType.Str, "Originating device, where the channel reported one."),
    stored("terminal_id", FieldType.Str, "Originating terminal, for ATM and POS transactions."),
    stored("error_code", FieldType.Str, "Failure reason. Populated only when status is FAILED."),
    stored("created_date", FieldType.Int, "Record creation time, as epoch milliseconds UTC."),
    stored("updated_date", FieldType.Int, "Record last-update time, as epoch milliseconds UTC."),
  ],
};

/**
 * The beneficiary entity.
 *
 * The only relationship in the model, and a deliberate exception to the rule
 * that eliminated customer, account and channel: it is thin by that same test.
 * It stays because a single-entity model has no relationship at all, which
 * would remove the product's central claim from a demo about that product.
 * Counterparty names are also the one part of a transaction a customer
 * searches by wording rather than exact value.
 */
const beneficiary: EntityDescription = {
  name: "beneficiary",
  description:
    "A counterparty a customer has paid or received money from, normalised out of the transaction row.",
  documentType: DocumentType.Json,
  redisKeyTemplate: `${KEY_PREFIX}_beneficiary:{beneficiary_id}`,
  // Declared explicitly as empty rather than omitted. Omitting it makes the
  // service store and return `relationships: null`, which the SDK's response
  // schema rejects, so an entity with no relationships is undeserialisable.
  relationships: [],
  fields: [
    keyComponent(
      "beneficiary_id",
      "Unique counterparty identifier. An opaque string; look one up with get_beneficiary_by_id.",
    ),
    indexed(
      "beneficiary_name",
      FieldType.Str,
      "Registered name of the counterparty. Search this to find who was paid.",
      [text(2.0)],
    ),
    indexed("beneficiary_bank", FieldType.Str, "Name of the counterparty's bank.", [text(1.0)]),
    indexed(
      "beneficiary_bank_code",
      FieldType.Str,
      "SWIFT or local clearing code of the counterparty's bank.",
      [tag()],
    ),
    indexed("beneficiary_country", FieldType.Str, "ISO 3166 alpha-2 country of the counterparty.", [
      tag(),
    ]),
    stored(
      "beneficiary_account_masked",
      FieldType.Str,
      "Masked counterparty account number. Never a filter.",
    ),
    stored("beneficiary_branch", FieldType.Str, "Counterparty bank branch, where reported."),
  ],
};

export const entities: readonly EntityDescription[] = [transaction, beneficiary];
