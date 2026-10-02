/**
 * The wire contract of the Firstmate Pi usage snapshot, as a consumer reads it.
 *
 * Firstmate Pi runs agent work outside bb, so none of it reaches this panel's
 * own sources: there is no bb thread to listen to, no transcript root that is
 * compiled in, and no provider login to ask. The producer therefore writes one
 * bounded, sanitized, read-only snapshot file, and this module is the only
 * place that decides whether such a file may be believed.
 *
 * The canonical producer contract is
 * https://github.com/timafen-dev/agentic-engineering/blob/b8770582bd78ed5d362750950f93756eec105c99/tools/subscription_usage/PI_USAGE.md
 * and everything pinned below comes from it rather than from a guess:
 *
 *   wire `schema_version: 1`, `kind: pi_usage_snapshot`, producer alias
 *   `firstmate-pi`, private ledger schema 2, parser `pi-usage-parser/2`,
 *   source schema `pi-session-jsonl/1`.
 *
 * Three rules shape the validation, and each of them exists because the
 * cheerful reading of a broken file is the dangerous one:
 *
 *  1. **Strict, not tolerant.** An unexpected key, a wrong version, a row that
 *     outgrew its bound or a count that does not add up makes the snapshot
 *     invalid. A consumer that quietly drops the parts it did not expect would
 *     show a believable total that is missing work.
 *  2. **Nothing becomes a zero.** Missing, oversized, unparseable, rejected,
 *     stale and producer-reported-failed are each their own state, and none of
 *     them is "no usage". Only the producer may say a source was idle, through
 *     `verified_idle_zero`.
 *  3. **Nothing private travels.** The producer already sanitizes, so a
 *     snapshot carrying a path, a home directory, an address, a credential or
 *     raw exception text is evidence that it is not the artifact promised by
 *     the contract — and it is refused rather than rendered.
 *
 * This file is pure: it reads text and returns verdicts. Locating the file,
 * confining it to the approved owning host and bounding the read belong to the
 * host entry, and the figures are Pi's own recorded API-equivalent estimate —
 * never an invoice, a payment, or subscription quota consumption. Native BB
 * totals and the subscriptions view are untouched by anything here.
 */
import { z } from "zod";
import {
  piDecimal,
  piDecimalEquals,
  piDecimalFixed,
  piDecimalIsNegative,
  piDecimalIsZero,
  type PiDecimal,
} from "./pi-usage-decimal";

/** The producer promises at most this many UTF-8 bytes per representation. */
export const PI_MAX_SNAPSHOT_BYTES = 2_097_152;

/** Row and point bounds, exactly as the contract states them. */
export const PI_MAX_TASKS = 20;
export const PI_MAX_WORK_ITEMS = 50;
export const PI_MAX_REQUESTED_MODELS = 16;
export const PI_MAX_DAYS = 90;
export const PI_MAX_HOURS = 168;
export const PI_MAX_LIVE_BINS = 90;
export const PI_LIVE_BIN_SECONDS = 10;
/** Task labels carry at most four approved issue/PR links. */
export const PI_MAX_TASK_URLS = 4;

/**
 * The folded row is `others` for tasks and work items but `other` for
 * requested models. Those are the producer's literal spellings, and they are
 * aggregates — never a real task key and never a fake bb thread.
 */
export const PI_FOLDED_ROW = "others";
export const PI_FOLDED_MODEL = "other";

/** Main work with no proved task binding keeps this reserved key. */
export const PI_MAIN_UNASSIGNED = "main_unassigned";

/** Roles are a fixed closed set; an absent role is `unknown`, never invented. */
export const PI_ROLES = ["main", "supervisor", "author", "nm", "unknown"] as const;
export type PiRole = (typeof PI_ROLES)[number];

/** Coverage identities. `unreadable` is never collapsed into a zero. */
export const PI_COVERAGE_STATUSES = [
  "readable",
  "verified_idle_zero",
  "unreadable",
  "never_ingested",
  "partial",
  "conflicting_binding",
] as const;
export type PiCoverageStatus = (typeof PI_COVERAGE_STATUSES)[number];

/** Bounds on free-form text, so a sanitized field cannot carry a payload. */
const MAX_TEXT = 2_000;
const MAX_LABEL = 200;
const MAX_WARNINGS = 200;
const MAX_QUARANTINE = 200;
/** No bound is stated for declared sources; this keeps the array finite. */
const MAX_SOURCES = 512;

/** The only links allowed anywhere in a snapshot. */
const SAFE_LINK =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,100}\/(?:issues|pull)\/[1-9]\d{0,9}$/;

export function isPiSafeLink(value: string): boolean {
  return SAFE_LINK.test(value);
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DAY_ID = /^\d{4}-\d{2}-\d{2}$/;
/**
 * An hour identity is offset-bearing and hour-precision — `2026-10-01T22+00:00`
 * — not a full-second RFC3339 instant. The offset is part of the identity: on a
 * 25-hour DST day the repeated local hour stays two distinct points.
 */
const HOUR_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})(Z|[+-]\d{2}:\d{2})$/;

