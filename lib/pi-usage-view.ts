/**
 * The Firstmate Pi lens, as a view model.
 *
 * Everything the page decides about a Pi reading is decided here: which lens
 * is selected, whether a reading may be shown as current, whether a zero is a
 * verified idle hour or an unknown, which rows a dimension has, what a money
 * cell says, and where a series point sits in time. The page component below
 * `components/pi-usage.tsx` only turns this into markup.
 *
 * The seam exists so the presentation decisions are executable: the test
 * runner strips types but cannot load JSX, so a decision left inside a `.tsx`
 * file could only be asserted by reading its source text, which proves
 * nothing. Here the real fixture — and every degraded reading the backend can
 * produce — goes through the actual interface the page renders from.
 *
 * Nothing in this file sums one dimension into another, converts recorded
 * money through a float, reprices anything, or invents a point the producer
 * did not emit.
 */

import {
  PI_FOLDED_MODEL,
  PI_FOLDED_ROW,
  PI_MAIN_UNASSIGNED,
  piExactCost,
  piFreshness,
  piHourOffset,
  piHourRfc3339,
  piSpendIsKnown,
  piVerifiedIdleZero,
} from "./pi-usage-shape";
// Types only: the page is handed a reading the server already validated, so
// nothing here imports the snapshot schemas into the browser bundle.
import type {
  PiAmount,
  PiCoverageStatus,
  PiMoney,
  PiReading,
  PiReadingStatus,
  PiTokens,
  PiUsageSnapshot,
} from "./pi-usage-contract";
import { piDecimalFixed, piDecimalIsZero, piDecimalText } from "./pi-usage-decimal";
import { formatTokenCount } from "./tokens";

/* --------------------------------------------------------------------- lens */

export const PI_LENS_NATIVE = "bb-native";
export const PI_LENS_PI = "firstmate-pi";

export type PiLens = typeof PI_LENS_NATIVE | typeof PI_LENS_PI;

export interface PiLensOption {
  id: PiLens;
  label: string;
  hint: string;
}

/**
 * The source selector. Two datasets, never merged: the native lens is BB's own
 * live, daily and subscription accounting, and the Pi lens is one external
 * producer's recorded snapshot. Pi figures never enter a native total and
 * native quota is never attributed to a Pi task.
 */
export const PI_LENSES: readonly PiLensOption[] = [
  {
    id: PI_LENS_NATIVE,
    label: "BB-native",
    hint: "BB's own token, throughput and subscription accounting",
  },
  {
    id: PI_LENS_PI,
    label: "Firstmate Pi",
    hint: "Recorded Firstmate Pi task usage, read from one machine as a separate dataset",
  },
];

export function piLensOption(lens: PiLens): PiLensOption {
  return PI_LENSES.find((option) => option.id === lens)!;
}

export function piLensIsNative(lens: PiLens): boolean {
  return lens === PI_LENS_NATIVE;
}

/* ----------------------------------------------------------------- duration */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * A duration in the coarsest useful unit. Written out here rather than taken
 * from a locale formatter so an age reads the same in a test as on a screen.
 */
