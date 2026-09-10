import { ContextSurfaceStatus } from "@redis-iris/context-retriever/models";
import type { ContextRetrieverClient } from "@redis-iris/context-retriever";
import type { ContextSurface } from "@redis-iris/context-retriever/models";

/**
 * Statuses from which a surface will never become active, so waiting is futile.
 *
 * `Deleting` belongs here: a surface someone deleted concurrently is not a
 * surface that is about to become ready.
 */
const TERMINAL_FAILURE: ReadonlySet<string> = new Set([
  ContextSurfaceStatus.Failed,
  ContextSurfaceStatus.IndicesFailed,
  ContextSurfaceStatus.Deleting,
]);

/** Sleeps, waking early and rejecting if the caller aborts. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Polls until the surface is active.
 *
 * Three properties are deliberate, and all three are easy to get wrong.
 *
 * Success requires `Active` exactly. The tempting shape is "return once the
 * status is no longer pending", but that defaults to optimism: it reports a
 * concurrently deleted surface as ready, and it will report any status the
 * service adds in future as ready too. Anything unrecognised is instead
 * treated as still in flight and waited out, so a new status costs a timeout
 * rather than a silently wrong answer.
 *
 * The statuses come from the exported `ContextSurfaceStatus` enum rather than
 * hand-typed strings, so a server-side rename becomes a compile error here
 * instead of a loop that never terminates.
 *
 * The interval is jittered, so a fleet of provisioning jobs does not
 * synchronise into a thundering herd.
 *
 * Tools do not exist until the surface is active, which is why nothing may
 * proceed on a surface that has not reached it.
 */
export const waitUntilActive = async (
  client: ContextRetrieverClient,
  id: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<ContextSurface> => {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // A signal REPLACES the SDK's per-request deadline rather than combining
    // with it, so the two are composed to keep both.
    const requestOptions =
      options.signal === undefined
        ? {}
        : { signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) };

    const { result: surface } = await client.contextSurfaces.getContextSurface(id, requestOptions);

    if (surface.status === ContextSurfaceStatus.Active) return surface;

    if (TERMINAL_FAILURE.has(surface.status)) {
      throw new Error(
        `Context surface ${id} will never become active (status ${surface.status}): ` +
          (surface.statusReason ?? "no reason reported"),
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`Context surface ${id} still ${surface.status} after ${String(timeoutMs)}ms`);
    }

    const delayMs = 2_000 + Math.floor(Math.random() * 1_500);
    console.log(`  status ${surface.status}, waiting ${String(delayMs)}ms...`);
    await sleep(delayMs, options.signal);
  }
};
