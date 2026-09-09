import { ContextRetrieverMCPClient } from "@redis-iris/context-retriever/mcp";
import type { MCPCallToolResult, MCPTool } from "@redis-iris/context-retriever/mcp";

import { isSessionGone } from "../lib/errors.ts";

/**
 * Holds one MCP session and replaces it when it dies.
 *
 * One client holds one session, and there is no automatic reconnect: a client
 * whose session has gone must be discarded. Two halves are needed, and a pool
 * with only the first will still fail its next call after a session expires.
 *
 * `isOpen` keeps a known-dead client from being handed out. It becomes false
 * when `close()` has run, when the transport dropped, or when a request came
 * back 404, which is how the service reports a session it has forgotten.
 *
 * The 404 branch handles the request that *discovers* the session is dead. No
 * check beforehand can predict it, because the first request on a forgotten
 * session is the request that finds out.
 *
 * Scope one of these per `(mcpURL, agent key)` pair, never per end user: a
 * changing end-user identity belongs in `userAccessToken` as a provider
 * function, which the SDK re-resolves on every request.
 */
export interface SurfaceSessionOptions {
  readonly mcpUrl: string;
  readonly agentApiKey: string;
  readonly timeoutMs?: number;
}

export class SurfaceSession {
  #client: ContextRetrieverMCPClient | undefined;
  // An explicit field rather than a constructor parameter property, because
  // `erasableSyntaxOnly` forbids syntax Node cannot simply strip.
  readonly #options: SurfaceSessionOptions;

  constructor(options: SurfaceSessionOptions) {
    this.#options = options;
  }

  async #acquire(): Promise<ContextRetrieverMCPClient> {
    if (this.#client?.isOpen !== true) {
      this.#client = await ContextRetrieverMCPClient.connect({
        mcpURL: this.#options.mcpUrl,
        agentApiKey: () => this.#options.agentApiKey,
        timeoutMs: this.#options.timeoutMs ?? 30_000,
      });
    }
    return this.#client;
  }

  /** Drops the client without letting a failed teardown escape. */
  async #discard(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    // `close()` can throw when session termination fails, and an unhandled
    // rejection from cleanup would mask the real error.
    await client?.close().catch(() => undefined);
  }

  /**
   * Runs one operation, replacing the client exactly once if the session turns
   * out to be gone.
   *
   * Bounded to a single retry on purpose: one attempt distinguishes an expired
   * session from a surface that is genuinely refusing the call, and it is only
   * safe at all because everything here is a read. A side-effectful tool would
   * need its own idempotency check before being replayed.
   */
  async #withRetry<T>(operation: (client: ContextRetrieverMCPClient) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.#acquire());
    } catch (error) {
      if (!isSessionGone(error)) throw error;
      await this.#discard();
      return await operation(await this.#acquire());
    }
  }

  /**
   * Every tool the surface exposes.
   *
   * Names and argument shapes are generated from the surface's data model, so
   * they are not known at SDK release time and must be read at runtime. The
   * SDK follows tool-list pagination internally, so this array is complete.
   */
  async listTools(): Promise<readonly MCPTool[]> {
    return this.#withRetry(client => client.listTools());
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { readonly timeoutMs?: number } = {},
  ): Promise<MCPCallToolResult> {
    const requestOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
    return this.#withRetry(client => client.callTool(name, args, requestOptions));
  }

  /** The server-assigned session id, for correlating logs with the service's. */
  get sessionId(): string | undefined {
    return this.#client?.sessionId;
  }

  async close(): Promise<void> {
    await this.#discard();
  }
}