function instantMs(value: string): number | null {
  if (!INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function dayMs(value: string): number | null {
  if (!DAY_ID.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

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

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const textSchema = z.string().max(MAX_TEXT);
const labelSchema = z.string().max(MAX_LABEL);
const instantSchema = z.string().refine((value) => instantMs(value) !== null);
const decimalSchema = z
  .string()
  .max(40)
  .refine((value) => {
    const parsed = piDecimal(value);
    // Money the producer recorded is finite and non-negative by contract.
    return parsed !== null && !piDecimalIsNegative(parsed);
  });

const tokensSchema = z
  .object({
    cache_read: countSchema,
    cache_write: countSchema,
    input: countSchema,
    output: countSchema,
    reasoning: countSchema,
  })
  .strict();

/**
 * Every aggregate row carries the same money and token block. Input, cache
 * read, cache write and output stay four distinct numbers, and `reasoning` is
 * a possible subset of `output` that is never added to it again.
 */
function amountShape() {
  return {
    calls: countSchema,
    invalid_cost_calls: countSchema,
    known_cost_usd: decimalSchema,
    known_cost_usd_exact: decimalSchema,
    missing_cost_calls: countSchema,
    priced_calls: countSchema,
    token_field_gaps: countSchema,
    tokens: tokensSchema,
  };
}

export const piSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("pi_usage_snapshot"),
    producer: z
      .object({
        // One approved producer. Another alias is another dataset, not this one.
        alias: z.literal("firstmate-pi"),
        // Ledger schema 1 is refused outright by the producer; so is it here.
        ledger_schema_version: z.literal(2),
        parser_version: z.literal("pi-usage-parser/2"),
        // Shape only: the producer advances its revision without breaking us.
        revision: z.string().regex(/^[0-9a-f]{40}$/),
        source_schema_version: z.literal("pi-session-jsonl/1"),
      })
      .strict(),
    generated_at: instantSchema,
    window: z
      .object({
        boundary: z.literal("[start,end)"),
        mode: z.literal("half_open"),
        start: instantSchema,
        end: instantSchema,
        timezone: labelSchema,
      })
      .strict(),
    coverage: z
      .object({
        ambiguous_fork_entries: countSchema,
        assistant_without_usage: countSchema,
        conflicting_binding: countSchema,
        declared_sources: countSchema,
        invalid_rows: countSchema,
        never_ingested: countSchema,
        partial: countSchema,
        pending_tails: countSchema,
        readable: countSchema,
        sources: z
          .array(
            z
              .object({
                // A pseudonym, and the only source identity that ever leaves
                // the machine.
                alias: labelSchema,
                entries_in_window: countSchema,
                last_ingest: instantSchema.nullable(),
                status: z.enum(PI_COVERAGE_STATUSES),
              })
              .strict(),
          )
          .max(MAX_SOURCES),
        status: z.enum(PI_COVERAGE_STATUSES),
        token_field_gaps: countSchema,
        unreadable: countSchema,
        unreadable_paths: countSchema,
        verified_idle_zero: countSchema,
      })
      .strict(),
    cost: z
      .object({
        calls: countSchema,
        currency: z.literal("USD"),
        invalid_cost_calls: countSchema,
        known_cost_usd: decimalSchema,
        known_cost_usd_exact: decimalSchema,
        label: textSchema,
        missing_cost_calls: countSchema,
        // Never recorded by the producer, so there is nothing to reprice from.
        price_catalog_version: labelSchema.nullable(),
        priced_calls: countSchema,
        provenance: z.literal("pi_recorded_usage_cost"),
        repricing: z.literal("none"),
        token_field_gaps: countSchema,
      })
      .strict(),
    tokens: tokensSchema,
    tasks: z
      .array(z.object({ ...amountShape(), task_key: labelSchema }).strict())
      .max(PI_MAX_TASKS + 1),
    task_labels: z
      .array(
        z
          .object({
            task_key: labelSchema,
            title: labelSchema.nullable(),
            urls: z.array(z.string().max(MAX_LABEL)).max(PI_MAX_TASK_URLS),
          })
          .strict(),
      )
      .max(PI_MAX_TASKS + 1),
    roles: z
      .array(z.object({ ...amountShape(), role: z.enum(PI_ROLES) }).strict())
      .max(PI_ROLES.length),
    requested_models: z
      .array(
        z
          .object({ ...amountShape(), requested_model: labelSchema })
          .strict(),
      )
      .max(PI_MAX_REQUESTED_MODELS + 1),
    work_items: z
      .array(z.object({ ...amountShape(), work_item: labelSchema }).strict())
      .max(PI_MAX_WORK_ITEMS + 1),
    main_unassigned: z.object(amountShape()).strict(),
    days: z
      .array(z.object({ ...amountShape(), day: z.string().max(10) }).strict())
      .max(PI_MAX_DAYS),
    hours: z
      .array(z.object({ ...amountShape(), hour: z.string().max(32) }).strict())
      .max(PI_MAX_HOURS),
    live_bins: z
      .object({
        bin_seconds: z.literal(PI_LIVE_BIN_SECONDS),
        bins: z
          .array(
            z.object({ ...amountShape(), bin_start: instantSchema }).strict(),
          )
          .max(PI_MAX_LIVE_BINS),
        covers: labelSchema,
      })
      .strict(),
    observation: z
      .object({
        basis: z.literal("completed_assistant_responses"),
        // The current context is unknown, and a cache read is not the context.
        current_context_status: z.literal("unknown_no_recorded_proof"),
        current_context_tokens: z.null(),
        finality: textSchema,
        lag_seconds: z.number().min(0).finite(),
        latest_recorded_at: instantSchema.nullable(),
      })
      .strict(),
    warnings: z.array(textSchema).max(MAX_WARNINGS),
    /**
     * Contract v1 fixes neither the keys nor the row shape of a quarantine
     * record beyond "sanitized alias and ordinal, never a path", and the
     * approved fixture carries none. Rows are therefore bounded and scalar
     * rather than pinned, and the privacy guard below still walks every key
     * and string in them. The consumer reports quarantine as a coverage gap
     * and never as spend.
     */
    quarantine: z
      .array(
        z.record(
          labelSchema,
          z.union([textSchema, z.number(), z.boolean(), z.null()]),
        ),
      )
      .max(MAX_QUARANTINE),
    limits: z
      .object({
        max_days: z.literal(PI_MAX_DAYS),
        max_export_bytes: z.literal(PI_MAX_SNAPSHOT_BYTES),
        max_hours: z.literal(PI_MAX_HOURS),
        max_live_bins: z.literal(PI_MAX_LIVE_BINS),
        max_requested_models: z.literal(PI_MAX_REQUESTED_MODELS),
        max_tasks: z.literal(PI_MAX_TASKS),
        max_work_items: z.literal(PI_MAX_WORK_ITEMS),
      })
      .strict(),
    consumer: z.object({ quota: textSchema, usage: textSchema }).strict(),
    token_semantics: z
      .object({
        input: textSchema,
        model_identity: textSchema,
        reasoning: textSchema,
      })
      .strict(),
  })
  .strict();

export type PiUsageSnapshot = z.infer<typeof piSnapshotSchema>;
export type PiAmount = PiUsageSnapshot["main_unassigned"];
export type PiTokens = PiUsageSnapshot["tokens"];
/**
 * The money and call counters every aggregate shares. The top-level `cost`
 * block carries these without a `tokens` member, because the snapshot's token
 * totals are their own top-level group, so checks over money take this shape
 * rather than a whole row.
 */
export type PiMoney = Omit<PiAmount, "tokens">;
export type PiTaskRow = PiUsageSnapshot["tasks"][number];
export type PiRoleRow = PiUsageSnapshot["roles"][number];
export type PiModelRow = PiUsageSnapshot["requested_models"][number];
export type PiWorkItemRow = PiUsageSnapshot["work_items"][number];
export type PiDayRow = PiUsageSnapshot["days"][number];
export type PiHourRow = PiUsageSnapshot["hours"][number];
export type PiLiveBin = PiUsageSnapshot["live_bins"]["bins"][number];
export type PiTaskLabel = PiUsageSnapshot["task_labels"][number];

/* ------------------------------------------------------------------ privacy */

/**
 * Sentinels for content the producer promises never to emit. A hit is not a
 * cosmetic complaint: it means the file is not the sanitized artifact the
 * contract describes, so it is refused instead of displayed.
 */
const PRIVACY_SENTINELS: { id: string; test: RegExp }[] = [
  { id: "absolute_path", test: /(?:^|[\s"'(:=])(?:~\/|\/(?:home|Users|root|var|tmp|private|etc|opt|mnt|srv)\/)/ },
  { id: "windows_path", test: /[A-Za-z]:[\\/]{1,2}(?:Users|Documents)/i },
  { id: "email", test: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  {
    id: "credential",
    test: /\b(?:sk-[A-Za-z0-9-]{8,}|bearer\s+[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]{10,}|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)\b/i,
  },
  { id: "oauth_field", test: /\boauth[A-Za-z]*\b/i },
  {
    id: "exception_text",
    test: /Traceback \(most recent call last\)|\bFile "[^"]*", line \d+|\n\s+at [A-Za-z<]/,
  },
];

export interface PiPrivacyHit {
  /** The field it was found in, by key path — never the offending text. */
  path: string;
  sentinel: string;
}

/**
 * Walks every key and string of a validated snapshot.
 *
 * Any string carrying a link must be *exactly* one approved HTTPS GitHub issue
 * or pull link; that single rule covers `http://`, a shortener, a tracking
 * query and a link smuggled into prose, without having to enumerate them.
 */
export function piPrivacyHits(value: unknown): PiPrivacyHit[] {
  const hits: PiPrivacyHit[] = [];

  const checkString = (text: string, path: string): void => {
    if (/https?:\/\//i.test(text)) {
      if (!isPiSafeLink(text)) hits.push({ path, sentinel: "unsafe_link" });
      return;
    }
    for (const sentinel of PRIVACY_SENTINELS) {
      if (sentinel.test.test(text)) hits.push({ path, sentinel: sentinel.id });
    }
  };

  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      checkString(node, path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        const next = path === "" ? key : `${path}.${key}`;
        checkString(key, next);
        walk(item, next);
      }
    }
  };

  walk(value, "");
  return hits;
}

/* ---------------------------------------------------------------- structure */

/** A sanitized structural complaint: a field path and a stable code. */
export interface PiStructureProblem {
  path: string;
  code: string;
}

function checkAmount(
  amount: PiMoney,
  tokens: PiTokens | null,
  path: string,
  problems: PiStructureProblem[],
): void {
  const exact = piDecimal(amount.known_cost_usd_exact);
  const rounded = piDecimal(amount.known_cost_usd);
  if (!exact || !rounded) {
    problems.push({ path, code: "cost_not_decimal" });
    return;
  }
  // The readable figure must be the exact sum rounded, not a separate opinion.
  if (piDecimalFixed(exact, 6) !== piDecimalFixed(rounded, 6)) {
    problems.push({ path: `${path}.known_cost_usd`, code: "rounding_mismatch" });
  }
  // Every call is priced, missing or invalid: no fourth outcome exists.
  if (
    amount.priced_calls + amount.missing_cost_calls + amount.invalid_cost_calls !==
    amount.calls
  ) {
    problems.push({ path: `${path}.calls`, code: "call_counts_disagree" });
  }
  if (amount.token_field_gaps > amount.calls) {
    problems.push({ path: `${path}.token_field_gaps`, code: "gaps_exceed_calls" });
  }
  // No priced call means no known spend. A non-zero sum would be invented.
  if (amount.priced_calls === 0 && !piDecimalIsZero(exact)) {
    problems.push({ path: `${path}.known_cost_usd_exact`, code: "cost_without_priced_call" });
  }
  // Reasoning is a subset of output, so it can never exceed it.
  if (tokens !== null && tokens.reasoning > tokens.output) {
    problems.push({ path: `${path}.tokens.reasoning`, code: "reasoning_exceeds_output" });
  }
}

/** One folded aggregate row at most, and it may not also be a real key. */
function checkFolding(
  keys: string[],
  folded: string,
  cap: number,
  path: string,
  problems: PiStructureProblem[],
): void {
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    problems.push({ path, code: "duplicate_rows" });
  }
  const real = keys.filter((key) => key !== folded);
  if (real.length > cap) {
    problems.push({ path, code: "too_many_rows" });
  }
}

/**
 * Checks the agreements the schema cannot express: bounds against the
 * snapshot's own declared limits, folded-row shape, label membership, ordered
 * and aligned series, and money that adds up.
 */
export function piStructureProblems(
  snapshot: PiUsageSnapshot,
): PiStructureProblem[] {
  const problems: PiStructureProblem[] = [];

  // The snapshot's own token totals live beside `cost`, not inside it.
  checkAmount(snapshot.cost, snapshot.tokens, "cost", problems);
  checkAmount(
    snapshot.main_unassigned,
    snapshot.main_unassigned.tokens,
    "main_unassigned",
    problems,
  );
  const rows: [PiAmount, string][] = [
    ...snapshot.tasks.map((row, i): [PiAmount, string] => [row, `tasks[${i}]`]),
    ...snapshot.roles.map((row, i): [PiAmount, string] => [row, `roles[${i}]`]),
    ...snapshot.requested_models.map((row, i): [PiAmount, string] => [
      row,
      `requested_models[${i}]`,
    ]),
    ...snapshot.work_items.map((row, i): [PiAmount, string] => [row, `work_items[${i}]`]),
    ...snapshot.days.map((row, i): [PiAmount, string] => [row, `days[${i}]`]),
    ...snapshot.hours.map((row, i): [PiAmount, string] => [row, `hours[${i}]`]),
    ...snapshot.live_bins.bins.map((row, i): [PiAmount, string] => [
      row,
      `live_bins.bins[${i}]`,
    ]),
  ];
  for (const [row, path] of rows) checkAmount(row, row.tokens, path, problems);

  // Bounds are checked against what the snapshot itself declares, so a
  // producer that shrinks a limit cannot overflow the panel on the next poll.
  checkFolding(
    snapshot.tasks.map((row) => row.task_key),
    PI_FOLDED_ROW,
    snapshot.limits.max_tasks,
    "tasks",
    problems,
  );
  checkFolding(
    snapshot.work_items.map((row) => row.work_item),
    PI_FOLDED_ROW,
    snapshot.limits.max_work_items,
    "work_items",
    problems,
  );
  checkFolding(
    snapshot.requested_models.map((row) => row.requested_model),
    PI_FOLDED_MODEL,
    snapshot.limits.max_requested_models,
    "requested_models",
    problems,
  );
  if (snapshot.days.length > snapshot.limits.max_days) {
    problems.push({ path: "days", code: "too_many_rows" });
  }
  if (snapshot.hours.length > snapshot.limits.max_hours) {
    problems.push({ path: "hours", code: "too_many_rows" });
  }
  if (snapshot.live_bins.bins.length > snapshot.limits.max_live_bins) {
    problems.push({ path: "live_bins.bins", code: "too_many_rows" });
  }

  // Roles are the fixed five, each exactly once: a dimension, not a discovery.
  const roles = snapshot.roles.map((row) => row.role);
  if (
    roles.length !== PI_ROLES.length ||
    new Set(roles).size !== roles.length ||
    !PI_ROLES.every((role) => roles.includes(role))
  ) {
    problems.push({ path: "roles", code: "role_identities_unexpected" });
  }

  // Labels describe actually emitted, non-folded task keys and nothing else,
  // so a label can never conjure a row the producer did not report.
  const labelled = new Set<string>();
  const emitted = new Set(
    snapshot.tasks
      .map((row) => row.task_key)
      .filter((key) => key !== PI_FOLDED_ROW),
  );
  snapshot.task_labels.forEach((label, i) => {
    if (labelled.has(label.task_key)) {
      problems.push({ path: `task_labels[${i}]`, code: "duplicate_label" });
    }
    labelled.add(label.task_key);
    if (!emitted.has(label.task_key)) {
      problems.push({ path: `task_labels[${i}]`, code: "label_without_task" });
    }
    label.urls.forEach((url, u) => {
      if (!isPiSafeLink(url)) {
        problems.push({ path: `task_labels[${i}].urls[${u}]`, code: "unsafe_link" });
      }
    });
  });

  // Half-open window, so an empty or inverted range is a broken export.
  const start = instantMs(snapshot.window.start);
  const end = instantMs(snapshot.window.end);
  if (start === null || end === null || start >= end) {
    problems.push({ path: "window", code: "window_not_half_open" });
  }

  // Days are plain dates, in order, once each.
  let previousDay = -Infinity;
  snapshot.days.forEach((row, i) => {
    const ms = dayMs(row.day);
    if (ms === null) {
      problems.push({ path: `days[${i}].day`, code: "day_malformed" });
      return;
    }
    if (ms <= previousDay) {
      problems.push({ path: `days[${i}].day`, code: "days_out_of_order" });
    }
    previousDay = ms;
  });

  // Hour identities keep their offset. Two spellings of the same local hour on
  // a DST day are different identities and different instants, so ordering is
  // by instant while identity stays the raw offset-bearing string.
  const hourIds = new Set<string>();
  let previousHour = -Infinity;
  snapshot.hours.forEach((row, i) => {
    const ms = piHourInstantMs(row.hour);
    if (ms === null) {
      problems.push({ path: `hours[${i}].hour`, code: "hour_malformed" });
      return;
    }
    if (hourIds.has(row.hour)) {
      problems.push({ path: `hours[${i}].hour`, code: "duplicate_hour" });
    }
    hourIds.add(row.hour);
    if (ms <= previousHour) {
      problems.push({ path: `hours[${i}].hour`, code: "hours_out_of_order" });
    }
    previousHour = ms;
  });

  // Live rows are keyed by bin_start, aligned to the declared bin width.
  const binIds = new Set<string>();
  let previousBin = -Infinity;
  snapshot.live_bins.bins.forEach((row, i) => {
    const ms = instantMs(row.bin_start);
    if (ms === null) {
      problems.push({ path: `live_bins.bins[${i}].bin_start`, code: "bin_malformed" });
      return;
    }
    if (ms % (snapshot.live_bins.bin_seconds * 1000) !== 0) {
      problems.push({ path: `live_bins.bins[${i}].bin_start`, code: "bin_unaligned" });
    }
    if (binIds.has(row.bin_start)) {
      problems.push({ path: `live_bins.bins[${i}].bin_start`, code: "duplicate_bin" });
    }
    binIds.add(row.bin_start);
    if (ms <= previousBin) {
      problems.push({ path: `live_bins.bins[${i}].bin_start`, code: "bins_out_of_order" });
    }
    previousBin = ms;
  });

  return problems;
}

/* -------------------------------------------------------------------- parse */

export type PiRejectReason =
  | "too_large"
  | "not_json"
  | "not_an_object"
  | "schema"
  | "privacy"
  | "structure";

export type PiSnapshotParse =
  | { ok: true; snapshot: PiUsageSnapshot; bytes: number }
  | { ok: false; reason: PiRejectReason; detail: string };

/** UTF-8 byte length, which is what the producer's bound is stated in. */
export function piUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Text in, verdict out.
 *
 * The size bound is checked first so an oversized file is rejected before the
 * parser is handed it, and no rejection detail ever carries raw exception text,
 * a received value or a path: a `JSON.parse` message can quote the file, and a
 * schema message can quote a field's contents, so details are built from field
 * paths and fixed wording only.
 */
export function parsePiUsageSnapshot(text: string): PiSnapshotParse {
  const bytes = piUtf8Bytes(text);
  if (bytes > PI_MAX_SNAPSHOT_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      detail: `the snapshot is larger than the agreed ${PI_MAX_SNAPSHOT_BYTES} bytes`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json", detail: "the snapshot is not valid JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not_an_object", detail: "the snapshot is not a JSON object" };
  }

  const parsed = piSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = Array.from(
      new Set(
        parsed.error.issues
          .slice(0, 8)
          .map((issue) => issue.path.map(String).join(".") || "(root)"),
      ),
    );
    return {
      ok: false,
      reason: "schema",
      detail: `the snapshot does not match the agreed shape at: ${paths.join(", ")}`,
    };
  }

  const leaks = piPrivacyHits(parsed.data);
  if (leaks.length > 0) {
    const where = Array.from(new Set(leaks.slice(0, 8).map((hit) => `${hit.path} (${hit.sentinel})`)));
    return {
      ok: false,
      reason: "privacy",
      detail: `the snapshot carries content the producer never emits at: ${where.join(", ")}`,
    };
  }

  const problems = piStructureProblems(parsed.data);
  if (problems.length > 0) {
    const where = Array.from(
      new Set(problems.slice(0, 8).map((problem) => `${problem.path} (${problem.code})`)),
    );
    return {
      ok: false,
      reason: "structure",
      detail: `the snapshot does not add up at: ${where.join(", ")}`,
    };
  }

  return { ok: true, snapshot: parsed.data, bytes };
}

/* ------------------------------------------------------------------ sidecar */

/**
 * A producer failure note left beside an artifact.
 *
 * Only `status: "failed"` is pinned, because contract v1 fixes the sidecar's
 * remaining fields no further than "a sanitized error class/reason and the
 * artifact currently present, never raw exception text". The hazard worth
 * guarding is the opposite of a missing field: a sidecar that cannot be read
 * must never be mistaken for the absence of a sidecar, or a failed export
 * would be presented as a fresh observation.
 */
const piStatusSidecarSchema = z
  .object({
    status: z.literal("failed"),
    error_class: labelSchema.optional(),
    reason: textSchema.optional(),
    artifact: labelSchema.nullable().optional(),
    artifact_age_seconds: z.number().finite().nullable().optional(),
    generated_at: instantSchema.nullable().optional(),
  })
  .loose();

export type PiStatusSidecar = z.infer<typeof piStatusSidecarSchema>;

export type PiSidecarRead =
  | { present: false }
  | { present: true; ok: true; sidecar: PiStatusSidecar }
  | { present: true; ok: false; reason: "too_large" | "not_json" | "schema" | "privacy" };

/** Reads a sidecar's text. A present-but-unreadable sidecar still means failed. */
export function parsePiStatusSidecar(text: string | null): PiSidecarRead {
  if (text === null) return { present: false };
  if (piUtf8Bytes(text) > PI_MAX_SNAPSHOT_BYTES) {
    return { present: true, ok: false, reason: "too_large" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { present: true, ok: false, reason: "not_json" };
  }
  const parsed = piStatusSidecarSchema.safeParse(raw);
  if (!parsed.success) return { present: true, ok: false, reason: "schema" };
  if (piPrivacyHits(parsed.data).length > 0) {
    return { present: true, ok: false, reason: "privacy" };
  }
  return { present: true, ok: true, sidecar: parsed.data };
}

/* ------------------------------------------------------------------ reading */

/**
 * Expected live cadence once a snapshot is actually placed and polling is
 * approved. Both are declared here so freshness has a stated meaning; this
 * task installs no timer and enables no polling.
 */
export const PI_TICK_SECONDS = 30;
export const PI_GRACE_SECONDS = 90;
/** Clocks disagree by a little; beyond this a timestamp is ahead, not fresh. */
export const PI_FUTURE_SKEW_SECONDS = 5;

export type PiFreshness =
  | { state: "fresh"; ageSeconds: number }
  | { state: "stale"; ageSeconds: number }
  | { state: "future"; aheadSeconds: number };

/**
 * Age comes from the snapshot's own `generated_at`, never from a file's
 * modification time: a producer that rewrites an old export, or a copy that
 * refreshes an mtime, must not look like a new observation.
 */
export function piFreshness(
  generatedAt: string,
  nowMs: number,
  graceSeconds = PI_GRACE_SECONDS,
): PiFreshness {
  const ms = instantMs(generatedAt);
  if (ms === null) return { state: "stale", ageSeconds: Infinity };
  const ageSeconds = (nowMs - ms) / 1000;
  if (ageSeconds < -PI_FUTURE_SKEW_SECONDS) {
    return { state: "future", aheadSeconds: -ageSeconds };
  }
  const age = Math.max(0, ageSeconds);
  return age > graceSeconds
    ? { state: "stale", ageSeconds: age }
    : { state: "fresh", ageSeconds: age };
}

export type PiReadingStatus =
  /** A valid snapshot, generated within the grace window. */
  | "ok"
  /** Valid, but older than the grace window: real figures, not current ones. */
  | "stale"
  /** Valid, but stamped ahead of this clock: not trusted as a fresh reading. */
  | "future"
  /** The approved owning host is unknown or not reachable. Not a zero. */
  | "unavailable"
  /** The owning host has no snapshot placed. Not a zero either. */
  | "missing"
  /** Present and refused. */
  | "invalid"
  /** The producer left a failure note for the artifact now on disk. */
  | "failed";

export interface PiReadingData {
  snapshot: PiUsageSnapshot;
  freshness: PiFreshness;
  /**
   * True whenever these figures are not a fresh verified observation — stale,
   * ahead of the clock, or retained from an earlier poll. Degraded data may be
   * shown, but never as current.
   */
  degraded: boolean;
  /** True when the figures are last-good rather than this poll's own read. */
  retained: boolean;
}

export interface PiReading {
  status: PiReadingStatus;
  /** A stable code for the panel to branch on. */
  reason: string;
  /** Sanitized wording: no paths, no identities, no exception text. */
  detail: string;
  /** Figures to display, or `null` when there are none. Never a zero stand-in. */
  data: PiReadingData | null;
  /** The producer's retry cleared a failure note that the last poll saw. */
  recoveredFromFailure: boolean;
}

/* --------------------------------------------------------------- read facts */

/**
 * What a confined read of the owning machine's export location found, once the
 * bytes have already been judged by this module.
 *
 * The split matters. The host entry owns the disk: it locates the one approved
 * file, refuses a symlink or an oversized one, and turns what it read into
 * these facts. The server owns the reading: it decides freshness against its
 * own clock and remembers what the last poll saw. Neither the host's clock nor
 * a file's modification time can therefore make an old export look current.
 */
export type PiArtifactFact =
  /** The owning machine has no snapshot placed. Not a zero. */
  | { state: "absent" }
  /** A snapshot that passed every check in this module. */
  | { state: "valid"; snapshot: PiUsageSnapshot; bytes: number }
  /**
   * A snapshot is present and may not be believed — refused by confinement
   * before any parse, or refused by the contract after one. The reason is a
   * stable code and the detail is fixed wording: neither carries a path, a
   * received value or raw exception text.
   */
  | { state: "refused"; reason: string; detail: string };

export type PiSidecarFact =
  /** No producer failure note — which is what a successful retry removes. */
  | { state: "absent" }
  /** The producer says its last export of this artifact failed. */
  | { state: "failed"; errorClass: string | null }
  /**
   * A note is present and cannot be read. Still a failure: mistaking it for an
   * absent note would present a failed export as a fresh observation.
   */
  | { state: "unreadable"; reason: string }
  /**
   * Whether a note is there at all could not be established. That is neither a
   * failure nor an absence: it may not be reported as the producer having
   * failed, and it may not clear a failure the last poll saw either, so the
   * figures beside it are never a fresh verified observation.
   */
  | { state: "unknown"; reason: string };

/** Text in, artifact fact out. */
export function piArtifactFactFromText(text: string): PiArtifactFact {
  const parsed = parsePiUsageSnapshot(text);
  return parsed.ok
    ? { state: "valid", snapshot: parsed.snapshot, bytes: parsed.bytes }
    : { state: "refused", reason: parsed.reason, detail: parsed.detail };
}

/** Text in, sidecar fact out. `null` means no note was found. */
export function piSidecarFactFromText(text: string | null): PiSidecarFact {
  const read = parsePiStatusSidecar(text);
  if (!read.present) return { state: "absent" };
  return read.ok
    ? { state: "failed", errorClass: read.sidecar.error_class ?? null }
    : { state: "unreadable", reason: read.reason };
}

export interface PiReadFacts {
  /**
   * What the owning machine's export location held. `undefined` means the
   * approved owning machine itself was not available, which is neither a
   * missing snapshot nor a zero.
   */
  artifact?: PiArtifactFact;
  /** The `<artifact>.status.json` note beside it. Absent when omitted. */
  sidecar?: PiSidecarFact;
  /** Last-good figures from an earlier poll, if the caller kept any. */
  retained?: PiUsageSnapshot | null;
  /** Why the owning machine could not be reached, when it could not. */
  unavailable?: { reason: string; detail: string };
  nowMs: number;
  graceSeconds?: number;
  /** Whether the previous poll saw a producer failure note. */
  failedBefore?: boolean;
}

function retainedData(
  snapshot: PiUsageSnapshot | null | undefined,
  nowMs: number,
  graceSeconds: number,
): PiReadingData | null {
  if (!snapshot) return null;
  return {
    snapshot,
    freshness: piFreshness(snapshot.generated_at, nowMs, graceSeconds),
    degraded: true,
    retained: true,
  };
}

/**
 * Turns one poll's facts into a reading.
 *
 * Every snapshot is a complete replacement dataset: nothing here adds a poll
 * to the last one, so polling the same artifact twice yields the same totals
 * and no call is ever billed again. The order of the checks is deliberate —
 * the owning machine first, then the producer's own failure note, then the
 * artifact — because a readable artifact beside a failure note may be an older
 * generation than the note refers to, and must not be shown as current.
 */
export function readPiUsageFacts(input: PiReadFacts): PiReading {
  const grace = input.graceSeconds ?? PI_GRACE_SECONDS;
  const sidecar: PiSidecarFact = input.sidecar ?? { state: "absent" };
  const recoveredFromFailure = input.failedBefore === true && sidecar.state === "absent";
  const artifact = input.artifact;

  if (artifact === undefined) {
    return {
      status: "unavailable",
      reason: input.unavailable?.reason ?? "owning_host_unavailable",
      detail:
        input.unavailable?.detail ??
        "the approved owning machine for Firstmate Pi is not available",
      data: retainedData(input.retained, input.nowMs, grace),
      recoveredFromFailure,
    };
  }

  if (sidecar.state === "failed" || sidecar.state === "unreadable") {
    // The note wins: the artifact on disk may predate the failed export.
    const current: PiReadingData | null =
      artifact.state === "valid"
        ? {
            snapshot: artifact.snapshot,
            freshness: piFreshness(artifact.snapshot.generated_at, input.nowMs, grace),
            degraded: true,
            retained: false,
          }
        : retainedData(input.retained, input.nowMs, grace);
    return {
      status: "failed",
      reason:
        sidecar.state === "failed"
          ? `producer_failed:${sidecar.errorClass ?? "unknown"}`
          : `producer_failed_note_unreadable:${sidecar.reason}`,
      detail:
        sidecar.state === "failed"
          ? "the producer reported that its last export failed; these figures are not current"
          : "the producer left a failure note this panel cannot read; these figures are not current",
      data: current,
      recoveredFromFailure: false,
    };
  }

  if (artifact.state === "absent") {
    return {
      status: "missing",
      reason: "snapshot_not_placed",
      detail: "no Firstmate Pi snapshot is placed on the approved owning machine",
      data: retainedData(input.retained, input.nowMs, grace),
      recoveredFromFailure,
    };
  }

  if (artifact.state === "refused") {
    return {
      status: "invalid",
      reason: `snapshot_rejected:${artifact.reason}`,
      detail: artifact.detail,
      data: retainedData(input.retained, input.nowMs, grace),
      recoveredFromFailure,
    };
  }

  const freshness = piFreshness(artifact.snapshot.generated_at, input.nowMs, grace);
  const status: PiReadingStatus =
    freshness.state === "fresh" ? "ok" : freshness.state === "stale" ? "stale" : "future";
  // A snapshot whose failure note could not even be looked for may be the
  // leftover of an export that failed, so it is shown as degraded.
  const noteUnknown = sidecar.state === "unknown";
  return {
    status,
    reason:
      status === "ok"
        ? noteUnknown
          ? `fresh_failure_note_unchecked:${sidecar.reason}`
          : "fresh"
        : status === "stale"
          ? "snapshot_older_than_grace"
          : "snapshot_generated_in_the_future",
    detail:
      status === "ok"
        ? noteUnknown
          ? "a Firstmate Pi snapshot whose producer failure note could not be checked"
          : "a verified Firstmate Pi snapshot"
        : status === "stale"
          ? "the last Firstmate Pi snapshot is older than the expected refresh window"
          : "the Firstmate Pi snapshot is stamped ahead of this machine's clock",
    data: {
      snapshot: artifact.snapshot,
      freshness,
      degraded: status !== "ok" || noteUnknown,
      retained: false,
    },
    recoveredFromFailure,
  };
}

export interface PiReadInput {
  /**
   * The snapshot's text, or `null` when the owning host has none placed.
   * `undefined` means the approved owning host itself was not available.
   */
  text?: string | null;
  /** The `<artifact>.status.json` text, or `null` when absent. */
  sidecarText?: string | null;
  /** Last-good figures from an earlier poll, if the panel kept any. */
  retained?: PiUsageSnapshot | null;
  /** Why the owning host could not be reached, when it could not. */
  unavailable?: { reason: string; detail: string };
  nowMs: number;
  graceSeconds?: number;
  /** Whether the previous poll saw a producer failure note. */
  failedBefore?: boolean;
}

/** The text-level convenience over {@link readPiUsageFacts}. */
export function readPiUsage(input: PiReadInput): PiReading {
  return readPiUsageFacts({
    artifact:
      input.text === undefined
        ? undefined
        : input.text === null
          ? { state: "absent" }
          : piArtifactFactFromText(input.text),
    sidecar: piSidecarFactFromText(input.sidecarText ?? null),
    retained: input.retained,
    unavailable: input.unavailable,
    nowMs: input.nowMs,
    graceSeconds: input.graceSeconds,
    failedBefore: input.failedBefore,
  });
}

/* ------------------------------------------------------------------- idle/0 */

/**
 * Whether a reading really means "Pi did no work", as opposed to any of the
 * ways a panel can fail to find out. Only a fresh, non-degraded snapshot whose
 * every declared source the producer itself verified as idle qualifies; a
 * missing file, a refused file, a failure note, a stale export, an unreadable
 * path or a partial coverage never does.
 */
export function piVerifiedIdleZero(reading: PiReading): boolean {
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

/**
 * Whether known spend is actually known.
 *
 * A sum of zero with no priced call is unknown spend, not a free hour, and the
 * panel must not round it into "$0.00 spent".
 */
export function piSpendIsKnown(amount: PiMoney): boolean {
  return amount.priced_calls > 0;
}

/** The exact recorded sum, as digits rather than a float. */
export function piExactCost(amount: PiMoney): PiDecimal {
  return piDecimal(amount.known_cost_usd_exact) ?? { units: 0n, scale: 0 };
}

/** Whether the producer's rounded figure agrees with its exact companion. */
export function piCostAgrees(amount: PiMoney): boolean {
  const exact = piDecimal(amount.known_cost_usd_exact);
  const rounded = piDecimal(amount.known_cost_usd);
  return exact !== null && rounded !== null && piDecimalEquals(exact, rounded);
}
