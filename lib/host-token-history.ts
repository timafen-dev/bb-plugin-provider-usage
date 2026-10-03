import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isCursorStorePath } from "./cursor-scan";
import { MACHINE_TOKENS_FRESH_MS, slicesFromScan, type MachineTokens } from "./machine-tokens";
import {
  scanTokenFiles,
  type FileCacheEntry,
  type FileScanResult,
} from "./token-scan";

/** Ordinary callers may time out to last-good; forced reads await the scan. */
const WAIT_MS = 20_000;

const CACHE_FILE = "token-cache.json";
const LAST_FILE = "token-last.json";

function entryFrom(file: FileScanResult): FileCacheEntry {
  const { path, ...entry } = file;
  return entry;
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
 * plugin's data directory. A restart may reuse a recent answer only when its
 * timestamp-bearing cache has event evidence; legacy caches must first scan
 * readable originals. Force bypasses warm parse reuse and, during an active
 * scan, waits for a shared cold successor covering the later request.
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
  let queuedForce: Promise<MachineTokens> | null = null;

  const load = async () => {
    if (cache) return;
    const rows = await readJson<[string, FileCacheEntry][]>(
      join(options.dataDir, CACHE_FILE),
    );
    cache = new Map(Array.isArray(rows) ? rows : []);
    last = await readJson<MachineTokens>(join(options.dataDir, LAST_FILE));
    if ([...cache].some(([path, entry]) => !isCursorStorePath(path) && entry.events === undefined)) {
      last = null;
    } else if (last) {
      last.slices = slicesFromScan({ files: [...cache].map(([path, entry]) => ({ ...entry, path })), daily: {} });
    }
  };

  const scanOnce = async (force: boolean): Promise<MachineTokens> => {
    await load();
    const result = await scan({
      cached: cache!,
      includeCursor: true,
      includeOpencode: true,
      force,
    });
    const scannedAt = new Date(now()).toISOString();
    const next = new Map(result.files.map((file) => [file.path, entryFrom(file)]));
    cache = next;
    await writeJson(join(options.dataDir, CACHE_FILE), [...next]);
    last = {
      computer,
      scannedAt,
      changedFiles: result.changedFiles,
      slices: slicesFromScan(result),
    };
    await writeJson(join(options.dataDir, LAST_FILE), last);
    return last;
  };

  const startScan = (force: boolean, retain?: () => { dispose(): unknown }) => {
    const lease = retain?.();
    running = scanOnce(force).finally(() => {
      running = null;
      lease?.dispose();
    });
    return running;
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
        now() - Date.parse(last.scannedAt) >= 0 &&
        now() - Date.parse(last.scannedAt) < MACHINE_TOKENS_FRESH_MS
      ) {
        return last;
      }
      let current = running ?? queuedForce;
      if (input.force && running) {
        if (!queuedForce) {
          queuedForce = running.catch(() => {}).then(() => {
            queuedForce = null;
            return startScan(true, input.retain);
          });
        }
        current = queuedForce;
      }
      current ??= startScan(input.force === true, input.retain);
      if (input.force) return current.catch((error) => {
        if (last) return last;
        throw error;
      });
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
