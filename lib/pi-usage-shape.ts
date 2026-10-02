/**
 * The parts of the Firstmate Pi contract the page itself needs: the producer's
 * fixed identities, the only link shape that is ever clickable, how an
 * offset-bearing hour identity is normalized, and the two questions about money
 * whose wrong answer is a lie — is this sum known, and does it agree with the
 * digits the producer summed.
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
  piDecimalEquals,
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
  return piDecimal(amount.known_cost_usd_exact) ?? { units: 0n, scale: 0 };
}

/** Whether the producer's rounded figure agrees with its exact companion. */
export function piCostAgrees(amount: PiMoneyShape): boolean {
  const exact = piDecimal(amount.known_cost_usd_exact);
  const rounded = piDecimal(amount.known_cost_usd);
  return exact !== null && rounded !== null && piDecimalEquals(exact, rounded);
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
        status: string;
        token_field_gaps: number;
        unreadable: number;
        unreadable_paths: number;
        verified_idle_zero: number;
      };
      cost: { calls: number };
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
  const { coverage, cost } = reading.data.snapshot;
  return (
    coverage.status === "verified_idle_zero" &&
    coverage.declared_sources > 0 &&
    coverage.verified_idle_zero === coverage.declared_sources &&
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
    cost.calls === 0
  );
}
