import { ContextRetrieverError, MCPError } from "@redis-iris/context-retriever";

/**
 * The single error boundary every entry point uses.
 *
 * Two rules. `error.details` is never logged: the SDK deliberately makes it
 * hard to leak because it can carry request and response payloads, and a demo
 * that prints it teaches the wrong habit. And `requestId` is always printed
 * when present, because it is the one value that lets someone correlate a
 * failure with the service's own logs.
 */
export const reportError = (error: unknown): void => {
  if (error instanceof ContextRetrieverError) {
    console.error(`\n${error.name}: ${error.message}`);
    if (error.requestId !== undefined) console.error(`  requestId: ${error.requestId}`);
    if (error.statusCode !== undefined) console.error(`  status: ${String(error.statusCode)}`);
    return;
  }
  if (error instanceof Error) {
    console.error(`\n${error.name}: ${error.message}`);
    return;
  }
  console.error("\nUnknown failure:", error);
};

/** Whether a failure means a pooled MCP client is dead and must be replaced. */
export const isSessionGone = (error: unknown): boolean =>
  error instanceof MCPError && error.statusCode === 404;

/** Runs `main`, reports any failure through the boundary, and sets the exit code. */
export const runCommand = async (main: () => Promise<void>): Promise<void> => {
  try {
    await main();
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  }
};

/**
 * Renders an untrusted value as a display string.
 *
 * Record values arrive from a service, so a field the schema expects to be a
 * scalar can be an object. `String()` on one silently yields "[object Object]",
 * which looks like data. This shows the shape instead.
 */
export const display = (value: unknown): string => {
  switch (typeof value) {
    case "undefined":
      return "";
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "object":
      if (value === null) return "";
      return Array.isArray(value) ? `[${String(value.length)} items]` : "{object}";
    default:
      // A symbol or a function is not data, so the shape is shown, not the text.
      return `{${typeof value}}`;
  }
};

/** Formats a duration for console output. */
export const formatMs = (ms: number): string =>
  ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`;

/** Times an awaited operation, returning its result and elapsed milliseconds. */
export const timed = async <T>(operation: () => Promise<T>): Promise<{ result: T; ms: number }> => {
  const started = performance.now();
  const result = await operation();
  return { result, ms: performance.now() - started };
};
