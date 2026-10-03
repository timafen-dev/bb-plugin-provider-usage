import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cursorSessionLocation, selectCursorFiles, tokenRoots, unplaceCursor,
  type DailyProviderBuckets, type FileScanResult, type TokenEvent,
} from "./token-scan";
import {
  addBucket, dayKey, emptyBucket, enumerateDays,
  type TokenBucket, type TokenMachineRow, type TokenSourceRow, type TokenWindowDays,
} from "./tokens";

export const MACHINE_TOKENS_FRESH_MS = 2 * 60_000;

export interface MachineTokenSlice {
  provider: string;
  location: string;
  sourceId?: string;
  fileCount: number;
  daily: Record<string, TokenBucket>;
  observedAt?: string;
  retained?: boolean;
  readError?: boolean;
  events?: TokenEvent[];
  keyedEvents?: Record<string, TokenEvent>;
  unknownWindow?: TokenBucket;
  birthMs?: number;
  mtimeMs?: number;
}

export interface MachineTokens {
  computer: string;
  scannedAt: string;
  changedFiles: number;
  slices: MachineTokenSlice[];
}

export interface MachineTokenSource {
  id: string;
  name: string;
  tokens: MachineTokens | null;
  error: string | null;
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

export function slicesFromScan(
  scan: { files: FileScanResult[]; daily: DailyProviderBuckets },
  home = homedir(), env = process.env,
): MachineTokenSlice[] {
  const roots = tokenRoots(home, env);
  return selectCursorFiles(scan.files).flatMap((file): MachineTokenSlice[] => {
    const provider = file.provider ?? (file.path.endsWith("opencode.db") ? "opencode" : file.path.endsWith("store.db") ? "cursor" : roots.find((root) => file.path.startsWith(`${root.root}/`))?.id);
    if (!provider) return [];
    const root = roots.find((row) => row.id === provider);
    if (provider === "cursor") {
      file = { ...file };
      unplaceCursor(file);
    }
    return [{
      provider,
      location: real(root?.root ?? (provider === "cursor" ? join(home, ".cursor") : file.path)),
      sourceId: real(provider === "cursor" ? cursorSessionLocation(file.path) : file.path),
      fileCount: 1,
      daily: file.daily,
      observedAt: file.observedAt,
      retained: file.retained,
      readError: file.readError,
      events: file.events,
      keyedEvents: file.keyedEvents,
      unknownWindow: file.unknownWindow,
      birthMs: file.birthMs,
      mtimeMs: file.mtimeMs,
    }];
  });
}

export function mergeMachineTokens(
  sources: MachineTokenSource[], days: TokenWindowDays, nowMs = Date.now(),
): {
  daily: DailyProviderBuckets; providers: string[]; fileCount: number;
  changedFiles: number; machines: TokenMachineRow[]; observations: TokenSourceRow[];
} {
  const daily: DailyProviderBuckets = {};
  const providers = new Set<string>();
  type Choice = { source: MachineTokenSource; slice: MachineTokenSlice; at: number };
  const groups = new Map<string, Choice[]>();
  const historical: Choice[] = [];
  for (const source of sources) {
    if (!source.tokens) continue;
    for (const slice of source.tokens.slices) {
      const parsed = Date.parse(slice.observedAt ?? "");
      const at = Number.isFinite(parsed) && parsed > 0 && parsed <= nowMs ? parsed : -Infinity;
      const choice = { source, slice, at };
      if (!slice.sourceId) {
        historical.push(choice);
        continue;
      }
      const key = `${source.tokens.computer}\0${slice.provider}\0${slice.location}`;
      const group = groups.get(key) ?? [];
      group.push(choice);
      groups.set(key, group);
    }
  }
  const selected: Choice[] = [];
  const newer = (a: Choice, b: Choice) => a.at > b.at || (a.at === b.at && (b.source.error || b.slice.retained) && !a.source.error && !a.slice.retained);
  for (const group of groups.values()) {
    const files = new Map<string, Choice>();
    for (const row of group) {
      const id = row.slice.sourceId!;
      const prior = files.get(id);
      if (!prior || newer(row, prior)) files.set(id, row);
    }
    selected.push(...files.values());
  }
  const keyed = new Map<string, { event: TokenEvent; choice: Choice }>();
  for (const choice of selected) {
    for (const [id, event] of Object.entries(choice.slice.keyedEvents ?? {})) {
      const key = `${choice.source.tokens!.computer}\0${choice.slice.location}\0${id}`;
      const prior = keyed.get(key);
      if (!prior || event.bucket.tokens > prior.event.bucket.tokens || (event.bucket.tokens === prior.event.bucket.tokens && event.atMs >= prior.event.atMs)) keyed.set(key, { event, choice });
    }
  }
  const observations: TokenSourceRow[] = [];
  const totals = new Map<MachineTokenSource, number>();
  const keys = new Set(enumerateDays(days, nowMs));
  let fileCount = 0;
  const add = (row: Record<string, TokenBucket>, atMs: number, bucket: TokenBucket) => addBucket(row[dayKey(atMs)] ??= emptyBucket(), bucket);
  for (const choice of [...selected, ...historical]) {
    const { source, slice } = choice;
    if (!slice.sourceId) {
      let rawTokens = slice.unknownWindow?.tokens ?? 0;
      for (const bucket of slice.events?.map((event) => event.bucket) ?? Object.values(slice.daily)) rawTokens += bucket.tokens;
      for (const event of Object.values(slice.keyedEvents ?? {})) rawTokens += event.bucket.tokens;
      providers.add(slice.provider);
      observations.push({
        machineId: source.id, machineName: source.name, provider: slice.provider,
        sourceId: slice.location, observedAt: Number.isFinite(choice.at) ? new Date(choice.at).toISOString() : null,
        status: "stale", tokens: 0, rawTokens, unknownWindow: 0,
        historicalAggregate: true, birthMs: null, mtimeMs: null,
        message: `Historical overlapping observation; reporting-window membership unknown; not included in totals.${source.error ? ` ${source.error}` : ""}`,
      });
      continue;
    }
    const incompatible = slice.readError === true && slice.events === undefined;
    const amounts: Record<string, TokenBucket> = slice.events || incompatible ? {} : structuredClone(slice.daily);
    for (const event of slice.events ?? []) add(amounts, event.atMs, event.bucket);
    for (const hit of keyed.values()) if (hit.choice === choice) add(amounts, hit.event.atMs, hit.event.bucket);
    let tokens = 0;
    let rawTokens = slice.unknownWindow?.tokens ?? 0;
    if (incompatible) for (const bucket of Object.values(slice.daily)) rawTokens += bucket.tokens;
    for (const [day, bucket] of Object.entries(amounts)) {
      rawTokens += bucket.tokens;
      if (keys.has(day)) tokens += bucket.tokens;
      const row = daily[day] ??= {};
      addBucket(row[slice.provider] ??= emptyBucket(), bucket);
    }
    totals.set(source, (totals.get(source) ?? 0) + tokens);
    providers.add(slice.provider);
    fileCount += slice.fileCount;
    const stale = source.error !== null || slice.retained === true || nowMs - choice.at >= MACHINE_TOKENS_FRESH_MS;
    observations.push({
      machineId: source.id, machineName: source.name, provider: slice.provider,
      sourceId: slice.sourceId ?? slice.location, observedAt: Number.isFinite(choice.at) ? new Date(choice.at).toISOString() : null,
      status: stale ? "stale" : "ok", tokens, rawTokens,
      unknownWindow: slice.unknownWindow?.tokens ?? 0,
      birthMs: slice.birthMs && slice.birthMs > 0 ? slice.birthMs : null, mtimeMs: slice.mtimeMs && slice.mtimeMs > 0 ? slice.mtimeMs : null,
      message: source.error ?? (incompatible ? "Source could not be read; last known raw amounts retained, reporting-day membership cannot be recovered." : slice.readError ? "Source could not be read; last known amounts retained." : slice.retained ? "Last known source amounts." : null),
    });
  }
  const machines = sources.map((source): TokenMachineRow => ({
    id: source.id, name: source.name,
    status: !source.tokens ? "error" : source.error || source.tokens.slices.some((slice) => {
      const at = Date.parse(slice.observedAt ?? "");
      return !slice.sourceId || slice.retained || !Number.isFinite(at) || at > nowMs || nowMs - at >= MACHINE_TOKENS_FRESH_MS;
    }) ? "stale" : "ok",
    tokens: totals.get(source) ?? 0,
    message: source.error,
  }));
  return { daily, providers: [...providers], fileCount, changedFiles: sources.reduce((sum, source) => sum + (source.tokens?.changedFiles ?? 0), 0), machines, observations };
}
