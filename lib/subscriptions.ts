/**
 * Subscriptions, not machines.
 *
 * The owner pays for a handful of plans — two Codex, two Claude — and wants to
 * see each of them, once, with its live quota. A machine is only a place a
 * plan can be read from: the same login sits on a PC, on a server profile,
 * on a home server, and each of those has its own local credential that can
 * be missing or expired while the plan itself is perfectly readable from
 * another machine. Showing "Not signed in" for the machine and nothing for
 * the plan makes the plan disappear, which is the complaint this file answers.
 *
 * Rules, in order:
 *   1. A plan is identified by provider + account e-mail. Nothing is ever
 *      merged across different identities.
 *   2. The freshest `ok` reading from any machine is the plan's reading; a
 *      rate-limit overlay (`stale`) is used only when no machine has `ok`.
 *   3. When no machine can read the plan now, the last successful reading is
 *      shown, marked `stale` with the time and machine it came from. Local
 *      auth problems on a machine (`unauthenticated`, `expired`) never erase
 *      a reading and are never mistaken for an exhausted plan: exhaustion is
 *      `ok` with 0 % left.
 *   4. Every machine tied to the plan is listed with its own status, so the
 *      owner can see both "the plan has 17 % left" and "ПК-2 needs a sign-in".
 *
 * Kept free of plugin imports so it can be tested on its own.
 */
import type {
  ProviderCreditBalance,
  ProviderResetCredits,
  UsageStatus,
  UsageWindow,
} from "./dashboard";

export type SubscriptionProvider = "codex" | "claude-code";

export interface SubscriptionAccountRow {
  machineId: string;
  machineName: string;
  providerId: SubscriptionProvider;
  status: UsageStatus;
  accountEmail: string | null;
  planLabel: string | null;
  message: string | null;
  windows: UsageWindow[];
  credits: ProviderCreditBalance | null;
  resetCredits: ProviderResetCredits | null;
  checkedAt: string;
}

export interface SubscriptionMachine {
  machineId: string;
  machineName: string;
  /** The machine's own local state for this plan, untouched. */
  status: UsageStatus;
  message: string | null;
  checkedAt: string;
}

export interface SubscriptionReading {
  machineId: string;
  machineName: string;
  checkedAt: string;
  planLabel: string | null;
  windows: UsageWindow[];
  credits: ProviderCreditBalance | null;
  resetCredits: ProviderResetCredits | null;
}

export interface Subscription {
  /** `provider:email`, lowercased e-mail. */
  key: string;
  providerId: SubscriptionProvider;
  accountEmail: string;
  planLabel: string | null;
  /** `ok`: fresh this round. `stale`: last successful reading. `unknown`: never read. */
  status: "ok" | "stale" | "unknown";
  windows: UsageWindow[];
  credits: ProviderCreditBalance | null;
  resetCredits: ProviderResetCredits | null;
  /** Where and when the shown windows were read; null when never read. */
  readFrom: { machineId: string; machineName: string; checkedAt: string } | null;
  machines: SubscriptionMachine[];
}

/** What survives between rounds, per plan. */
export interface SubscriptionMemory {
  lastReading: SubscriptionReading | null;
  /** Machines that have identified themselves with this plan before. */
  machineIds: string[];
}

export function subscriptionKey(
  providerId: SubscriptionProvider,
  accountEmail: string,
): string {
  return `${providerId}:${accountEmail.trim().toLowerCase()}`;
}

function parseKey(key: string): { providerId: SubscriptionProvider; email: string } | null {
  const cut = key.indexOf(":");
  if (cut === -1) return null;
  const providerId = key.slice(0, cut);
  if (providerId !== "codex" && providerId !== "claude-code") return null;
  return { providerId, email: key.slice(cut + 1) };
}

function isReadable(row: SubscriptionAccountRow): boolean {
  return (row.status === "ok" || row.status === "stale") && row.windows.length > 0;
}

/** Fresh beats rate-limit overlay; among equals the newest wins. */
function pickReading(rows: SubscriptionAccountRow[]): SubscriptionAccountRow | null {
  return rows.filter(isReadable).reduce<SubscriptionAccountRow | null>((best, row) => {
    if (best === null) return row;
    if (best.status !== row.status) return row.status === "ok" ? row : best;
    return row.checkedAt > best.checkedAt ? row : best;
  }, null);
}