export function piDurationText(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** `2026-10-01` as `Oct 1`, without asking a date parser or a locale. */
export function piDayLabel(day: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return day;
  const month = MONTHS[Number(parts[2]) - 1];
  return month ? `${month} ${Number(parts[3])}` : day;
}

/** `2026-10-01T22:50:00Z` as `22:50:00`, read off the identity itself. */
export function piClockLabel(instant: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(instant)
    ? instant.slice(11, 19)
    : instant;
}

/**
 * An offset-bearing hour identity as a label that keeps its offset, built from
 * the identity's own digits. Converting it to local time would make the two
 * repeated hours of a 25-hour DST day read as one.
 */
export function piHourLabel(hour: string): string {
  const rfc = piHourRfc3339(hour);
  const offset = piHourOffset(hour);
  if (rfc === null || offset === null) return hour;
  const day = piDayLabel(rfc.slice(0, 10));
  return `${day} ${rfc.slice(11, 13)}:00 ${offset === "Z" ? "UTC" : offset}`;
}

/* ---------------------------------------------------------------- money cell */

export type PiMoneyKind =
  /** At least one call carried a recorded cost: the sum means something. */
  | "known"
  /** Calls happened and none was priced: unknown spend, not a free hour. */
  | "unknown"
  /** No call at all, so there is no spend to know or to guess. */
  | "none";

export interface PiMoneyView {
  kind: PiMoneyKind;
  /** The figure to print, or `—` when there is no known amount to print. */
  text: string;
  /** The producer's exact digits, for a title attribute. Null when unknown. */
  exactText: string | null;
  /** Short wording for what the cell means. */
  note: string;
  calls: number;
  pricedCalls: number;
  missingCostCalls: number;
  invalidCostCalls: number;
  /** `1 of 3 calls priced · 2 missing a price`, or the no-call wording. */
  coverageText: string;
  /** True when some call's recorded cost was itself unusable. */
  hasInvalid: boolean;
}

/**
 * Recorded USD, rounded only here.
 *
 * Cents for anything a cent can show, and the producer's own six places below
 * that, so a fraction-of-a-cent call does not round away to `$0.00`.
 */
export function piUsdText(amount: PiMoney): string {
  const exact = piExactCost(amount);
  if (piDecimalIsZero(exact)) return "$0.00";
  const cents = piDecimalFixed(exact, 2);
  return cents === "0.00" ? `$${piDecimalFixed(exact, 6)}` : `$${cents}`;
}

export function piMoneyView(amount: PiMoney): PiMoneyView {
  const known = piSpendIsKnown(amount);
  const kind: PiMoneyKind = known ? "known" : amount.calls === 0 ? "none" : "unknown";
  const parts = [`${amount.priced_calls} of ${amount.calls} calls priced`];
  if (amount.missing_cost_calls > 0) {
    parts.push(`${amount.missing_cost_calls} missing a price`);
  }
  if (amount.invalid_cost_calls > 0) {
    parts.push(`${amount.invalid_cost_calls} with an unusable recorded cost`);
  }
  const coverageText = amount.calls === 0 ? "no recorded calls" : parts.join(" · ");
  return {
    kind,
    text: known ? piUsdText(amount) : "—",
    exactText: known ? piDecimalText(piExactCost(amount)) : null,
    note:
      kind === "known"
        ? "recorded API-equivalent estimate"
        : kind === "unknown"
          ? "unknown spend: no call carried a recorded cost"
          : "no recorded calls in this window",
    calls: amount.calls,
    pricedCalls: amount.priced_calls,
    missingCostCalls: amount.missing_cost_calls,
    invalidCostCalls: amount.invalid_cost_calls,
    coverageText,
    hasInvalid: amount.invalid_cost_calls > 0,
  };
}

/* --------------------------------------------------------------- token cell */

export interface PiTokensView {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** A possible subset of `output`. Never added to it. */
  reasoning: number;
  inputText: string;
  cacheReadText: string;
  cacheWriteText: string;
  outputText: string;
  reasoningText: string;
  /**
   * Input, cache read, cache write and output. Reasoning is deliberately not
   * part of this sum: it is a subset of output the producer reports beside it.
   */
  recorded: number;
  recordedText: string;
  /** Fields the producer could not read on some call in this row. */
  gaps: number;
}

export function piTokensView(tokens: PiTokens, gaps: number): PiTokensView {
  const recorded =
    tokens.input + tokens.cache_read + tokens.cache_write + tokens.output;
  return {
    input: tokens.input,
    cacheRead: tokens.cache_read,
    cacheWrite: tokens.cache_write,
    output: tokens.output,
    reasoning: tokens.reasoning,
    inputText: formatTokenCount(tokens.input),
    cacheReadText: formatTokenCount(tokens.cache_read),
    cacheWriteText: formatTokenCount(tokens.cache_write),
    outputText: formatTokenCount(tokens.output),
    reasoningText: formatTokenCount(tokens.reasoning),
    recorded,
    recordedText: formatTokenCount(recorded),
    gaps,
  };
}

/* --------------------------------------------------------------------- rows */

export interface PiRowView {
  /** The producer's own key, which is also a stable React key. */
  key: string;
  /** What to print for the row. Always the producer's key, never a guess. */
  label: string;
  /** A task title, or the two parts of a `task · role` work item. */
  sublabel: string | null;
  /** Approved HTTPS GitHub issue/PR links only. */
  links: readonly string[];
  /** An aggregate of rows past the limit, not a real task and not a thread. */
  folded: boolean;
  /** MAIN work the producer could not bind to a task. */
  unassigned: boolean;
  /** The `task` part of a work item, when the row is one. */
  taskPart: string | null;
  /** The `role` part of a work item, when the row is one. */
  rolePart: string | null;
  calls: number;
  tokens: PiTokensView;
  money: PiMoneyView;
}

export type PiDimensionId = "tasks" | "work_items" | "roles" | "requested_models";

export interface PiDimensionView {
  id: PiDimensionId;
  title: string;
  /** Why this table may not be added to the next one. */
  note: string;
  rows: readonly PiRowView[];
}

function row(
  key: string,
  amount: PiAmount,
  extra: Partial<PiRowView> = {},
): PiRowView {
  return {
    key,
    label: key,
    sublabel: null,
    links: [],
    folded: false,
    unassigned: key === PI_MAIN_UNASSIGNED,
    taskPart: null,
    rolePart: null,
    calls: amount.calls,
    tokens: piTokensView(amount.tokens, amount.token_field_gaps),
    money: piMoneyView(amount),
    ...extra,
  };
}

/** `demo-task · author` split back into its two parts, or nulls. */
export function piWorkItemParts(
  workItem: string,
): { taskPart: string; rolePart: string } | null {
  const at = workItem.indexOf(" · ");
  if (at <= 0) return null;
  const taskPart = workItem.slice(0, at);
  const rolePart = workItem.slice(at + 3);
  if (taskPart.length === 0 || rolePart.length === 0) return null;
  return { taskPart, rolePart };
}

function taskRows(snapshot: PiUsageSnapshot): PiRowView[] {
  const labels = new Map(snapshot.task_labels.map((label) => [label.task_key, label]));
  return snapshot.tasks.map((task) => {
    const label = labels.get(task.task_key);
    const folded = task.task_key === PI_FOLDED_ROW;
    return row(task.task_key, task, {
      folded,
      sublabel: folded
        ? "tasks folded past the producer's row limit"
        : task.task_key === PI_MAIN_UNASSIGNED
          ? "MAIN work with no proved task binding"
          : (label?.title ?? null),
      links: folded ? [] : (label?.urls ?? []),
    });
  });
}

function workItemRows(snapshot: PiUsageSnapshot): PiRowView[] {
  return snapshot.work_items.map((item) => {
    const folded = item.work_item === PI_FOLDED_ROW;
    const parts = folded ? null : piWorkItemParts(item.work_item);
    return row(item.work_item, item, {
      folded,
      taskPart: parts?.taskPart ?? null,
      rolePart: parts?.rolePart ?? null,
      sublabel: folded ? "work items folded past the producer's row limit" : null,
      unassigned: parts?.taskPart === PI_MAIN_UNASSIGNED,
    });
  });
}

function modelRows(snapshot: PiUsageSnapshot): PiRowView[] {
  return snapshot.requested_models.map((model) => {
    const folded = model.requested_model === PI_FOLDED_MODEL;
    return row(model.requested_model, model, {
      folded,
      sublabel: folded
        ? "models folded past the producer's row limit"
        : "requested identity; the served model is unknown",
    });
  });
}

function roleRows(snapshot: PiUsageSnapshot): PiRowView[] {
  return snapshot.roles.map((role) => row(role.role, role));
}

/* ----------------------------------------------------------------- coverage */

export type PiTone =
  /** A fresh, verified observation. The only state that may read as good. */
  | "ok"
  /** Real figures that are not a current verified observation. */
  | "degraded"
  /** No figures, or figures that may not be believed. */
  | "unavailable";

export interface PiCoverageCounter {
  id: string;
  label: string;
  value: number;
  /** Whether a non-zero value here means something was not read. */
  gap: boolean;
}

export interface PiCoverageSourceView {
  alias: string;
  status: PiCoverageStatus;
  statusLabel: string;
  tone: PiTone;
  entries: number;
  lastIngest: string | null;
}

export interface PiCoverageView {
  status: PiCoverageStatus;
  label: string;
  tone: PiTone;
  /** True when the producer itself says the window is only partly covered. */
  partial: boolean;
  /** True when any counter that means "not read" is non-zero. */
  hasGaps: boolean;
  declaredSources: number;
  counters: readonly PiCoverageCounter[];
  sources: readonly PiCoverageSourceView[];
  quarantined: number;
  warnings: readonly string[];
}

const COVERAGE_LABELS: Record<PiCoverageStatus, string> = {
  readable: "Readable",
  verified_idle_zero: "Idle claim not verified",
  unreadable: "Unreadable",
  never_ingested: "Never ingested",
  partial: "Partial",
  conflicting_binding: "Conflicting binding",
};

function coverageTone(status: PiCoverageStatus, verifiedIdleZero: boolean): PiTone {
  if (status === "verified_idle_zero") return verifiedIdleZero ? "ok" : "degraded";
  if (status === "readable") return "ok";
  if (status === "partial") return "degraded";
  return "unavailable";
}

function coverageView(snapshot: PiUsageSnapshot, verifiedIdleZero: boolean): PiCoverageView {
  const { coverage } = snapshot;
  const counters: PiCoverageCounter[] = [
    { id: "readable", label: "Readable sources", value: coverage.readable, gap: false },
    {
      id: "verified_idle_zero",
      label: verifiedIdleZero ? "Verified idle sources" : "Reported idle sources",
      value: coverage.verified_idle_zero,
      gap: false,
    },
    { id: "partial", label: "Partly read", value: coverage.partial, gap: true },
    { id: "unreadable", label: "Unreadable", value: coverage.unreadable, gap: true },
    {
      id: "unreadable_paths",
      label: "Unreadable locations",
      value: coverage.unreadable_paths,
      gap: true,
    },
    {
      id: "never_ingested",
      label: "Never ingested",
      value: coverage.never_ingested,
      gap: true,
    },
    {
      id: "conflicting_binding",
      label: "Conflicting binding",
      value: coverage.conflicting_binding,
      gap: true,
    },
    {
      id: "ambiguous_fork_entries",
      label: "Ambiguous fork entries",
      value: coverage.ambiguous_fork_entries,
      gap: true,
    },
    {
      id: "token_field_gaps",
      label: "Token field gaps",
      value: coverage.token_field_gaps,
      gap: true,
    },
    {
      id: "assistant_without_usage",
      label: "Responses without usage",
      value: coverage.assistant_without_usage,
      gap: true,
    },
    { id: "invalid_rows", label: "Skipped rows", value: coverage.invalid_rows, gap: true },
    {
      id: "pending_tails",
      label: "Pending tails",
      value: coverage.pending_tails,
      gap: true,
    },
  ];
  // A gap is something that was not read. A window the producer verified as
  // idle is not a gap — it is the one zero that is actually an observation.
  const hasGaps =
    counters.some((counter) => counter.gap && counter.value > 0) ||
    snapshot.quarantine.length > 0 ||
    coverageTone(coverage.status, verifiedIdleZero) !== "ok";
  return {
    status: coverage.status,
    label: coverage.status === "verified_idle_zero" && verifiedIdleZero
      ? "Verified idle" : COVERAGE_LABELS[coverage.status],
    tone: coverageTone(coverage.status, verifiedIdleZero),
    partial: coverage.status === "partial" || coverage.partial > 0,
    hasGaps,
    declaredSources: coverage.declared_sources,
    counters,
    sources: coverage.sources.map((source) => ({
      alias: source.alias,
      status: source.status,
      statusLabel: source.status === "verified_idle_zero" && verifiedIdleZero
        ? "Verified idle" : COVERAGE_LABELS[source.status],
      tone: coverageTone(source.status, verifiedIdleZero),
      entries: source.entries_in_window,
      lastIngest: source.last_ingest,
    })),
    quarantined: snapshot.quarantine.length,
    warnings: snapshot.warnings,
  };
}

/* ------------------------------------------------------------------- series */

export type PiSeriesId = "live" | "hours" | "days";

export interface PiPointView {
  /** The producer's own row identity, which is also the React key. */
  key: string;
  label: string;
  /** Where the point sits in time, normalized explicitly. */
  startMs: number;
  /** Half-open: the point covers `[startMs, endMs)`. */
  endMs: number;
  /** The offset an hour identity carries. Null for days and live bins. */
  offset: string | null;
  calls: number;
  tokens: PiTokensView;
  money: PiMoneyView;
}

export interface PiSeriesView {
  id: PiSeriesId;
  title: string;
  /** What a point is, and what a gap between points is not. */
  note: string;
  points: readonly PiPointView[];
  /** The time range the chart draws, half-open. Null when there is nothing. */
  domain: { startMs: number; endMs: number } | null;
  peakRecordedTokens: number;
  peakCalls: number;
  /** Live bins only: the declared bin width. */
  binSeconds: number | null;
  /** Live bins only: the window the producer says the bins cover. */
  covers: { startMs: number; endMs: number; text: string } | null;
  /** True when the series has fewer points than its range could hold. */
  hasGaps: boolean;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function peak(points: readonly PiPointView[], of: (point: PiPointView) => number) {
  return points.reduce((best, point) => Math.max(best, of(point)), 0);
}

function parseCovers(
  covers: string,
): { startMs: number; endMs: number; text: string } | null {
  const parts = covers.split("..");
  if (parts.length !== 2) return null;
  const startMs = Date.parse(parts[0]!);
  const endMs = Date.parse(parts[1]!);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    return null;
  }
  return { startMs, endMs, text: covers };
}

function seriesFrom(
  id: PiSeriesId,
  title: string,
  note: string,
  points: PiPointView[],
  options: {
    binSeconds?: number;
    covers?: { startMs: number; endMs: number; text: string } | null;
    slotMs: number;
  },
): PiSeriesView {
  const covers = options.covers ?? null;
  const domain =
    points.length === 0
      ? covers
        ? { startMs: covers.startMs, endMs: covers.endMs }
        : null
      : {
          startMs: Math.min(covers?.startMs ?? Infinity, points[0]!.startMs),
          endMs: Math.max(covers?.endMs ?? -Infinity, points.at(-1)!.endMs),
        };
  const slots =
    domain === null
      ? 0
      : Math.max(1, Math.round((domain.endMs - domain.startMs) / options.slotMs));
  return {
    id,
    title,
    note,
    points,
    domain,
    peakRecordedTokens: peak(points, (point) => point.tokens.recorded),
    peakCalls: peak(points, (point) => point.calls),
    binSeconds: options.binSeconds ?? null,
    covers,
    hasGaps: points.length < slots,
  };
}

function liveSeries(snapshot: PiUsageSnapshot): PiSeriesView {
  const width = snapshot.live_bins.bin_seconds * 1000;
  const points = snapshot.live_bins.bins.map((bin): PiPointView => {
    const startMs = Date.parse(bin.bin_start);
    return {
      key: bin.bin_start,
      label: piClockLabel(bin.bin_start),
      startMs,
      endMs: startMs + width,
      offset: null,
      calls: bin.calls,
      tokens: piTokensView(bin.tokens, bin.token_field_gaps),
      money: piMoneyView(bin),
    };
  });
  return seriesFrom(
    "live",
    `Last ${snapshot.live_bins.bin_seconds}-second bins`,
    "Each bin counts completed responses the producer recorded in it, not a streaming rate. An empty bin is a bin with no recorded completed response, which is not a verified idle source.",
    points,
    {
      binSeconds: snapshot.live_bins.bin_seconds,
      covers: parseCovers(snapshot.live_bins.covers),
      slotMs: width,
    },
  );
}

function hourSeries(snapshot: PiUsageSnapshot): PiSeriesView {
  const points = snapshot.hours.map((hour): PiPointView => {
    // The identity is offset-bearing and hour-precision, so it is normalized
    // explicitly rather than handed to a date parser as written.
    const startMs = Date.parse(piHourRfc3339(hour.hour) ?? "");
    return {
      key: hour.hour,
      label: piHourLabel(hour.hour),
      startMs,
      endMs: startMs + HOUR_MS,
      offset: piHourOffset(hour.hour),
      calls: hour.calls,
      tokens: piTokensView(hour.tokens, hour.token_field_gaps),
      money: piMoneyView(hour),
    };
  });
  return seriesFrom(
    "hours",
    "By hour",
    "Hours keep the offset the producer recorded them with, so a repeated local hour on a 25-hour day stays two points. Each hour covers [start, start+1h).",
    points,
    { slotMs: HOUR_MS },
  );
}

function daySeries(snapshot: PiUsageSnapshot): PiSeriesView {
  const points = snapshot.days.map((day): PiPointView => {
    const startMs = Date.parse(`${day.day}T00:00:00Z`);
    return {
      key: day.day,
      label: piDayLabel(day.day),
      startMs,
      endMs: startMs + DAY_MS,
      offset: null,
      calls: day.calls,
      tokens: piTokensView(day.tokens, day.token_field_gaps),
      money: piMoneyView(day),
    };
  });
  return seriesFrom(
    "days",
    "By day",
    "A day the producer emitted no row for is a day it recorded nothing in, which is not the same as a day it verified as idle.",
    points,
    { slotMs: DAY_MS },
  );
}

/**
 * Where a point sits inside its series' range, as two fractions of the width.
 *
 * The chart places a point by time rather than by its index, so a run of
 * minutes the producer emitted nothing for stays an empty stretch of axis
 * instead of being closed up into a neighbouring bar. The span is half-open:
 * `end` is where the next slot begins, not a second inside this one.
 */
export function piPointFraction(
  series: PiSeriesView,
  point: PiPointView,
): { start: number; end: number } | null {
  const domain = series.domain;
  if (domain === null) return null;
  const span = domain.endMs - domain.startMs;
  if (!(span > 0)) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    start: clamp((point.startMs - domain.startMs) / span),
    end: clamp((point.endMs - domain.startMs) / span),
  };
}

