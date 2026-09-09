/**
 * Reading the Claude login that belongs to *this* machine.
 *
 * BB's own usage probe reads one hardcoded path — `os.homedir()/.claude` — and
 * ignores `CLAUDE_CONFIG_DIR`, even though the code beside it in the same file
 * honours the variable. When one computer runs two BB machines with two Claude
 * logins, every machine reports whichever account happens to sit in the home
 * directory, and the other is invisible. Checked against BB 0.41 and the
 * current development branch.
 *
 * The host worker inherits its daemon's environment, so the daemon that was
 * started with `CLAUDE_CONFIG_DIR` set resolves its own account and the one
 * without it resolves the default. That makes the answer per machine, without
 * anything having to be configured.
 *
 * Kept free of plugin imports so it can be tested on its own.
 */

export interface ClaudeWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export type ClaudeStatus =
  | "ok"
  | "not_installed"
  | "unauthenticated"
  | "expired"
  | "error";

export interface ClaudeMachineUsage {
  status: ClaudeStatus;
  accountEmail: string | null;
  planLabel: string | null;
  message: string | null;
  windows: ClaudeWindow[];
  /** Which directory the answer came from, for support questions. */
  directory: string;
}

function clamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function resetIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Anthropic has named this field both ways; accept either. */
function usedPercent(window: unknown): number | null {
  if (window === null || typeof window !== "object") return null;
  const row = window as Record<string, unknown>;
  return clamp(row.utilization) ?? clamp(row.percent);
}

export function windowsFromUsage(raw: unknown): ClaudeWindow[] {
  if (raw === null || typeof raw !== "object") return [];
  const body = raw as Record<string, unknown>;
  const windows: ClaudeWindow[] = [];
  for (const [key, label] of [
    ["five_hour", "Current session"],
    ["seven_day", "Weekly limit"],
  ] as const) {
    const used = usedPercent(body[key]);
    if (used === null) continue;
    windows.push({
      label,
      usedPercent: used,
      resetsAt: resetIso((body[key] as Record<string, unknown>).resets_at),
    });
  }
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const seen = new Set<string>();
  for (const entry of limits) {
    if (entry === null || typeof entry !== "object") continue;
    const limit = entry as Record<string, unknown>;
    if (limit.kind !== "weekly_scoped") continue;
    const scope = limit.scope as Record<string, unknown> | undefined;
    const model = scope?.model as Record<string, unknown> | undefined;
    const name =
      typeof model?.display_name === "string" ? model.display_name : null;
    const used = clamp(limit.percent);
    if (name === null || used === null || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    windows.push({
      label: name,
      usedPercent: used,
      resetsAt: resetIso(limit.resets_at),
    });
  }
  return windows;
}

export function planLabel(credentials: unknown): string | null {
  if (credentials === null || typeof credentials !== "object") return null;
  const row = credentials as Record<string, unknown>;
  const tier = typeof row.rateLimitTier === "string" ? row.rateLimitTier : "";
  const max = /max_(\d+)x/u.exec(tier);
  if (max) return `Max (${max[1]}x)`;
  const subscription =
    typeof row.subscriptionType === "string" ? row.subscriptionType : "";
  return subscription.length > 0
    ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
    : null;
}

/**
 * The directory this machine's Claude actually uses: the variable BB sets for
 * a per-account daemon, or the standard location.
 */
export function claudeDirectory(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : `${home}/.claude`;
}
