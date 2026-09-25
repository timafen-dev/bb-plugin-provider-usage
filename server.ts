import { hostname } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract";
import {
  mergeMachineTokens,
  slicesFromScan,
  type MachineTokenSource,
} from "./lib/machine-tokens";
import {
  groupAgainstLimits,
  parseAdminAccounts,
  parseDailyLimits,
  secondsUntilReset,
  startOfUtcDay,
  tokensByModel,
} from "./lib/free-tokens";
import {
  PROVIDER_KEYS,
  assembleDashboard,
  formatDashboardText,
  type DashboardSnapshot,
  type ProviderKey,
  type ProviderLimitSlice,
  type UsageHost,
} from "./lib/dashboard";
import {
  hiddenProvidersFor,
  isMachineHidden,
  parsePanelHidden,
  type PanelHidden,
} from "./lib/panel-hidden";
import {
  scanTokenFiles,
  seedDailyFromCache,
  type FileCacheEntry,
  type FileScanResult,
} from "./lib/token-scan";
import {
  mergeDaily,
  scanBbThreadUsage,
  type BbUsageEvent,
  type BbUsageTotal,
} from "./lib/bb-usage-scan";
import {
  TOKEN_WINDOWS,
  assembleTokenSnapshot,
  formatTokenText,
  type TokenBucket,
  type TokenSnapshot,
  type TokenWindowDays,
} from "./lib/tokens";
import {
  createThroughputRecorder,
  formatThroughputText,
  type ThroughputSnapshot,
} from "./lib/throughput";
import {
  createThroughputScanner,
  type ThroughputScanThread,
} from "./lib/throughput-scan";
import { createLocalThroughputScanner } from "./lib/local-throughput-scan";
import { createOpencodeLiveThroughputSource } from "./lib/opencode-scan";
import { createCursorLiveThroughputSource } from "./lib/cursor-scan";
import { readCodexUsageSupplement } from "./lib/codex-usage";
import {
  hasRateLimitedProvider,
  overlayLastGoodLimits,
  rememberGoodLimits,
  shouldReuseCachedLimits,
} from "./lib/limits-cache";
import { normalizeProviderLimits } from "./lib/provider-limits";

const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  remainingPercent: z.number(),
  resetsAt: z.string().nullable(),
  cost: z
    .object({
      usedUsdCents: z.number(),
      limitUsdCents: z.number(),
      remainingUsdCents: z.number(),
    })
    .nullable(),
});

const providerUsageSchema = z.object({
  key: z.enum(PROVIDER_KEYS),
  id: z.string(),
  displayName: z.string(),
  logoUrl: z.string().nullable(),
  status: z.enum([
    "ok",
    "stale",
    "unknown",
    "not_installed",
    "unauthenticated",
    "expired",
    "error",
  ]),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
  message: z.string().nullable(),
  windows: z.array(usageWindowSchema),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable(),
  spendControl: z
    .object({
      used: z.string(),
      limit: z.string(),
      remainingPercent: z.number(),
      resetsAt: z.string().nullable(),
      reached: z.boolean().nullable(),
    })
    .nullable(),
  resetCredits: z
    .object({
      availableCount: z.number().int(),
      nextExpiresAt: z.string().nullable(),
      title: z.string().nullable(),
      description: z.string().nullable(),
    })
    .nullable(),
});

const dashboardSchema = z.object({
  fetchedAt: z.string(),
  hostId: z.string().nullable(),
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["connected", "disconnected"]),
    }),
  ),
  providers: z.array(providerUsageSchema),
  totals: z.object({
    trackedProviders: z.number().int(),
    okProviders: z.number().int(),
    windowCount: z.number().int(),
    averageUsedPercent: z.number().nullable(),
    averageRemainingPercent: z.number().nullable(),
    cumulativeRemainingPercent: z.number().nullable(),
    tightest: z
      .object({
        providerId: z.string(),
        providerName: z.string(),
        windowLabel: z.string(),
        usedPercent: z.number(),
        remainingPercent: z.number(),
      })
      .nullable(),
    nextResetAt: z.string().nullable(),
    spend: z
      .object({
        usedUsdCents: z.number(),
        limitUsdCents: z.number(),
        remainingUsdCents: z.number(),
      })
      .nullable(),
  }),
});

const tokenBucketSchema = z.object({
  tokens: z.number(),
  input: z.number(),
  output: z.number(),
  cached: z.number(),
  reasoning: z.number(),
  turns: z.number(),
});

const tokenSnapshotSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  scannedAt: z.string(),
  fileCount: z.number().int(),
  changedFiles: z.number().int(),
  sources: z.array(z.string()),
  totals: tokenBucketSchema,
  providers: z.array(
    tokenBucketSchema.extend({
      id: z.string(),
      displayName: z.string(),
      percent: z.number(),
    }),
  ),
  series: z.array(
    z.object({
      day: z.string(),
      label: z.string(),
      total: z.number(),
      byProvider: z.record(z.string(), z.number()),
    }),
  ),
  machines: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.enum(["ok", "stale", "error"]),
        tokens: z.number(),
        message: z.string().nullable(),
      }),
    )
    .optional(),
});