/* ------------------------------------------------------------------- status */

const STATUS_LABELS: Record<PiReadingStatus, string> = {
  ok: "Current",
  stale: "Stale export",
  future: "Stamped ahead of this clock",
  unavailable: "Owning machine unavailable",
  missing: "No snapshot placed",
  invalid: "Snapshot refused",
  failed: "Producer export failed",
};

export interface PiStatusView {
  status: PiReadingStatus;
  label: string;
  /** Fixed, sanitized wording from the backend. Never a path or an identity. */
  detail: string;
  reason: string;
  tone: PiTone;
  /** Figures are present but are not a current verified observation. */
  degraded: boolean;
  /** Figures are last-good from an earlier poll rather than this read. */
  retained: boolean;
  /** Whether there are any figures to draw at all. */
  hasFigures: boolean;
  /** The producer's retry cleared a failure note the last poll saw. */
  recoveredFromFailure: boolean;
  /** Age of the figures, from the snapshot's own `generated_at`. */
  ageSeconds: number | null;
  ageText: string | null;
  generatedAt: string | null;
  /** How far ahead of this clock the export is stamped, when it is. */
  aheadSeconds: number | null;
  /** One line a panel can show beside the badge. */
  summary: string;
}

/* --------------------------------------------------------------------- view */

export interface PiObservationView {
  basisText: string;
  lagSeconds: number;
  lagText: string;
  latestRecordedAt: string | null;
  /** The current context is not recorded, and a cache read is not it. */
  currentContextText: string;
  finality: string;
}

