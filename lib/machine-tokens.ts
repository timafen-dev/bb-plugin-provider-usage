import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isCursorStorePath } from "./cursor-scan";
import { isOpencodeStorePath } from "./opencode-scan";
import {
  tokenRoots,
  type DailyProviderBuckets,
  type FileScanResult,
} from "./token-scan";
import {
  addBucket,
  emptyBucket,
  enumerateDays,
  type TokenBucket,
  type TokenMachineRow,
  type TokenWindowDays,
} from "./tokens";

export const MACHINE_TOKENS_FRESH_MS = 2 * 60_000;

/**
 * One provider's history on one machine, and where on disk it was read from.
 *
 * The location matters because several BB machines can run on one computer
 * under one user. They share whatever is not relocated per daemon — opencode
 * and Cursor always, Codex and Claude when no CODEX_HOME/CLAUDE_CONFIG_DIR is
 * set — and adding their answers up would count the same history twice.
 */
export interface MachineTokenSlice {
  provider: string;
  location: string;
  fileCount: number;
  daily: Record<string, TokenBucket>;
  observedAt?: string;
  retained?: boolean;
}

/** Everything one machine reports about its own transcripts. */
export interface MachineTokens {
  /** os.hostname() of the computer the files live on. */
  computer: string;
  scannedAt: string;
  changedFiles: number;
  slices: MachineTokenSlice[];
}

export interface MachineTokenSource {
  id: string;
  name: string;
  tokens: MachineTokens | null;
  /** Why this machine has no fresh answer; its last one may still be used. */
  error: string | null;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sliceObservation(files: FileScanResult[]): Pick<MachineTokenSlice, "observedAt" | "retained"> {
  if (!files.some((file) => file.observedAt !== undefined)) return {};
  return {
    observedAt: files.map((file) => file.observedAt ?? "1970-01-01T00:00:00.000Z").sort()[0],
    retained: files.some((file) => file.retained === true),
  };
}

/** Split one machine's scan into per-provider slices keyed by location. */
export function slicesFromScan(
  scan: { files: FileScanResult[]; daily: DailyProviderBuckets },
  home = homedir(),
  env = process.env,
): MachineTokenSlice[] {
  const roots = tokenRoots(home, env);
  const locationOf = (provider: string): string => {
    const root = roots.find((entry) => entry.id === provider);
    if (root) return real(root.root);
    if (provider === "cursor") return real(join(home, ".cursor"));
    return real(home);
  };
  const belongsTo = (provider: string, path: string): boolean => {
    if (provider === "cursor") return isCursorStorePath(path);
    const root = roots.find((entry) => entry.id === provider);
    return !!root && path.startsWith(root.root);
  };

  const byProvider = new Map<string, Record<string, TokenBucket>>();
  for (const [day, row] of Object.entries(scan.daily)) {
    for (const [provider, bucket] of Object.entries(row)) {
      if (provider === "opencode") continue;
      const daily = byProvider.get(provider) ?? {};
      const current = daily[day] ?? emptyBucket();
      addBucket(current, bucket);
      daily[day] = current;
      byProvider.set(provider, daily);
    }
  }

  const databases = new Map<string, MachineTokenSlice>();
  for (const file of scan.files) {
    if (!isOpencodeStorePath(file.path)) continue;
    const location = real(file.path);
    if (databases.has(location)) continue;
    databases.set(location, {
      provider: "opencode",
      location,
      fileCount: 1,
      daily: file.daily,
      ...sliceObservation([file]),
    });
  }
  return [
    ...[...byProvider.entries()].map(([provider, daily]) => ({
      provider,
      location: locationOf(provider),
      fileCount: scan.files.filter((file) => belongsTo(provider, file.path)).length,
      daily,
      ...sliceObservation(scan.files.filter((file) => belongsTo(provider, file.path))),
    })),
    ...databases.values(),
  ];
}

function windowTotal(
  daily: Record<string, TokenBucket>,
  days: TokenWindowDays,
): number {
  let total = 0;
  for (const day of enumerateDays(days)) total += daily[day]?.tokens ?? 0;
  return total;
}

/**
 * Add every machine's history together, counting each location once. The
 * newest observation owns each location; equally recent observations favour
 * a source without a reported error.
 */
export function mergeMachineTokens(
  sources: MachineTokenSource[],
  days: TokenWindowDays,
  nowMs = Date.now(),
): {
  daily: DailyProviderBuckets;
  providers: string[];
  fileCount: number;
  changedFiles: number;
  machines: TokenMachineRow[];
} {
  const daily: DailyProviderBuckets = {};
  const providers = new Set<string>();
  const selected = new Map<string, { source: MachineTokenSource; slice: MachineTokenSlice; at: number }>();
  const keyOf = (source: MachineTokenSource, slice: MachineTokenSlice) =>
    `${source.tokens!.computer}\0${slice.provider}\0${slice.location}`;
  for (const source of sources) {
    if (!source.tokens) continue;
    for (const slice of source.tokens.slices) {
      const parsedAt = Date.parse(slice.observedAt ?? source.tokens.scannedAt);
      const at = Number.isFinite(parsedAt) && parsedAt <= nowMs ? parsedAt : -Infinity;
      const key = keyOf(source, slice);
      const prior = selected.get(key);
      if (!prior || at > prior.at || (at === prior.at && (prior.source.error || prior.slice.retained) && !source.error && !slice.retained)) {
        selected.set(key, { source, slice, at });
      }
    }
  }
  const machines: TokenMachineRow[] = [];
  let fileCount = 0;
  let changedFiles = 0;

  for (const source of sources) {
    if (!source.tokens) {
      machines.push({
        id: source.id,
        name: source.name,
        status: "error",
        tokens: 0,
        message: source.error,
      });
      continue;
    }
    let tokens = 0;
    changedFiles += source.tokens.changedFiles;
    for (const slice of source.tokens.slices) {
      const key = keyOf(source, slice);
      const chosen = selected.get(key);
      if (chosen?.source !== source || chosen.slice !== slice) continue;
      selected.delete(key);
      providers.add(slice.provider);
      fileCount += slice.fileCount;
      tokens += windowTotal(slice.daily, days);
      for (const [day, bucket] of Object.entries(slice.daily)) {
        const row = daily[day] ?? {};
        const current = row[slice.provider] ?? emptyBucket();
        addBucket(current, bucket);
        row[slice.provider] = current;
        daily[day] = row;
      }
    }
    const sourceAge = nowMs - Date.parse(source.tokens.scannedAt);
    const stale = !Number.isFinite(sourceAge) || sourceAge < 0 || sourceAge >= MACHINE_TOKENS_FRESH_MS || source.tokens.slices.some((slice) => {
      const age = nowMs - Date.parse(slice.observedAt ?? source.tokens!.scannedAt);
      return slice.retained || !Number.isFinite(age) || age < 0 || age >= MACHINE_TOKENS_FRESH_MS;
    });
    machines.push({
      id: source.id,
      name: source.name,
      status: source.error || stale ? "stale" : "ok",
      tokens,
      message: source.error ?? (stale ? "The last token scan is not current." : null),
    });
  }

  return { daily, providers: [...providers], fileCount, changedFiles, machines };
}
