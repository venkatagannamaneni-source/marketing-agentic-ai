import { mkdir, rmdir, stat } from "node:fs/promises";
import { WorkspaceError } from "./errors.ts";

// ── File Lock Interface ──────────────────────────────────────────────────────

export interface FileLock {
  release(): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const STALE_LOCK_AGE_MS = 60_000;

// ── Lock Acquisition ─────────────────────────────────────────────────────────

/**
 * Acquire a file-level lock using atomic mkdir.
 * Creates a `.lock` directory at the given path. If it already exists,
 * polls until it's released or the timeout expires.
 *
 * Stale locks (older than 60 seconds) are automatically cleaned up.
 */
export async function acquireLock(
  filePath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FileLock> {
  const lockPath = `${filePath}.lock`;
  const startTime = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      return {
        async release() {
          try {
            await rmdir(lockPath);
          } catch {
            // Lock dir already removed — not an error
          }
        },
      };
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "EEXIST") {
        // Check for stale lock
        await tryCleanStaleLock(lockPath);

        if (Date.now() - startTime > timeoutMs) {
          throw new WorkspaceError(
            `Lock timeout after ${timeoutMs}ms on ${filePath}`,
            "LOCK_TIMEOUT",
            filePath,
          );
        }
        await sleep(POLL_INTERVAL_MS);
      } else {
        throw err;
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function tryCleanStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath);
    const age = Date.now() - lockStat.mtimeMs;
    if (age > STALE_LOCK_AGE_MS) {
      await rmdir(lockPath);
    }
  } catch {
    // Lock was removed between our check and cleanup — that's fine
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