export interface PiCostView extends PiMoneyView {
  /** The producer's own wording for what this money is. */
  label: string;
  provenance: string;
  repricing: string;
  currency: string;
  /** Always null: the producer records no catalog, so nothing can reprice. */
  priceCatalogVersion: string | null;
}

export interface PiFiguresView {
  /** The producer's revision, so a reading can be traced to one export. */
  producerRevision: string;
  producerAlias: string;
  parserVersion: string;
  generatedAt: string;
  window: { start: string; end: string; timezone: string; text: string };
  cost: PiCostView;
  tokens: PiTokensView;
  /** The MAIN row the producer could not bind to a task. */
  mainUnassigned: PiRowView;
  dimensions: readonly PiDimensionView[];
  series: Record<PiSeriesId, PiSeriesView>;
  coverage: PiCoverageView;
  observation: PiObservationView;
  /** Pi's own statement that subscription quota is not its to report. */
  quotaNote: string;
  usageNote: string;
  modelIdentityNote: string;
  reasoningNote: string;
  inputNote: string;
}

export interface PiUsageView {
  status: PiStatusView;
  /**
   * Only a fresh, non-degraded, fully covered reading of a window the producer
   * verified as idle. Anything else that shows a zero shows it as unknown.
   */
  verifiedIdleZero: boolean;
  figures: PiFiguresView | null;
}

