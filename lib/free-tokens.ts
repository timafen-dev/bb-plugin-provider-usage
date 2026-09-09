/**
 * OpenAI's complimentary daily tokens: how many have gone today, and how many
 * of the allowance are left.
 *
 * OpenAI reports consumption but not the allowance. Neither the usage endpoint
 * nor the project rate-limit endpoint returns a daily token ceiling — the
 * ceiling is only shown on the limits page in the dashboard — so the numbers
 * to compare against are configured rather than discovered. That is the same
 * conclusion people writing these counters by hand have reached.
 *
 * Free tokens are earned only on traffic shared with OpenAI, and the usage
 * endpoint does not say which requests were shared. When everything is shared
 * the figures line up; when only some traffic is, this over-counts.
 *
 * Kept free of plugin imports so it can be tested on its own.
 */

export interface AdminAccount {
  label: string;
  key: string;
}

export interface DailyLimit {
  /** Model id, or a prefix ending in `*`. */
  pattern: string;
  tokens: number;
}

export interface ModelUsage {
  model: string;
  tokens: number;
}

export interface LimitGroupRow {
  label: string;
  used: number;
  limit: number;
  remainingPercent: number;
  models: ModelUsage[];
}

/**
 * Owner-confirmed complimentary allowances for one OpenAI organization.
 * Model eligibility still comes from the configured patterns and must be
 * checked against the organization's dashboard before a selector uses it.
 */
export const DEFAULT_OPENAI_FREE_DAILY_LIMITS = [
  "gpt-5* = 250k",
  "gpt-4.1 = 250k",
  "gpt-4o = 250k",
  "o1 = 250k",
  "o3 = 250k",
  "gpt-5-mini = 2.5M",
  "gpt-5-nano = 2.5M",
  "gpt-4.1-mini = 2.5M",
  "gpt-4.1-nano = 2.5M",
  "gpt-4o-mini = 2.5M",
  "o3-mini = 2.5M",
  "o4-mini = 2.5M",
  "codex-mini* = 2.5M",
].join("\n");

/**
 * One account per line: `label = key`, or just the key. A line without a label
 * is named after the key's tail, so two accounts never look identical.
 */
export function parseAdminAccounts(raw: string): AdminAccount[] {
  const accounts: AdminAccount[] = [];
  for (const line of raw.split(/[\r\n]+/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    const label = split > 0 ? trimmed.slice(0, split).trim() : "";
    const key = (split > 0 ? trimmed.slice(split + 1) : trimmed).trim();
    if (key.length === 0) continue;
    accounts.push({
      label: label.length > 0 ? label : `…${key.slice(-6)}`,
      key,
    });
  }
  return accounts;
}

/** One limit per line: `pattern = number`. `5M` and `250k` are accepted. */
export function parseDailyLimits(raw: string): DailyLimit[] {
  const limits: DailyLimit[] = [];
  for (const line of raw.split(/[\r\n,]+/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const split = trimmed.lastIndexOf("=");
    if (split <= 0) continue;
    const pattern = trimmed.slice(0, split).trim();
    const amount = parseTokenAmount(trimmed.slice(split + 1).trim());
    if (pattern.length === 0 || amount === null) continue;
    limits.push({ pattern, tokens: amount });
  }
  return limits;
}

export function parseTokenAmount(raw: string): number | null {
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*([kKmM])?$/u.exec(raw.replace(/[_\s]/gu, ""));
  if (!match) return null;
  const base = Number.parseFloat(match[1]!.replace(",", "."));
  if (!Number.isFinite(base)) return null;
  const scale = match[2]?.toLowerCase() === "m" ? 1e6 : match[2]?.toLowerCase() === "k" ? 1e3 : 1;
  return Math.round(base * scale);
}

/** The most specific matching rule wins, so an exact model beats a prefix. */
export function limitFor(model: string, limits: DailyLimit[]): DailyLimit | null {
  let best: DailyLimit | null = null;
  for (const limit of limits) {
    const isPrefix = limit.pattern.endsWith("*");
    const matches = isPrefix
      ? model.startsWith(limit.pattern.slice(0, -1))
      : model === limit.pattern;
    if (!matches) continue;
    if (best === null || limit.pattern.length > best.pattern.length) best = limit;
  }
  return best;
}

/** Midnight UTC, in seconds — where OpenAI's day starts. */
export function startOfUtcDay(now: Date): number {
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );
}

/** Tokens per model out of the usage endpoint's buckets. */
export function tokensByModel(payload: unknown): ModelUsage[] {
  if (payload === null || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const totals = new Map<string, number>();
  for (const bucket of data) {
    const results = (bucket as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const entry of results) {
      if (entry === null || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const model = typeof row.model === "string" ? row.model : "(unknown)";
      const input = typeof row.input_tokens === "number" ? row.input_tokens : 0;
      const output = typeof row.output_tokens === "number" ? row.output_tokens : 0;
      totals.set(model, (totals.get(model) ?? 0) + input + output);
    }
  }
  return [...totals.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Fold per-model usage into the groups the allowances are stated in. Models
 * with no configured allowance are gathered under one row so their spend is
 * still visible rather than silently dropped.
 */
export function groupAgainstLimits(
  usage: ModelUsage[],
  limits: DailyLimit[],
): { groups: LimitGroupRow[]; unlimited: ModelUsage[] } {
  const groups = new Map<string, LimitGroupRow>();
  const unlimited: ModelUsage[] = [];
  for (const row of usage) {
    const limit = limitFor(row.model, limits);
    if (limit === null) {
      unlimited.push(row);
      continue;
    }
    const existing = groups.get(limit.pattern);
    if (existing === undefined) {
      groups.set(limit.pattern, {
        label: limit.pattern,
        used: row.tokens,
        limit: limit.tokens,
        remainingPercent: 0,
        models: [row],
      });
    } else {
      existing.used += row.tokens;
      existing.models.push(row);
    }
  }
  // A group with a configured allowance is worth showing even at zero: that is
  // the whole point of a counter meant to keep you inside the free tier.
  for (const limit of limits) {
    if (!groups.has(limit.pattern)) {
      groups.set(limit.pattern, {
        label: limit.pattern,
        used: 0,
        limit: limit.tokens,
        remainingPercent: 100,
        models: [],
      });
    }
  }
  const rows = [...groups.values()].map((group) => ({
    ...group,
    remainingPercent:
      group.limit <= 0
        ? 0
        : Math.max(0, Math.min(100, 100 - (group.used / group.limit) * 100)),
  }));
  rows.sort((a, b) => a.remainingPercent - b.remainingPercent);
  return { groups: rows, unlimited };
}

/** Seconds until OpenAI's day rolls over. */
export function secondsUntilReset(now: Date): number {
  return startOfUtcDay(now) + 86_400 - Math.floor(now.getTime() / 1000);
}
