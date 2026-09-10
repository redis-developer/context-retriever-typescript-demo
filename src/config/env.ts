import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Environment configuration, validated once and reported completely.
 *
 * Two properties matter more than the schema itself. Every missing variable is
 * reported in one pass, because discovering prerequisites one failure at a
 * time is the main reason a demo is abandoned. And no secret value ever
 * appears in an error message: the message names the variable, never its
 * contents.
 *
 * Defaults are supplied only for things a reader could reasonably guess, which
 * means the local stack's loopback URLs. Credentials never have defaults.
 */

/** What each variable is for, used to build an actionable error. */
const PURPOSE: Readonly<Record<string, string>> = {
  CONTEXT_RETRIEVER_SERVER_URL:
    "Base URL of the Context Retriever admin REST API. The local stack serves it on http://localhost:8080.",
  CONTEXT_RETRIEVER_API_KEY_AUTH:
    "An admin API key. The local stack writes the first one to /opt/initialAdminKey.txt in the admin pod; `make dev-local-key` prints it.",
  CONTEXT_RETRIEVER_MCP_URL:
    "The surface's MCP URL. `npm run provision` prints it; the local stack serves it on http://localhost:8081/mcp.",
  CONTEXT_RETRIEVER_AGENT_KEY:
    "An agent key scoped to one surface. `npm run provision` prints it, and it is returned exactly once.",
  DEMO_REDIS_URL:
    "Connection URL for the Redis holding the demo records. The local stack exposes it on redis://localhost:6380.",
  DEMO_DATA_SOURCE_ADDR:
    "host:port of the data Redis as the Context Retriever *service* resolves it, which in a container deployment is not the address you use. For the local stack this is redis-data:6379.",
  OPENAI_API_KEY: "An OpenAI API key, used only by the agent for chat completion.",
};

const nonEmpty = z.string().trim().min(1);

/**
 * Turns a failed parse into one message naming every problem.
 *
 * Zod reports all issues already; this formats them with each variable's
 * purpose so the reader can act without opening the source.
 */
const describeFailure = (error: z.ZodError, group: string): Error => {
  const lines = error.issues.map(issue => {
    const name = issue.path.join(".");
    const purpose = PURPOSE[name];
    const detail = purpose ?? issue.message;
    return `  ${name}\n      ${detail}`;
  });
  return new Error(
    `Missing or invalid configuration for ${group}:\n\n${lines.join("\n")}\n\n` +
      `Copy .env.example to .env and fill in the values above.`,
  );
};

/**
 * Loads `.env` once, on first use rather than on import.
 *
 * Importing this module used to read `.env` as a side effect, which meant the
 * unit tests loaded the developer's real credentials into `process.env` merely
 * by importing something that transitively reached here. Nothing asserted on
 * them, so it passed either way, but a test suite that behaves differently on a
 * machine with a `.env` is not the zero-configuration suite this repository
 * claims to have.
 */
let loaded = false;
const loadOnce = (): void => {
  if (loaded) return;
  loaded = true;
  // Set by the Vitest config. The tests assert on what happens when a variable
  // is absent, which a `.env` on the developer's machine would otherwise
  // silently supply.
  if (process.env["DEMO_SKIP_DOTENV"] === "1") return;
  loadDotenv({ quiet: true });
};

const parse = <T extends z.ZodType>(schema: T, group: string): z.output<T> => {
  loadOnce();
  const result = schema.safeParse(process.env);
  if (!result.success) throw describeFailure(result.error, group);
  return result.data;
};

/** Shared settings, always available and never a reason to fail. */
const demoSchema = z.object({
  DEMO_DOMAIN: z.string().trim().min(1).default("retail-banking"),
  DEMO_SEED: z.coerce.number().int().default(1),
  DEMO_CUSTOMER_ID: z.string().trim().min(1).default("CUST001"),
  DEMO_CUSTOMER_NAME: z.string().trim().min(1).default("Aisha Khan"),
  DEMO_CHAT_MODEL: z.string().trim().min(1).default("gpt-5.6-luna"),
  // Not 3000: the local engine stack publishes Grafana there, so the obvious
  // default collides with the very deployment this repository documents.
  DEMO_AGENT_PORT: z.coerce.number().int().positive().default(3100),
});

