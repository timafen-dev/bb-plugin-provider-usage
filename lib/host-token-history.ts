import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { slicesFromScan, type MachineTokens } from "./machine-tokens";
import {
  scanTokenFiles,
  type FileCacheEntry,
  type FileScanResult,
} from "./token-scan";

/** A scan younger than this is answered as is. */
const FRESH_MS = 2 * 60_000;
/** How long a caller waits for a refresh before getting the previous answer. */
const WAIT_MS = 20_000;

const CACHE_FILE = "token-cache.json";
const LAST_FILE = "token-last.json";

function entryFrom(file: FileScanResult): FileCacheEntry {
  return {
    mtimeMs: file.mtimeMs,
    size: file.size,
    daily: file.daily,
    ...(file.keyedEvents ? { keyedEvents: file.keyedEvents } : {}),
    ...(file.blobCount != null
      ? { blobCount: file.blobCount, maxRowid: file.maxRowid }
      : {}),
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Replace the file whole, so a worker stopped mid-write leaves the old one. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, path);
}

/**
 * The machine side of the token chart. The daemon may stop an idle worker at
 * any time, so both the per-file parse cache and the last answer live in the
 * plugin's data directory; a restarted worker answers at once and re-reads
 * only files that changed.
 */
export function createHostTokenHistory(options: {
  dataDir: string;
  computer?: string;
  scan?: typeof scanTokenFiles;
  now?: () => number;
}) {
  const scan = options.scan ?? scanTokenFiles;
  const now = options.now ?? Date.now;
  const computer = options.computer ?? hostname();
  let cache: Map<string, FileCacheEntry> | null = null;
  let last: MachineTokens | null = null;
  let running: Promise<MachineTokens> | null = null;

  const load = async () => {
    if (cache) return;
    const rows = await readJson<[string, FileCacheEntry][]>(
      join(options.dataDir, CACHE_FILE),
    );
    cache = new Map(Array.isArray(rows) ? rows : []);
    last = await readJson<MachineTokens>(join(options.dataDir, LAST_FILE));
  };

  const scanOnce = async (): Promise<MachineTokens> => {
    await load();
    const result = await scan({
      cached: cache!,
      includeCursor: true,
      includeOpencode: true,
    });
    // Rebuilt from this scan alone, so files that aged out or were deleted
    // stop taking up room.
    const next = new Map(result.files.map((file) => [file.path, entryFrom(file)]));
    const dropped = cache!.size !== next.size;
    cache = next;
    if (result.changedFiles > 0 || dropped) {
      await writeJson(join(options.dataDir, CACHE_FILE), [...next]);
    }
    last = {
      computer,
      scannedAt: new Date(now()).toISOString(),
      changedFiles: result.changedFiles,
      slices: slicesFromScan(result),
    };
    await writeJson(join(options.dataDir, LAST_FILE), last);
    return last;
  };

  return {
    async read(input: {
      force?: boolean;
      /** Keeps the worker alive while a scan outlives its caller. */
      retain?: () => { dispose(): unknown };
      waitMs?: number;
    }): Promise<MachineTokens> {
      await load();
      if (
        last &&
        !input.force &&
        now() - Date.parse(last.scannedAt) < FRESH_MS
      ) {
        return last;
      }
      if (!running) {
        const lease = input.retain?.();
        running = scanOnce().finally(() => {
          running = null;
          lease?.dispose();
        });
      }
      const current = running;
      if (!last) return current;
      // The first scan of a busy machine can take minutes. Hand back what is
      // known rather than hold the server's request open that long.
      current.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), input.waitMs ?? WAIT_MS);
      });
      try {
        return (await Promise.race([current, late])) ?? last;
      } catch {
        return last;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
