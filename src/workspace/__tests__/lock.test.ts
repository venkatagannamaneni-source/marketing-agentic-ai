import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../lock.ts";
import { WorkspaceError } from "../errors.ts";

describe("acquireLock", () => {
  let tempDir: string;
  const lockPaths: string[] = [];

  afterEach(async () => {
    // Clean up any stale locks
    for (const p of lockPaths) {
      try {
        await rmdir(`${p}.lock`);
      } catch {
        // ignore
      }
    }
    lockPaths.length = 0;
  });

  async function getTempFile(): Promise<string> {
    if (!tempDir) {
      tempDir = await mkdtemp(join(tmpdir(), "lock-test-"));
    }
    const path = join(tempDir, `file-${Date.now()}`);
    lockPaths.push(path);
    return path;
  }

  it("acquires and releases a lock successfully", async () => {
    const path = await getTempFile();
    const lock = await acquireLock(path);

    // Lock directory should exist
    const lockStat = await stat(`${path}.lock`);
    expect(lockStat.isDirectory()).toBe(true);

    await lock.release();

    // Lock directory should be removed
    let exists = true;
    try {
      await stat(`${path}.lock`);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("second lock waits for first to release", async () => {
    const path = await getTempFile();
    const lock1 = await acquireLock(path);

    let lock2Acquired = false;
    const lock2Promise = acquireLock(path, 2000).then((lock) => {
      lock2Acquired = true;
      return lock;
    });

    // Small delay — lock2 should still be waiting
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lock2Acquired).toBe(false);

    // Release first lock
    await lock1.release();

    // Second lock should now acquire
    const lock2 = await lock2Promise;
    expect(lock2Acquired).toBe(true);
    await lock2.release();
  });

  it("throws LOCK_TIMEOUT when lock is held too long", async () => {
    const path = await getTempFile();
    const lock1 = await acquireLock(path);

    try {
      await acquireLock(path, 200); // 200ms timeout
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe("LOCK_TIMEOUT");
    } finally {
      await lock1.release();
    }
  });

  it("release is idempotent (calling twice does not error)", async () => {
    const path = await getTempFile();
    const lock = await acquireLock(path);
    await lock.release();
    await lock.release(); // Should not throw
  });
});