export const demoConfig = (): {
  domain: string;
  seed: number;
  customerId: string;
  customerName: string;
  chatModel: string;
  agentPort: number;
} => {
  const parsed = parse(demoSchema, "the demo");
  return {
    domain: parsed.DEMO_DOMAIN,
    seed: parsed.DEMO_SEED,
    customerId: parsed.DEMO_CUSTOMER_ID,
    customerName: parsed.DEMO_CUSTOMER_NAME,
    chatModel: parsed.DEMO_CHAT_MODEL,
    agentPort: parsed.DEMO_AGENT_PORT,
  };
};

/** The control plane: administrative REST, authenticated with an admin key. */
const controlPlaneSchema = z.object({
  CONTEXT_RETRIEVER_SERVER_URL: z.url(),
  CONTEXT_RETRIEVER_API_KEY_AUTH: nonEmpty,
});

export const controlPlaneConfig = (): { serverUrl: string; adminApiKey: string } => {
  const parsed = parse(controlPlaneSchema, "the control plane");
  return {
    serverUrl: parsed.CONTEXT_RETRIEVER_SERVER_URL,
    adminApiKey: parsed.CONTEXT_RETRIEVER_API_KEY_AUTH,
  };
};

/** The data plane: MCP, authenticated with an agent key scoped to one surface. */
const dataPlaneSchema = z.object({
  CONTEXT_RETRIEVER_MCP_URL: z.url(),
  CONTEXT_RETRIEVER_AGENT_KEY: nonEmpty,
});

export const dataPlaneConfig = (): { mcpUrl: string; agentApiKey: string } => {
  const parsed = parse(dataPlaneSchema, "the data plane");
  return {
    mcpUrl: parsed.CONTEXT_RETRIEVER_MCP_URL,
    agentApiKey: parsed.CONTEXT_RETRIEVER_AGENT_KEY,
  };
};

/**
 * How the *engine* reaches the data Redis, which is not how *you* reach it.
 *
 * Seeding runs wherever you run it and connects over `DEMO_REDIS_URL`. The
 * surface's data source is resolved by the Context Retriever service, which in
 * a containerised deployment sits on a different network with different DNS.
 * `localhost:6380` on your machine is not `localhost:6380` inside that
 * container, and a surface configured with the wrong one provisions and then
 * fails to index anything.
 *
 * Two variables for what looks like one value, on purpose.
 */
const dataSourceSchema = z.object({
  DEMO_DATA_SOURCE_ADDR: z.string().trim().min(1),
  DEMO_DATA_SOURCE_USERNAME: z.string().trim().optional(),
  DEMO_DATA_SOURCE_PASSWORD: z.string().optional(),
  DEMO_DATA_SOURCE_TLS: z
    .enum(["true", "false"])
    .default("false")
    .transform(value => value === "true"),
});

export const dataSourceConfig = (): {
  addr: string;
  username?: string;
  password?: string;
  tlsEnabled: boolean;
} => {
  const parsed = parse(dataSourceSchema, "the surface's data source");
  const result: { addr: string; username?: string; password?: string; tlsEnabled: boolean } = {
    addr: parsed.DEMO_DATA_SOURCE_ADDR,
    tlsEnabled: parsed.DEMO_DATA_SOURCE_TLS,
  };
  const username = parsed.DEMO_DATA_SOURCE_USERNAME;
  const password = parsed.DEMO_DATA_SOURCE_PASSWORD;
  if (username !== undefined && username !== "") result.username = username;
  if (password !== undefined && password !== "") result.password = password;
  return result;
};

/** Direct Redis access, used only by seeding. */
const redisSchema = z.object({
  DEMO_REDIS_URL: z.string().trim().min(1).default("redis://localhost:6380"),
});

export const redisConfig = (): { url: string } => ({
  url: parse(redisSchema, "seeding").DEMO_REDIS_URL,
});

/** The chat model. Only the agent needs this. */
const agentSchema = z.object({ OPENAI_API_KEY: nonEmpty });

export const agentConfig = (): { openaiApiKey: string } => ({
  openaiApiKey: parse(agentSchema, "the agent").OPENAI_API_KEY,
});

/** Reports which groups are configured, without revealing any value. */
export const configuredGroups = (): Readonly<Record<string, boolean>> => {
  const ok = (read: () => unknown): boolean => {
    try {
      read();
      return true;
    } catch {
      return false;
    }
  };
  return {
    "control plane": ok(controlPlaneConfig),
    "data source": ok(dataSourceConfig),
    "data plane": ok(dataPlaneConfig),
    seeding: ok(redisConfig),
    agent: ok(agentConfig),
  };
};
