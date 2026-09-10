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
  /** What to call this allowance on screen. */
  label: string;
  /** Model ids, or prefixes ending in `*`. */
  patterns: string[];
  /**
   * The allowance shared by every model in the group. OpenAI grants one pool
   * per group — not one per model — so a group of five models with a 250k
   * allowance has 250k between them, not 1.25M.
   */
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

/**
 * One allowance per line:
 *
 *   `Label: pattern, pattern, … = amount`
 *
 * The label is optional; without it the patterns themselves name the row.
 * `5M` and `250k` are accepted for the amount. Commas separate models inside a
 * group, so lines are the only separator between groups.
 */
export function parseDailyLimits(raw: string): DailyLimit[] {
  const limits: DailyLimit[] = [];
  for (const line of raw.split(/[\r\n]+/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const split = trimmed.lastIndexOf("=");
    if (split <= 0) continue;
    const amount = parseTokenAmount(trimmed.slice(split + 1).trim());
    if (amount === null) continue;
    let head = trimmed.slice(0, split).trim();
    let label = "";
    // A colon separates a name from the models, but model ids never contain
    // one, so this cannot swallow part of a pattern.
    const colon = head.indexOf(":");
    if (colon > 0) {
      label = head.slice(0, colon).trim();
      head = head.slice(colon + 1).trim();
    }
    const patterns = head
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (patterns.length === 0) continue;
    limits.push({
      label: label.length > 0 ? label : patterns.join(", "),
      patterns,
      tokens: amount,
    });
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

function matchLength(model: string, pattern: string): number {
  if (pattern.endsWith("*")) {
    const head = pattern.slice(0, -1);
    return model.startsWith(head) ? head.length : -1;
  }
  return model === pattern ? pattern.length : -1;
}

/**
 * The most specific matching pattern wins, so `gpt-4.1-mini*` claims a mini
 * model even when `gpt-4.1*` would also match it.
 */
export function limitFor(model: string, limits: DailyLimit[]): DailyLimit | null {
  let best: DailyLimit | null = null;
  let bestLength = -1;
  for (const limit of limits) {
    for (const pattern of limit.patterns) {
      const length = matchLength(model, pattern);
      if (length > bestLength) {
        bestLength = length;
        best = limit;
      }
    }
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
    const existing = groups.get(limit.label);
    if (existing === undefined) {
      groups.set(limit.label, {
        label: limit.label,
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
    if (!groups.has(limit.label)) {
      groups.set(limit.label, {
        label: limit.label,
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