function statusSummary(
  status: PiReadingStatus,
  freshVerified: boolean,
  retained: boolean,
  partialCoverage: boolean,
  ageText: string | null,
): string {
  if (status === "ok" && freshVerified) {
    return ageText === null ? "Recorded by the producer" : `Recorded ${ageText} ago`;
  }
  if (retained) return "Last known figures from an earlier read, not a current one";
  if (status === "ok" && partialCoverage) {
    return ageText === null
      ? "Recorded, with part of the window not read"
      : `Recorded ${ageText} ago, with part of the window not read`;
  }
  if (status === "ok") return "Recorded, but not a current verified observation";
  if (status === "stale") {
    return ageText === null
      ? "Older than the expected export cadence"
      : `Exported ${ageText} ago, older than the expected cadence`;
  }
  if (status === "future") return "Stamped ahead of this machine's clock";
  return "No figures to show";
}

/**
 * The whole lens, from one reading.
 *
 * `null` is the state before the first answer arrives — not an absence of
 * usage. Every named backend state keeps its own identity here, and none of
 * them becomes a zero: a reading with no figures has `figures: null`, and a
 * reading with figures that are not current is marked degraded instead of
 * being drawn as if it were.
 */
export function piUsageView(reading: PiReading | null, nowMs: number): PiUsageView {
  if (reading === null) {
    return {
      status: {
        status: "unavailable",
        label: "Not read yet",
        detail: "The page has not received an answer for this source yet.",
        reason: "not_read_yet",
        tone: "unavailable",
        degraded: false,
        retained: false,
        hasFigures: false,
        recoveredFromFailure: false,
        ageSeconds: null,
        ageText: null,
        generatedAt: null,
        aheadSeconds: null,
        summary: "Waiting for the first read",
      },
      verifiedIdleZero: false,
      figures: null,
    };
  }

  const snapshot = reading.data?.snapshot ?? null;
  const freshness = snapshot ? piFreshness(snapshot.generated_at, nowMs) : null;
  const effectiveStatus = reading.status === "ok" || reading.status === "stale" || reading.status === "future"
    ? freshness?.state === "fresh" ? "ok" : freshness?.state === "future" ? "future" : "stale"
    : reading.status;
  reading = {
    ...reading,
    status: effectiveStatus,
    data: reading.data && freshness ? {
      ...reading.data,
      freshness,
      degraded: reading.data.degraded || freshness.state !== "fresh",
    } : null,
  };
  const data = reading.data;
  const ageSeconds =
    freshness === null
      ? null
      : freshness.state === "future"
        ? 0
        : Number.isFinite(freshness.ageSeconds)
          ? freshness.ageSeconds
          : null;
  const verifiedIdleZero = piVerifiedIdleZero(reading);
  const coverage = snapshot ? coverageView(snapshot, verifiedIdleZero) : null;
  const partialCoverage = coverage !== null && (coverage.partial || coverage.hasGaps);
  // Green is reserved: a fresh, first-hand reading whose coverage the producer
  // itself reports as complete. A partial window, a retained figure, a stale
  // or future stamp, or any failure state is not it.
  const freshVerified =
    reading.status === "ok" &&
    data !== null &&
    !data.degraded &&
    !data.retained &&
    freshness?.state === "fresh" &&
    !partialCoverage;

  const ageText = ageSeconds === null ? null : piDurationText(ageSeconds);
  const status: PiStatusView = {
    status: reading.status,
    label: STATUS_LABELS[reading.status],
    detail: reading.detail,
    reason: reading.reason,
    tone: freshVerified ? "ok" : data === null ? "unavailable" : "degraded",
    degraded: data?.degraded ?? false,
    retained: data?.retained ?? false,
    hasFigures: data !== null,
    recoveredFromFailure: reading.recoveredFromFailure,
    ageSeconds,
    ageText,
    generatedAt: snapshot?.generated_at ?? null,
    aheadSeconds: freshness?.state === "future" ? freshness.aheadSeconds : null,
    summary: statusSummary(
      reading.status,
      freshVerified,
      data?.retained ?? false,
      partialCoverage,
      ageText,
    ),
  };

  if (snapshot === null || coverage === null) {
    return { status, verifiedIdleZero: false, figures: null };
  }

  const figures: PiFiguresView = {
    producerRevision: snapshot.producer.revision,
    producerAlias: snapshot.producer.alias,
    parserVersion: snapshot.producer.parser_version,
    generatedAt: snapshot.generated_at,
    window: {
      start: snapshot.window.start,
      end: snapshot.window.end,
      timezone: snapshot.window.timezone,
      text: `${snapshot.window.start} … ${snapshot.window.end} (${snapshot.window.mode === "half_open" ? "half-open" : snapshot.window.mode}, ${snapshot.window.timezone})`,
    },
    cost: {
      ...piMoneyView(snapshot.cost),
      label: snapshot.cost.label,
      provenance: snapshot.cost.provenance,
      repricing: snapshot.cost.repricing,
      currency: snapshot.cost.currency,
      priceCatalogVersion: snapshot.cost.price_catalog_version,
    },
    tokens: piTokensView(snapshot.tokens, snapshot.cost.token_field_gaps),
    mainUnassigned: row(PI_MAIN_UNASSIGNED, snapshot.main_unassigned, {
      label: PI_MAIN_UNASSIGNED,
      sublabel: "MAIN work with no proved task binding",
      unassigned: true,
    }),
    dimensions: [
      {
        id: "tasks",
        title: "Tasks",
        note: "One row per task, with the author and No-Mistakes work on it already combined. `others` is a fold of the rows past the producer's limit, not a task and not a bb thread.",
        rows: taskRows(snapshot),
      },
      {
        id: "work_items",
        title: "Work items",
        note: "A work item is `task · role`. These rows are the same calls as the task rows, split differently — not extra usage to add on.",
        rows: workItemRows(snapshot),
      },
      {
        id: "roles",
        title: "Roles",
        note: "The same calls again, by the role that made them. A fixed set; an unrecorded role is `unknown`, never guessed.",
        rows: roleRows(snapshot),
      },
      {
        id: "requested_models",
        title: "Requested models",
        note: "The model each call asked for. The served model is not recorded, so nothing here proves which model answered, and no provider is inferred from a name. `other` is a fold of the rows past the limit.",
        rows: modelRows(snapshot),
      },
    ],
    series: {
      live: liveSeries(snapshot),
      hours: hourSeries(snapshot),
      days: daySeries(snapshot),
    },
    coverage,
    observation: {
      basisText:
        snapshot.observation.basis === "completed_assistant_responses"
          ? "completed responses the producer recorded"
          : snapshot.observation.basis,
      lagSeconds: snapshot.observation.lag_seconds,
      lagText: piDurationText(snapshot.observation.lag_seconds),
      latestRecordedAt: snapshot.observation.latest_recorded_at,
      currentContextText:
        "Current context is not recorded by the producer; a cache read is not the current context.",
      finality: snapshot.observation.finality,
    },
    quotaNote: snapshot.consumer.quota,
    usageNote: snapshot.consumer.usage,
    modelIdentityNote: snapshot.token_semantics.model_identity,
    reasoningNote: snapshot.token_semantics.reasoning,
    inputNote: snapshot.token_semantics.input,
  };

  return { status, verifiedIdleZero, figures };
}
