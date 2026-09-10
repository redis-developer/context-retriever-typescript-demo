import type { EntityDescription } from "@redis-iris/context-retriever/models";
import type { ZodType } from "zod";

/**
 * Anything expressible as JSON.
 *
 * Records are typed this precisely rather than as `Record<string, unknown>`
 * because they are written to Redis as JSON documents. It makes the handover to
 * the Redis client sound instead of requiring a cast, and it stops a domain
 * quietly emitting a `Date` or a `Map` that would serialise into something the
 * schema does not describe.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One record: a flat or nested JSON document for one entity. */
export type DomainRecord = Record<string, JsonValue>;

/** One batch of records for one entity, as produced by a domain generator. */
export interface EntityRecords {
  readonly entity: string;
  readonly records: readonly DomainRecord[];
}

/** The signed-in customer, as the application knows them. */
export interface CustomerProfile {
  readonly customerId: string;
  readonly name: string;
}

/**
 * What an internal tool is given when it runs.
 *
 * Note what is absent: anything the agent supplies. Internal tools take no
 * arguments at all, so the model cannot ask for a different customer's
 * profile. Everything a tool needs arrives from the application through this
 * context instead.
 */
export interface InternalToolContext {
  readonly customer: CustomerProfile;
}

/**
 * A tool supplied by the application rather than generated from the schema.
 *
 * The generated tools answer questions about business data. They cannot answer
 * who is signed in or what time it is now, because those are properties of the
 * session rather than the data. These fill that gap, and the agent bridge
 * merges them with the discovered tools into one list.
 *
 * There is no `inputSchema` field by design. See `InternalToolContext`.
 */
export interface InternalTool {
  readonly name: string;
  readonly description: string;
  readonly execute: (context: InternalToolContext) => Promise<unknown>;
}

/**
 * One swappable domain.
 *
 * Replacing the sample domain with a real one means adding a directory that
 * implements this interface and pointing `DEMO_DOMAIN` at it. Provisioning,
 * retrieval and the agent bridge read only this interface, never the concrete
 * domain, so nothing else changes.
 */
export interface DomainModel {
  readonly name: string;
  readonly title: string;
  readonly description: string;

  /**
   * The entity model, held as the SDK's own type rather than a bespoke one that
   * would need translating. This makes the index choices the reviewable
   * artefact.
   */
  readonly entities: readonly EntityDescription[];

  /**
   * Namespace for Redis keys, so several domains can share one instance. The
   * engine never namespaces user data keys itself.
   */
  readonly keyPrefix: string;

  /** Deterministic in `seed`: the same seed yields byte-identical records. */
  /**
   * Deterministic records for a given seed.
   *
   * `primarySubjectValue` is the value of `subjectField` most records must
   * carry, because it is what the agent key will be scoped to. Ignoring it
   * seeds one customer and scopes the key to another, and the symptom is an
   * empty result that looks exactly like a broken index.
   */
  readonly generate: (seed: number, primarySubjectValue: string) => readonly EntityRecords[];

  /**
   * Keyed by entity name. Tool results arrive as `unknown` from a service we do
   * not control, so they are parsed before anything else touches them.
   */
  readonly resultSchemas: Readonly<Record<string, ZodType>>;

  /**
   * Which field carries the end-user identifier. Declared as an ACL mapping on
   * the entity too; a test asserts the two agree.
   */
  readonly subjectField: { readonly entity: string; readonly field: string };

  readonly internalTools: readonly InternalTool[];
}
