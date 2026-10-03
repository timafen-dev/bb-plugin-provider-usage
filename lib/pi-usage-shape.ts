/**
 * The parts of the Firstmate Pi contract the page itself needs: the producer's
 * fixed identities, the only link shape that is ever clickable, how an
 * offset-bearing hour identity is normalized, and whether a sum is known.
 *
 * These live apart from `pi-usage-contract.ts` for one concrete reason: that
 * module builds the snapshot's zod schemas, and the page has no use for them —
 * the server already validated the reading at the hop. Importing a validator
 * into the browser bundle to read four constants and a regex put the whole
 * schema library in the app, which is a cost with no reader. Everything here is
 * re-exported by the contract, so nothing that already imported it changed.
 *
 * Deliberately free of any dependency but exact decimals: plain values, plain
 * regexes, no schema, no I/O.
 */

import {
  piDecimal,
  piDecimalIsZero,
  type PiDecimal,
} from "./pi-usage-decimal";

/**
 * The folded row is `others` for tasks and work items but `other` for
 * requested models. Those are the producer's literal spellings, and they are
 * aggregates — never a real task key and never a fake bb thread.
 */
export const PI_FOLDED_ROW = "others";
export const PI_FOLDED_MODEL = "other";

/** Main work with no proved task binding keeps this reserved key. */
export const PI_MAIN_UNASSIGNED = "main_unassigned";

/**
 * Expected live cadence once a snapshot is actually placed and polling is
 * approved. Both are declared here so freshness has a stated meaning.
 */
export const PI_TICK_SECONDS = 30;
export const PI_GRACE_SECONDS = 90;
/** Clocks disagree by a little; beyond this a timestamp is ahead, not fresh. */
export const PI_FUTURE_SKEW_SECONDS = 5;

/** The only links allowed anywhere in a snapshot. */
const SAFE_LINK =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,100}\/(?:issues|pull)\/[1-9]\d{0,9}$/;

export function isPiSafeLink(value: string): boolean {
  return SAFE_LINK.test(value);
}

/**
 * An hour identity is offset-bearing and hour-precision — `2026-10-01T22+00:00`
 * — not a full-second RFC3339 instant. The offset is part of the identity: on a
 * 25-hour DST day the repeated local hour stays two distinct points.
 */
const HOUR_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})(Z|[+-]\d{2}:\d{2})$/;

/** The UTC instant an hour identity starts at, or `null` if it is malformed. */
export function piHourInstantMs(hour: string): number | null {
  const parts = HOUR_ID.exec(hour);
  if (!parts) return null;
  const ms = Date.parse(piHourRfc3339(hour) ?? "");
  return Number.isFinite(ms) ? ms : null;
}

/** The offset an hour identity carries: `Z` or `+hh:mm`. */
export function piHourOffset(hour: string): string | null {
  return HOUR_ID.exec(hour)?.[3] ?? null;
}

/**
 * The same hour spelled with the minutes and seconds a JS date parser wants.
 * Chart code normalizes explicitly through here instead of hoping that
 * `new Date("2026-10-01T22+00:00")` means what it looks like.
 */
export function piHourRfc3339(hour: string): string | null {
  const parts = HOUR_ID.exec(hour);
  if (!parts) return null;
  return `${parts[1]}T${parts[2]}:00:00${parts[3]}`;
}

/**
 * The money and call counters every aggregate carries. Stated structurally so
 * this module stays schema-free; the contract asserts that its own inferred
 * types are these.
 */
export interface PiMoneyShape {
  calls: number;
  invalid_cost_calls: number;
  known_cost_usd: string;
  known_cost_usd_exact: string;
  missing_cost_calls: number;
  priced_calls: number;
  token_field_gaps: number;
}

/**
 * Whether known spend is actually known.
 *
 * A sum of zero with no priced call is unknown spend, not a free hour, and the
 * panel must not round it into "$0.00 spent".
 */
export function piSpendIsKnown(amount: PiMoneyShape): boolean {
  return amount.priced_calls > 0;
}

/** The exact recorded sum, as digits rather than a float. */
export function piExactCost(amount: PiMoneyShape): PiDecimal {
  return piDecimal(amount.known_cost_usd_exact)!;
}

export type PiFreshness =
  | { state: "fresh"; ageSeconds: number }
  | { state: "stale"; ageSeconds: number }
  | { state: "future"; aheadSeconds: number };

