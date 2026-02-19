import { ExecutionError } from "./types.ts";

/**
 * Sleep for the given duration, but reject immediately if the abort signal fires.
 */
export function cancellableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExecutionError("Aborted", "ABORTED", ""));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new ExecutionError("Aborted", "ABORTED", ""));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