export function assembleSubscriptions(input: {
  accounts: SubscriptionAccountRow[];
  memory: Record<string, SubscriptionMemory>;
}): {
  subscriptions: Subscription[];
  memory: Record<string, SubscriptionMemory>;
} {
  const groups = new Map<string, SubscriptionAccountRow[]>();
  const add = (key: string, row: SubscriptionAccountRow) => {
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  };

  // Which plan a machine answered for last time, so a machine that is offline
  // or has lost its login still shows up under its plan instead of vanishing.
  const rememberedPlan = new Map<string, string>();
  for (const [key, entry] of Object.entries(input.memory)) {
    for (const machineId of entry.machineIds) {
      const machineKey = `${machineId}:${parseKey(key)?.providerId ?? ""}`;
      rememberedPlan.set(machineKey, key);
    }
  }

  for (const row of input.accounts) {
    if (row.accountEmail !== null && row.accountEmail.trim().length > 0) {
      add(subscriptionKey(row.providerId, row.accountEmail), row);
      continue;
    }
    // "Not installed" with no identity is not a plan and is not news here.
    if (row.status === "not_installed") continue;
    const remembered = rememberedPlan.get(`${row.machineId}:${row.providerId}`);
    if (remembered !== undefined) add(remembered, row);
  }

  const memory: Record<string, SubscriptionMemory> = {};
  const keys = new Set<string>([...Object.keys(input.memory), ...groups.keys()]);
  const subscriptions: Subscription[] = [];

  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed === null) continue;
    const rows = groups.get(key) ?? [];
    const prior = input.memory[key] ?? { lastReading: null, machineIds: [] };
    const chosen = pickReading(rows);

    const reading: SubscriptionReading | null = chosen
      ? {
          machineId: chosen.machineId,
          machineName: chosen.machineName,
          checkedAt: chosen.checkedAt,
          planLabel: chosen.planLabel,
          windows: chosen.windows,
          // Enrichment is primary-only; borrow it from a sibling reading of the
          // SAME plan when the chosen machine does not carry it.
          credits:
            chosen.credits ??
            rows.find((row) => row.status === "ok" && row.credits !== null)?.credits ??
            null,
          resetCredits:
            chosen.resetCredits ??
            rows.find((row) => row.status === "ok" && row.resetCredits !== null)
              ?.resetCredits ??
            null,
        }
      : prior.lastReading;

    // Only machines that actually named this identity are remembered as its
    // own; a machine attached by memory stays attached by memory.
    const named = rows
      .filter((row) => row.accountEmail !== null)
      .map((row) => row.machineId);
    const machineIds = [...new Set([...prior.machineIds, ...named])];
    memory[key] = { lastReading: reading, machineIds };

    const email =
      rows.find((row) => row.accountEmail !== null)?.accountEmail ?? parsed.email;
    const planLabel =
      rows.find((row) => row.planLabel !== null)?.planLabel ??
      reading?.planLabel ??
      null;

    subscriptions.push({
      key,
      providerId: parsed.providerId,
      accountEmail: email,
      planLabel,
      status:
        chosen !== null
          ? chosen.status === "ok"
            ? "ok"
            : "stale"
          : reading !== null
            ? "stale"
            : "unknown",
      windows: reading?.windows ?? [],
      credits: reading?.credits ?? null,
      resetCredits: reading?.resetCredits ?? null,
      readFrom: reading
        ? {
            machineId: reading.machineId,
            machineName: reading.machineName,
            checkedAt: reading.checkedAt,
          }
        : null,
      machines: rows
        .map((row) => ({
          machineId: row.machineId,
          machineName: row.machineName,
          status: row.status,
          message: row.message,
          checkedAt: row.checkedAt,
        }))
        .sort((a, b) => a.machineName.localeCompare(b.machineName)),
    });
  }

  subscriptions.sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) ||
      a.accountEmail.localeCompare(b.accountEmail),
  );
  return { subscriptions, memory };
}

/** The window the owner watches: the first one that is not a cost cap. */
export function subscriptionHero(subscription: Subscription): UsageWindow | undefined {
  return subscription.windows.find((window) => !window.cost) ?? subscription.windows[0];
}

/** The tightest plan: what the sidebar ring should say. */
export function tightestSubscription(
  subscriptions: Subscription[],
): { subscription: Subscription; window: UsageWindow } | null {
  let best: { subscription: Subscription; window: UsageWindow } | null = null;
  for (const subscription of subscriptions) {
    if (subscription.status === "unknown") continue;
    for (const window of subscription.windows) {
      if (best === null || window.remainingPercent < best.window.remainingPercent) {
        best = { subscription, window };
      }
    }
  }
  return best;
}