const throughputSnapshotSchema = z.object({
  sampledAt: z.string(),
  nowMs: z.number(),
  windowMs: z.number(),
  binMs: z.number(),
  rateWindowMs: z.number(),
  tokensPerMinute: z.number(),
  peakTokensPerMinute: z.number(),
  peakAtMs: z.number().nullable(),
  windowTotals: tokenBucketSchema,
  activeThreads: z.number().int(),
  trackedThreads: z.number().int(),
  live: z.boolean(),
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      tokens: z.number(),
      tokensPerMinute: z.number(),
      sharePercent: z.number(),
      lastAtMs: z.number().nullable(),
    }),
  ),
  series: z.array(
    z.object({
      atMs: z.number(),
      total: z.number(),
      byProvider: z.record(z.string(), z.number()),
    }),
  ),
  threads: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      providerId: z.string(),
      providerName: z.string(),
      status: z.string(),
      tokens: z.number(),
      tokensPerMinute: z.number(),
      lastAtMs: z.number(),
    }),
  ),
});

export const rpcContract = defineRpcContract({
  getDashboard: {
    input: z
      .object({
        hostId: z.string().nullable(),
        force: z.boolean().optional(),
      })
      .strict(),
    output: dashboardSchema,
  },
  getTokens: {
    input: z
      .object({
        days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
        force: z.boolean().optional(),
      })
      .strict(),
    output: tokenSnapshotSchema,
  },
  getThroughput: {
    input: z.null(),
    output: throughputSnapshotSchema,
  },
});