export function piFreshness(
  generatedAt: string,
  nowMs: number,
  graceSeconds = PI_GRACE_SECONDS,
): PiFreshness {
  const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(generatedAt)
    ? Date.parse(generatedAt)
    : NaN;
  if (!Number.isFinite(ms)) return { state: "stale", ageSeconds: Infinity };
  const ageSeconds = (nowMs - ms) / 1000;
  if (ageSeconds < -PI_FUTURE_SKEW_SECONDS) {
    return { state: "future", aheadSeconds: -ageSeconds };
  }
  const age = Math.max(0, ageSeconds);
  return age > graceSeconds
    ? { state: "stale", ageSeconds: age }
    : { state: "fresh", ageSeconds: age };
}

interface PiTokensShape {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
}

interface PiAmountShape extends PiMoneyShape {
  tokens: PiTokensShape;
}

function zeroTokens(tokens: PiTokensShape): boolean {
  return Object.values(tokens).every((value) => value === 0);
}

function zeroMoney(amount: PiMoneyShape): boolean {
  return amount.calls === 0 && amount.priced_calls === 0 &&
    amount.missing_cost_calls === 0 && amount.invalid_cost_calls === 0 &&
    amount.token_field_gaps === 0 &&
    piDecimalIsZero(piExactCost(amount));
}

/**
 * What `piVerifiedIdleZero` needs to see of a reading. Structural for the same
 * reason as above; the contract's own `PiReading` satisfies it.
 */
export interface PiIdleReadingShape {
  status: string;
  data: {
    degraded: boolean;
    retained: boolean;
    snapshot: {
      coverage: {
        ambiguous_fork_entries: number;
        assistant_without_usage: number;
        conflicting_binding: number;
        declared_sources: number;
        invalid_rows: number;
        never_ingested: number;
        partial: number;
        pending_tails: number;
        readable: number;
        sources: { alias: string; status: string; entries_in_window: number }[];
        status: string;
        token_field_gaps: number;
        unreadable: number;
        unreadable_paths: number;
        verified_idle_zero: number;
      };
      cost: PiMoneyShape;
      tokens: PiTokensShape;
      quarantine: unknown[];
      tasks: PiAmountShape[];
      roles: PiAmountShape[];
      requested_models: PiAmountShape[];
      work_items: PiAmountShape[];
      main_unassigned: PiAmountShape;
      days: PiAmountShape[];
      hours: PiAmountShape[];
      live_bins: { bins: PiAmountShape[] };
    };
  } | null;
}

/**
 * Whether a reading really means "Pi did no work", as opposed to any of the
 * ways a panel can fail to find out. Only a fresh, non-degraded snapshot whose
 * every declared source the producer itself verified as idle qualifies; a
 * missing file, a refused file, a failure note, a stale export, an unreadable
 * path or a partial coverage never does.
 */
export function piVerifiedIdleZero(reading: PiIdleReadingShape): boolean {
  if (reading.status !== "ok" || reading.data === null) return false;
  if (reading.data.degraded || reading.data.retained) return false;
  const snapshot = reading.data.snapshot;
  const { coverage, cost } = snapshot;
  const amounts = [
    ...snapshot.tasks, ...snapshot.roles, ...snapshot.requested_models,
    ...snapshot.work_items, snapshot.main_unassigned, ...snapshot.days,
    ...snapshot.hours, ...snapshot.live_bins.bins,
  ];
  return (
    coverage.status === "verified_idle_zero" &&
    coverage.declared_sources > 0 &&
    coverage.verified_idle_zero === coverage.declared_sources &&
    coverage.sources.length === coverage.declared_sources &&
    new Set(coverage.sources.map((source) => source.alias)).size === coverage.declared_sources &&
    coverage.sources.every((source) =>
      source.status === "verified_idle_zero" && source.entries_in_window === 0) &&
    coverage.readable === 0 &&
    coverage.pending_tails === 0 &&
    snapshot.quarantine.length === 0 &&
    coverage.unreadable === 0 &&
    coverage.unreadable_paths === 0 &&
    coverage.never_ingested === 0 &&
    coverage.partial === 0 &&
    coverage.conflicting_binding === 0 &&
    coverage.ambiguous_fork_entries === 0 &&
    // A token field gap, a skipped row or a response without usage all mean
    // something was not read, which is the opposite of a verified idle hour.
    coverage.token_field_gaps === 0 &&
    coverage.assistant_without_usage === 0 &&
    coverage.invalid_rows === 0 &&
    zeroMoney(cost) && zeroTokens(snapshot.tokens) &&
    amounts.every((amount) => zeroMoney(amount) && zeroTokens(amount.tokens))
  );
}