export const freeTokensContract = defineRpcContract({
  freeTokens: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: z
      .object({
        configured: z.boolean(),
        secondsUntilReset: z.number(),
        accounts: z.array(
          z
            .object({
              label: z.string(),
              error: z.string().nullable(),
              groups: z.array(
                z
                  .object({
                    label: z.string(),
                    used: z.number(),
                    limit: z.number(),
                    remainingPercent: z.number(),
                    models: z.array(
                      z.object({ model: z.string(), tokens: z.number() }).strict(),
                    ),
                  })
                  .strict(),
              ),
              unlimited: z.array(
                z.object({ model: z.string(), tokens: z.number() }).strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict(),
  },
});

type LastGoodLimits = Partial<Record<ProviderKey, ProviderLimitSlice>>;

type LastFetch = {
  at: number;
  hostId: string | null;
  limits: Record<ProviderKey, ProviderLimitSlice>;
  rateLimitedAt: number | null;
};

type HostLimitState = {
  lastGood: LastGoodLimits;
  lastFetch: LastFetch | null;
};

function createLimitStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const read = db.prepare("SELECT value FROM limits_cache WHERE key = ?");
  const write = db.prepare(
    `INSERT INTO limits_cache (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const readJson = <T>(key: string): T | null => {
    const row = read.get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  };

  /**
   * One entry per machine. A single shared slot was enough while the page
   * showed one machine at a time; asking for several at once turned it into a
   * hazard, because an in-flight request for one machine would be handed to
   * another and report its numbers under the wrong name.
   */
  const fetchedByHost = new Map<string, LastFetch>();
  const inflightByHost = new Map<
    string,
    Promise<Record<ProviderKey, ProviderLimitSlice>>
  >();
  const hostKey = (hostId: string | null) => hostId ?? "";
  const states = new Map<string, HostLimitState>();
  const stateFor = (hostId: string | null): HostLimitState => {
    const key = hostKey(hostId);
    const existing = states.get(key);
    if (existing) return existing;
    const restored = readJson<HostLimitState>(`host-v2:${key}`) ?? {
      lastGood: {},
      lastFetch: null,
    };
    states.set(key, restored);
    if (restored.lastFetch) fetchedByHost.set(key, restored.lastFetch);
    return restored;
  };

  const persist = (hostId: string | null, state: HostLimitState) => {
    write.run(`host-v2:${hostKey(hostId)}`, JSON.stringify(state));
  };

  const claudeHost = bb.hosts.experimental_client({ contract: hostContract });

  /**
   * BB's own probe reads os.homedir()/.claude and ignores CLAUDE_CONFIG_DIR,
   * even though the code beside it honours the variable. On a computer running
   * two machines with two Claude logins every machine reports whichever account
   * sits in the home directory, so the same numbers appear twice and the second
   * account is invisible. Ask the machine itself instead; its worker inherits
   * the daemon environment and therefore resolves its own login.
   *
   * A failed machine-specific probe must stay unknown. Falling back to BB's
   * home-directory probe can attach another login's identity and quota to this
   * machine, which is worse than an honest unknown state.
   */
  const claudeForHost = async (
    hostId: string | null,
    fallback: ProviderLimitSlice,
  ): Promise<ProviderLimitSlice> => {
    if (hostId === null) return fallback;
    try {
      const own = await claudeHost.call("claudeUsage", null, { hostId });
      return {
        status: own.status,
        accountEmail: own.accountEmail,
        planLabel: own.planLabel,
        ...(own.message !== null ? { message: own.message } : {}),
        windows: own.windows,
      };
    } catch (error) {
      bb.log.warn(
        `claude usage source unavailable for ${hostId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        status: "unknown",
        accountEmail: null,
        planLabel: null,
        message: "Machine-specific Claude usage source is unavailable.",
        windows: [],
      };
    }
  };

  const readLive = async (hostId: string | null) => {
    const state = stateFor(hostId);
    const raw = await bb.sdk.system.usageLimits(hostId ? { hostId } : {});
    const fresh = normalizeProviderLimits(raw);
    fresh.claudeCode = await claudeForHost(hostId, fresh.claudeCode);
    const limits = overlayLastGoodLimits(fresh, state.lastGood);
    state.lastGood = rememberGoodLimits(limits, state.lastGood);
    state.lastFetch = {
      at: Date.now(),
      hostId,
      limits,
      rateLimitedAt: hasRateLimitedProvider(fresh) ? Date.now() : null,
    };
    fetchedByHost.set(hostKey(hostId), state.lastFetch);
    persist(hostId, state);
    if (hasRateLimitedProvider(fresh)) {
      bb.log.warn(
        "usage limits: a provider was rate-limited; serving last good windows",
      );
    }
    return limits;
  };

  const get = async (hostId: string | null, force = false) => {
    const key = hostKey(hostId);
    stateFor(hostId);
    const cached = fetchedByHost.get(key);
    if (
      cached &&
      shouldReuseCachedLimits({
        nowMs: Date.now(),
        fetchedAtMs: cached.at,
        rateLimitedAtMs: cached.rateLimitedAt,
        force,
      })
    ) {
      return cached.limits;
    }
    const running = inflightByHost.get(key);
    if (running && !force) return running;
    const run = readLive(hostId);
    inflightByHost.set(key, run);
    try {
      return await run;
    } finally {
      if (inflightByHost.get(key) === run) inflightByHost.delete(key);
    }
  };

  return { get };
}

async function loadDashboard(
  bb: BbPluginApi,
  hostId: string | null,
  limitsStore: { get: (hostId: string | null, force?: boolean) => Promise<Record<ProviderKey, ProviderLimitSlice>> },
  force = false,
  hidden: PanelHidden = { machines: new Set(), providers: new Map() },
): Promise<DashboardSnapshot> {
  const everyHost = (await bb.sdk.hosts.list()).map(
    (host): UsageHost => ({
      id: host.id,
      name: host.name,
      status: host.status,
    }),
  );
  // Hidden machines go before anything else: the panel walks this list to
  // decide which sections to draw, so a machine left in it is a section.
  const hosts = everyHost.filter((host) => !isMachineHidden(hidden, host));
  const resolvedHostId =
    hostId && hosts.some((host) => host.id === hostId) ? hostId : null;
  const [slices, catalog] = await Promise.all([
    limitsStore.get(resolvedHostId, force),
    bb.sdk.providers.list(resolvedHostId ? { hostId: resolvedHostId } : {}),
  ]);

  const codexSupplement =
    resolvedHostId === null && slices.codex.status === "ok"
      ? await readCodexUsageSupplement()
      : null;

  const snapshot = assembleDashboard({
    limits: slices,
    supplements: codexSupplement ? { codex: codexSupplement } : undefined,
    hosts,
    catalog,
    hostId: resolvedHostId,
  });
  const omitted = hiddenProvidersFor(
    hidden,
    hosts.find((host) => host.id === resolvedHostId) ?? null,
  );
  if (omitted.size === 0) return snapshot;
  return {
    ...snapshot,
    providers: snapshot.providers.filter(
      (provider) =>
        !omitted.has(provider.id.toLowerCase()) &&
        !omitted.has(provider.key.toLowerCase()),
    ),
  };
}

type AccountReadback = {
  fetchedAt: string;
  accounts: Array<{
    key: string;
    machineId: string;
    machineName: string;
    providerId: "codex" | "claude-code";
    source: "system.usageLimits" | "host.claudeUsage";
    status: ProviderLimitSlice["status"];
    accountEmail: string | null;
    planLabel: string | null;
    message: string | null;
    windows: DashboardSnapshot["providers"][number]["windows"];
    credits: DashboardSnapshot["providers"][number]["credits"];
    resetCredits: DashboardSnapshot["providers"][number]["resetCredits"];
    enrichmentScope: "primary-only" | null;
    checkedAt: string;
  }>;
};

async function loadAccountReadback(
  bb: BbPluginApi,
  hostId: string | null,
  limitsStore: {
    get: (
      hostId: string | null,
      force?: boolean,
    ) => Promise<Record<ProviderKey, ProviderLimitSlice>>;
  },
  force: boolean,
  hidden: PanelHidden,
): Promise<AccountReadback> {
  const hosts = (await bb.sdk.hosts.list())
    .map(
      (host): UsageHost => ({
        id: host.id,
        name: host.name,
        status: host.status,
      }),
    )
    .filter((host) => !isMachineHidden(hidden, host))
    .filter((host) => hostId === null || host.id === hostId);

  const accounts = await Promise.all(
    hosts.map(async (host) => {
      const unknownAccounts = (message: string) =>
        (["codex", "claude-code"] as const).map((providerId) => ({
          key: `${host.id}:${providerId}`,
          machineId: host.id,
          machineName: host.name,
          providerId,
          source:
            providerId === "codex"
              ? ("system.usageLimits" as const)
              : ("host.claudeUsage" as const),
          status: "unknown" as const,
          accountEmail: null,
          planLabel: null,
          message,
          windows: [],
          credits: null,
          resetCredits: null,
          enrichmentScope:
            providerId === "codex" ? ("primary-only" as const) : null,
          checkedAt: new Date().toISOString(),
        }));

      if (host.status === "disconnected") {
        return unknownAccounts(
          "Machine is disconnected; no fresh account status was read.",
        );
      }

      let snapshot: DashboardSnapshot;
      try {
        snapshot = await loadDashboard(
          bb,
          host.id,
          limitsStore,
          force,
          hidden,
        );
      } catch (error) {
        bb.log.warn(
          `usage source unavailable for ${host.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return unknownAccounts("Machine usage source is unavailable.");
      }
      return snapshot.providers
        .filter(
          (provider) =>
            provider.key === "codex" || provider.key === "claudeCode",
        )
        .map((provider) => ({
          key: `${host.id}:${provider.id}`,
          machineId: host.id,
          machineName: host.name,
          providerId: provider.id as "codex" | "claude-code",
          source:
            provider.key === "codex"
              ? ("system.usageLimits" as const)
              : ("host.claudeUsage" as const),
          status: provider.status,
          accountEmail: provider.accountEmail,
          planLabel: provider.planLabel,
          message: provider.message,
          windows: provider.windows,
          credits: provider.credits,
          resetCredits: provider.resetCredits,
          enrichmentScope:
            provider.key === "codex" ? ("primary-only" as const) : null,
          checkedAt: snapshot.fetchedAt,
        }));
    }),
  );

  return { fetchedAt: new Date().toISOString(), accounts: accounts.flat() };
}

function formatAccountReadbackText(readback: AccountReadback): string {
  const lines = [`Usage accounts · ${readback.fetchedAt}`];
  for (const account of readback.accounts) {
    const identity = account.accountEmail ?? "identity unknown";
    const tightest = account.windows.reduce<number | null>(
      (value, window) =>
        value === null
          ? window.remainingPercent
          : Math.min(value, window.remainingPercent),
      null,
    );
    lines.push(
      `${account.machineName} · ${account.providerId} · ${identity} · ${account.status}` +
        (tightest === null ? "" : ` · ${Math.round(tightest)}% left`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function isTokenWindow(value: number): value is TokenWindowDays {
  return (TOKEN_WINDOWS as readonly number[]).includes(value);
}

function parseCliArgs(argv: string[]): {
  json: boolean;
  hostId: string | null;
  help: boolean;
  tokens: boolean;
  live: boolean;
  accounts: boolean;
  days: TokenWindowDays;
  force: boolean;
} {
  let json = false;
  let help = false;
  let tokens = false;
  let live = false;
  let accounts = false;
  let force = false;
  let days: TokenWindowDays = 30;
  let hostId: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--force") force = true;
    else if (arg === "tokens") tokens = true;
    else if (arg === "live") live = true;
    else if (arg === "accounts") accounts = true;
    else if (arg === "--days") {
      const next = Number(argv[i + 1]);
      if (isTokenWindow(next)) days = next;
      i += 1;
    } else if (arg === "--machine" || arg === "--host") {
      hostId = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return { json, hostId, help, tokens, live, accounts, days, force };
}

type TokenCacheRow = {
  path: string;
  mtime_ms: number;
  size: number;
  daily_json: string;
};

type PersistedTokenFile = {
  version: 2;
  daily: Record<string, TokenBucket>;
  keyedEvents?: FileScanResult["keyedEvents"];
  blobCount?: number;
  maxRowid?: number;
};

function isPersistedTokenFile(value: unknown): value is PersistedTokenFile {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.version === 2 && !!row.daily && typeof row.daily === "object";
}

/**
 * A machine answers within its own 20s budget once it has scanned before; the
 * first scan of a busy machine runs on after this and is picked up next time.
 */
const REMOTE_TIMEOUT_MS = 45_000;

function createTokenStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS token_file_cache (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      daily_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS token_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `DELETE FROM token_file_cache`,
    // Token accounting v2: Total now follows each provider's canonical total
    // (cache included, reasoning not double-counted). Reparse persisted files.
    `DELETE FROM token_file_cache`,
    // Identity-aware transcript parsing stores Claude message ids so the same
    // response is deduplicated across fragments and copied subagent files.
    `DELETE FROM token_file_cache`,
    `CREATE TABLE IF NOT EXISTS limits_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ]);

  const loadCache = new Map<string, FileCacheEntry>();
  for (const row of db
    .prepare(
      "SELECT path, mtime_ms, size, daily_json FROM token_file_cache",
    )
    .all() as TokenCacheRow[]) {
    try {
      const parsed = JSON.parse(row.daily_json) as
        | PersistedTokenFile
        | Record<string, TokenBucket>;
      const persisted: PersistedTokenFile = isPersistedTokenFile(parsed)
        ? parsed
        : { version: 2, daily: parsed as Record<string, TokenBucket> };
      loadCache.set(row.path, {
        mtimeMs: row.mtime_ms,
        size: row.size,
        daily: persisted.daily,
        ...(persisted.keyedEvents
          ? { keyedEvents: persisted.keyedEvents }
          : {}),
        ...(persisted.blobCount != null
          ? { blobCount: persisted.blobCount, maxRowid: persisted.maxRowid }
          : {}),
      });
    } catch {
      continue;
    }
  }

  const upsert = db.prepare(
    `INSERT INTO token_file_cache (path, mtime_ms, size, daily_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       size = excluded.size,
       daily_json = excluded.daily_json`,
  );
  const writeMeta = db.prepare(
    `INSERT INTO token_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const readMeta = db.prepare("SELECT value FROM token_meta WHERE key = ?");

  let inflight: Promise<TokenSnapshot> | null = null;
  let lastSnapshot: TokenSnapshot | null = null;

  const publish = () => {
    bb.realtime.publish("tokens", { at: Date.now() });
  };

  const persistFiles = (files: FileScanResult[]) => {
    const tx = db.transaction((rows: FileScanResult[]) => {
      for (const file of rows) {
        upsert.run(
          file.path,
          file.mtimeMs,
          file.size,
          JSON.stringify({
            version: 2,
            daily: file.daily,
            ...(file.keyedEvents ? { keyedEvents: file.keyedEvents } : {}),
            ...(file.blobCount != null
              ? { blobCount: file.blobCount, maxRowid: file.maxRowid }
              : {}),
          } satisfies PersistedTokenFile),
        );
        loadCache.set(file.path, {
          mtimeMs: file.mtimeMs,
          size: file.size,
          daily: file.daily,
          ...(file.keyedEvents ? { keyedEvents: file.keyedEvents } : {}),
          ...(file.blobCount != null
            ? { blobCount: file.blobCount, maxRowid: file.maxRowid }
            : {}),
        });
      }
    });
    tx(files);
  };

  /**
   * The agents run on the machines, not beside the server, so the server's own
   * disk usually holds none of their transcripts. Each machine reads its own
   * and sends back daily totals; the last answer is kept so a machine that is
   * offline or slow still counts with what it last reported.
   */
  const tokenHosts = bb.hosts.experimental_client({ contract: hostContract });
  let remote: MachineTokenSource[] =
    (() => {
      const raw = (readMeta.get("remote-machines") as { value?: string } | undefined)
        ?.value;
      try {
        return raw ? (JSON.parse(raw) as MachineTokenSource[]) : [];
      } catch {
        return [];
      }
    })();
  let bbUsageDaily: Record<string, Record<string, TokenBucket>> = {};
  let bbUsageProviders: string[] = [];

  const readRemote = async (force: boolean) => {
    const previous = new Map(remote.map((source) => [source.id, source]));
    const hosts = await bb.sdk.hosts.list();
    remote = await Promise.all(
      hosts.map(async (host): Promise<MachineTokenSource> => {
        const kept = previous.get(host.id)?.tokens ?? null;
        if (host.status !== "connected") {
          return { id: host.id, name: host.name, tokens: kept, error: "Machine is offline." };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const tokens = await Promise.race([
            tokenHosts.call("tokenHistory", { force }, { hostId: host.id }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Machine did not answer in time.")),
                REMOTE_TIMEOUT_MS,
              );
            }),
          ]);
          return { id: host.id, name: host.name, tokens, error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          bb.log.warn(`token history from ${host.name}: ${message}`);
          return { id: host.id, name: host.name, tokens: kept, error: message };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    writeMeta.run("remote-machines", JSON.stringify(remote));
  };

  const combine = (
    days: TokenWindowDays,
    local: {
      files: FileScanResult[];
      changedFiles: number;
      daily: Record<string, Record<string, TokenBucket>>;
    },
  ): TokenSnapshot => {
    // Machines first: a location both a machine and the server can see is
    // credited to the machine.
    const merged = mergeMachineTokens(
      [
        ...remote,
        {
          id: "server",
          name: "BB server",
          error: null,
          tokens: {
            computer: hostname(),
            scannedAt: new Date().toISOString(),
            changedFiles: local.changedFiles,
            slices: slicesFromScan(local),
          },
        },
      ],
      days,
    );
    mergeDaily(merged.daily, bbUsageDaily);
    const snapshot = assembleTokenSnapshot({
      days,
      fileCount: merged.fileCount,
      changedFiles: merged.changedFiles,
      sources: [...new Set([...merged.providers, ...bbUsageProviders])],
      daily: merged.daily,
    });
    // A machine that answered with nothing in the window is only noise.
    return {
      ...snapshot,
      machines: merged.machines.filter(
        (row) => row.status !== "ok" || row.tokens > 0,
      ),
    };
  };

  const snapshotFrom = (
    days: TokenWindowDays,
    scanned: {
      files: FileScanResult[];
      changedFiles: number;
      daily: Record<string, Record<string, TokenBucket>>;
    },
  ) => {
    const snapshot = combine(days, scanned);
    lastSnapshot = snapshot;
    writeMeta.run("last-scan", snapshot.scannedAt);
    return snapshot;
  };

  const hasCursorCache = () =>
    [...loadCache.keys()].some(
      (path) => path.includes("acp-sessions") || path.endsWith("store.db"),
    );
  const hasOpencodeCache = () =>
    [...loadCache.keys()].some((path) => path.endsWith("opencode.db"));

  const paintCachedStores = (
    scanned: {
      sources: string[];
      daily: Record<string, Record<string, TokenBucket>>;
    },
  ) => {
    seedDailyFromCache(scanned.daily, scanned.sources, loadCache, "cursor");
    seedDailyFromCache(scanned.daily, scanned.sources, loadCache, "opencode");
  };

  /**
   * Every provider bb can drive, without a scanner per vendor: bb's own
   * `thread/tokenUsage/updated` is part of the provider-bridge contract, so an
   * agent the plugin has never heard of still lands in the chart as soon as it
   * reports usage. Providers with a dedicated transcript scanner are skipped
   * inside scanBbThreadUsage so they are not counted twice.
   */
  const scanBbThreads = async (nowMs: number) =>
    scanBbThreadUsage({
      nowMs,
      onError: (error) =>
        bb.log.warn(
          `bb thread usage scan: ${error instanceof Error ? error.message : String(error)}`,
        ),
      listThreads: async () => {
        const rows = await bb.sdk.threads.list({ includeHidden: true });
        return rows.map((row) => ({
          id: row.id,
          providerId: row.providerId,
          updatedAt: row.updatedAt,
        }));
      },
      listEvents: async (threadId) => {
        const rows = await bb.sdk.threads.events.list({
          threadId,
          types: ["thread/tokenUsage/updated"],
        });
        const events: BbUsageEvent[] = [];
        for (const row of rows) {
          if (row.type !== "thread/tokenUsage/updated") continue;
          const total = row.data.tokenUsage?.total as BbUsageTotal | undefined;
          if (!total) continue;
          events.push({ seq: row.seq, createdAt: row.createdAt, total });
        }
        return events;
      },
    });

  const sync = async (days: TokenWindowDays, force = false) => {
    if (inflight) return inflight;
    inflight = (async () => {
      const nowMs = Date.now();
      const cached = force ? new Map() : loadCache;
      const phase1Started = Date.now();
      // jsonl (Codex/Claude) is the cheap first paint. Seed cursor/opencode
      // from the last persisted totals so those series never vanish while
      // the heavier stores refresh.
      const jsonl = await scanTokenFiles({
        cached,
        includeCursor: false,
        includeOpencode: false,
      });
      persistFiles(jsonl.files);
      if (!force) paintCachedStores(jsonl);
      snapshotFrom(days, jsonl);
      publish();
      bb.log.info(
        `token scan phase1 ${Date.now() - phase1Started}ms sources=[${jsonl.sources.join(", ")}]`,
      );

      const phase2Started = Date.now();
      const [full] = await Promise.all([
        scanTokenFiles({
          cached: loadCache,
          includeCursor: true,
          includeOpencode: true,
        }),
        readRemote(force).catch((error) =>
          bb.log.warn(
            `token history from machines: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      ]);
      persistFiles(full.files);
      const bbUsage = await scanBbThreads(nowMs);
      bbUsageDaily = bbUsage.daily;
      bbUsageProviders = bbUsage.providers;
      bb.log.info(
        `token scan phase2 ${Date.now() - phase2Started}ms ` +
          `changed=${full.changedFiles} ` +
          `bbThreads=${bbUsage.threadsScanned} ` +
          `providers [${bbUsage.providers.join(", ") || "none"}] ` +
          `machines [${remote
            .map((source) => `${source.name}${source.error ? " (stale)" : ""}`)
            .join(", ")}]`,
      );
      const snapshot = snapshotFrom(days, full);
      publish();
      return snapshot;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const get = async (days: TokenWindowDays, force = false) => {
    if (force) return sync(days, true);
    if (lastSnapshot) {
      if (lastSnapshot.days !== days) {
        const scanned = await scanTokenFiles({
          cached: loadCache,
          includeCursor: hasCursorCache(),
          includeOpencode: hasOpencodeCache(),
        });
        paintCachedStores(scanned);
        return combine(days, scanned);
      }
      if (!inflight) {
        const lastScan = (
          readMeta.get("last-scan") as { value?: string } | undefined
        )?.value;
        const stale =
          !lastScan || Date.now() - Date.parse(lastScan) >= 120_000;
        if (stale) void sync(days);
      }
      return lastSnapshot;
    }
    const jsonl = await scanTokenFiles({
      cached: loadCache,
      includeCursor: false,
      includeOpencode: false,
    });
    persistFiles(jsonl.files);
    paintCachedStores(jsonl);
    const snapshot = snapshotFrom(days, jsonl);
    void sync(days);
    return snapshot;
  };

  return { get, sync };
}

/** Poll cadence while at least one thread is working, and while none are. */
const THROUGHPUT_BUSY_MS = 2_000;
const THROUGHPUT_QUIET_MS = 10_000;

function createThroughputStore(bb: BbPluginApi) {
  const recorder = createThroughputRecorder();
  let tracked = 0;
  let working = 0;
  let sharedThreads: Promise<ThroughputScanThread[]> | null = null;
  let refreshInflight: Promise<ThroughputSnapshot> | null = null;

  const readThreads = async (): Promise<ThroughputScanThread[]> => {
    const rows = await bb.sdk.threads.list({ includeHidden: true });
    return rows
      .filter((row) => !row.archivedAt && !row.deletedAt)
      .map(
        (row): ThroughputScanThread => ({
          id: row.id,
          providerId: row.providerId,
          title: row.title ?? row.titleFallback ?? null,
          status: row.status,
          updatedAt: row.updatedAt,
          createdAt: row.createdAt,
          archivedAt: row.archivedAt ?? null,
          deletedAt: row.deletedAt ?? null,
        }),
      );
  };
  const listThreads = () => sharedThreads ?? readThreads();

  const scanner = createThroughputScanner(recorder, {
    onError: (error) =>
      bb.log.warn(
        `throughput scan: ${error instanceof Error ? error.message : String(error)}`,
      ),
    listThreads,
    listEvents: async ({ threadId, afterSeq, order, limit }) => {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated"],
        order,
        limit: String(limit),
        ...(afterSeq === undefined ? {} : { afterSeq: String(afterSeq) }),
      });
      const events: BbUsageEvent[] = [];
      for (const row of rows) {
        if (row.type !== "thread/tokenUsage/updated") continue;
        const usage = row.data.tokenUsage;
        const total = usage?.total as BbUsageTotal | undefined;
        if (!total) continue;
        const last = usage?.last as BbUsageTotal | undefined;
        events.push({
          seq: row.seq,
          createdAt: row.createdAt,
          total,
          ...(last ? { last } : {}),
        });
      }
      return events;
    },
  });

  const localScanner = createLocalThroughputScanner(recorder, {
    listThreads,
    sources: [
      createOpencodeLiveThroughputSource(),
      createCursorLiveThroughputSource(),
    ],
    onError: (error) =>
      bb.log.warn(
        `local throughput scan: ${error instanceof Error ? error.message : String(error)}`,
      ),
    listThreadSessionInfo: async (threadId) => {
      const [identityRows, usageRows] = await Promise.all([
        bb.sdk.threads.events.list({
          threadId,
          types: ["thread/identity"],
          order: "desc",
          limit: "100",
        }),
        bb.sdk.threads.events.list({
          threadId,
          types: ["thread/tokenUsage/updated"],
          order: "desc",
          limit: "1",
        }),
      ]);
      const sessionIds = new Set<string>();
      for (const row of identityRows) {
        if (row.type === "thread/identity" && row.data.providerThreadId) {
          sessionIds.add(row.data.providerThreadId);
        }
      }
      return {
        sessionIds: [...sessionIds],
        hasNativeUsage: usageRows.some(
          (row) => row.type === "thread/tokenUsage/updated",
        ),
      };
    },
  });

  const snapshot = (nowMs = Date.now()): ThroughputSnapshot =>
    recorder.snapshot(nowMs, tracked);

  const refresh = async (): Promise<ThroughputSnapshot> => {
    if (refreshInflight) return refreshInflight;
    const run = (async () => {
      const nowMs = Date.now();
      sharedThreads = readThreads();
      try {
        const result = await scanner.refresh(nowMs);
        await localScanner.refresh(nowMs);
        tracked = result.tracked;
        working = result.working;
        return snapshot(nowMs);
      } finally {
        sharedThreads = null;
      }
    })();
    refreshInflight = run;
    try {
      return await run;
    } finally {
      if (refreshInflight === run) refreshInflight = null;
    }
  };

  return {
    snapshot,
    refresh,
    markDirty: (threadId: string) => {
      scanner.markDirty(threadId);
      localScanner.markDirty(threadId);
    },
    /** Poll fast while work is in flight, slowly when the machine is quiet. */
    intervalMs: () => (working > 0 ? THROUGHPUT_BUSY_MS : THROUGHPUT_QUIET_MS),
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
  const tokens = createTokenStore(bb);
  const limits = createLimitStore(bb);
  const throughput = createThroughputStore(bb);

  const panelSettings = bb.settings.define({
    panelHidden: {
      type: "string",
      label: "Rows the panel leaves out",
      description:
        "One rule per line. `Machine` hides that machine entirely; `Machine: claude-code, cursor` hides those providers on it; `*: muse` hides a provider everywhere. Name a machine by its display name or its id — the id survives a rename. Provider ids: codex, claude-code, cursor, muse. A row that will never have a subscription to report is noise, and it pushes the rows that matter off the screen.",
      default: "",
    },
  });
  const readHidden = async (): Promise<PanelHidden> =>
    parsePanelHidden((await panelSettings.get()).panelHidden);

  const freeTokenSettings = bb.settings.define({
    openaiAdminKeys: {
      type: "string",
      secret: true,
      label: "OpenAI admin keys",
      description:
        "One organization per line: `label = sk-admin-…`. An admin key is required; a project key is refused by the usage endpoint. Leave blank to hide the section.",
      default: "",
    },
    openaiFreeDailyLimits: {
      type: "string",
      label: "Free daily token allowances",
      description:
        "One allowance per line: `Name: model, model, … = amount`. Every model on a line shares that one allowance, which is how OpenAI grants it — a group is not an allowance each. A trailing `*` matches a prefix, so dated model ids are covered. OpenAI does not report the allowance anywhere in its API; copy the numbers from Settings → Limits in your dashboard.",
      default: [
        // One pool per group, not one per model: OpenAI grants the allowance
        // across the whole group. Tier 1–2 gets 250k and 2.5M; higher tiers
        // get 1M and 10M. Copy the numbers from Settings → Limits.
        "Крупные модели: gpt-5*, gpt-4.1*, gpt-4o*, o1*, o3* = 250k",
        "Мелкие модели: gpt-5-mini*, gpt-5-nano*, gpt-4.1-mini*, gpt-4.1-nano*, gpt-4o-mini*, o3-mini*, o4-mini*, codex-mini* = 2.5M",
      ].join("\n"),
    },
  });

  /**
   * Consumption comes from OpenAI; the allowance does not exist in any of its
   * APIs, so it is configured. Both are needed to answer the only question
   * worth asking — how much of today's free tier is left.
   */
  const readFreeTokens = async () => {
    const { openaiAdminKeys, openaiFreeDailyLimits } =
      await freeTokenSettings.get();
    const accounts = parseAdminAccounts(openaiAdminKeys);
    const limits = parseDailyLimits(openaiFreeDailyLimits);
    const now = new Date();
    if (accounts.length === 0) {
      return { configured: false, secondsUntilReset: secondsUntilReset(now), accounts: [] };
    }
    const rows = await Promise.all(
      accounts.map(async (account) => {
        try {
          const url = new URL("https://api.openai.com/v1/organization/usage/completions");
          url.searchParams.set("start_time", String(startOfUtcDay(now)));
          url.searchParams.set("bucket_width", "1d");
          url.searchParams.append("group_by[]", "model");
          url.searchParams.set("limit", "1");
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${account.key}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            // Never echo the body: it can name projects and keys.
            bb.log.warn(`free tokens: ${account.label} answered HTTP ${response.status}`);
            return {
              label: account.label,
              error:
                response.status === 401
                  ? "Key rejected. An organization admin key is required."
                  : `OpenAI answered HTTP ${response.status}.`,
              groups: [],
              unlimited: [],
            };
          }
          const { groups, unlimited } = groupAgainstLimits(
            tokensByModel(await response.json()),
            limits,
          );
          return { label: account.label, error: null, groups, unlimited };
        } catch (cause) {
          return {
            label: account.label,
            error: cause instanceof Error ? cause.message : String(cause),
            groups: [],
            unlimited: [],
          };
        }
      }),
    );
    return { configured: true, secondsUntilReset: secondsUntilReset(now), accounts: rows };
  };

  bb.rpc.register(freeTokensContract, {
    async freeTokens() {
      return readFreeTokens();
    },
  });

  bb.rpc.register(rpcContract, {
    async getDashboard({ hostId, force }) {
      return loadDashboard(bb, hostId, limits, force === true, await readHidden());
    },
    async getTokens({ days, force }) {
      return tokens.get(days, force === true);
    },
    async getThroughput() {
      return throughput.snapshot();
    },
  });

  bb.background.service("token-scan", {
    async start(signal) {
      try {
        await tokens.sync(30);
        bb.realtime.publish("tokens", { at: Date.now() });
      } catch (error) {
        bb.log.warn(
          `initial token scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15 * 60_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (signal.aborted) break;
        try {
          await tokens.sync(30);
          bb.realtime.publish("tokens", { at: Date.now() });
        } catch (error) {
          bb.log.warn(
            `token scan failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  });

  bb.background.service("throughput-scan", {
    async start(signal) {
      // A thread row changes the moment its turn moves, which is the earliest
      // signal available that new usage events may exist — well before the
      // next poll would have come round.
      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = bb.sdk.subscribe({
          event: "thread:changed",
          callback: (event) => {
            if (event.id) throughput.markDirty(event.id);
          },
        });
      } catch (error) {
        bb.log.warn(
          `throughput thread subscription unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      signal.addEventListener("abort", () => unsubscribe?.(), { once: true });

      let previous = "";
      while (!signal.aborted) {
        try {
          const snapshot = await throughput.refresh();
          // Publish only on change: an idle machine should not wake every
          // connected client every two seconds.
          const signature = `${snapshot.windowTotals.tokens}:${snapshot.windowTotals.turns}:${snapshot.activeThreads}`;
          if (signature !== previous) {
            previous = signature;
            bb.realtime.publish("throughput", { at: snapshot.nowMs });
          }
        } catch (error) {
          bb.log.warn(
            `throughput refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, throughput.intervalMs());
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      unsubscribe?.();
    },
  });

  bb.cli.register({
    name: "usage",
    summary: "Show provider subscription usage, remaining limits, and token totals",
    commands: [
      {
        name: "show",
        summary: "Print remaining usage, plans, and reset windows",
        usage: "bb usage [show] [--machine <id-or-name>] [--json]",
      },
      {
        name: "tokens",
        summary: "Print global token usage across providers",
        usage: "bb usage tokens [--days 7|30|90] [--force] [--json]",
      },
      {
        name: "live",
        summary: "Print live token throughput across running threads",
        usage: "bb usage live [--json]",
      },
      {
        name: "accounts",
        summary: "Print separate Codex and Claude account status for every machine",
        usage: "bb usage accounts [--machine <id-or-name>] [--force] [--json]",
      },
    ],
    async run(argv) {
      const {
        json,
        hostId,
        help,
        tokens: tokensOnly,
        live,
        accounts,
        days,
        force,
      } = parseCliArgs(argv);
      if (help) {
        return {
          exitCode: 0,
          stdout:
            "Usage: bb usage [show|accounts|tokens|live] [--days 7|30|90] [--machine <id-or-name>] [--force] [--json]\n",
        };
      }

      if (live) {
        const snapshot = await throughput.refresh();
        if (json) {
          return { exitCode: 0, stdout: `${JSON.stringify(snapshot, null, 2)}\n` };
        }
        return { exitCode: 0, stdout: formatThroughputText(snapshot) };
      }

      if (tokensOnly) {
        const snapshot = await tokens.get(days, force);
        if (json) {
          return { exitCode: 0, stdout: `${JSON.stringify(snapshot, null, 2)}\n` };
        }
        return { exitCode: 0, stdout: formatTokenText(snapshot) };
      }

      let resolvedHostId = hostId;
      if (hostId) {
        const hosts = await bb.sdk.hosts.list();
        const match = hosts.find(
          (host) => host.id === hostId || host.name === hostId,
        );
        if (!match) {
          return {
            exitCode: 1,
            stderr: `Unknown machine: ${hostId}\n`,
          };
        }
        resolvedHostId = match.id;
      }

      if (accounts) {
        const readback = await loadAccountReadback(
          bb,
          resolvedHostId,
          limits,
          force,
          await readHidden(),
        );
        return json
          ? {
              exitCode: 0,
              stdout: `${JSON.stringify(readback, null, 2)}\n`,
            }
          : { exitCode: 0, stdout: formatAccountReadbackText(readback) };
      }

      const snapshot = await loadDashboard(bb, resolvedHostId, limits, force, await readHidden());
      const tokenSnapshot = await tokens.get(days, force);
      if (json) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ...snapshot, tokens: tokenSnapshot }, null, 2)}\n`,
        };
      }
      return {
        exitCode: 0,
        stdout: `${formatDashboardText(snapshot)}\n${formatTokenText(tokenSnapshot)}`,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
