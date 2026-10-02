// Behavioural cover for what the Usage page actually shows on the Firstmate Pi
// lens: which rows a dimension has, what a money cell says, which zero is a
// verified observation and which is an unknown, where a point sits in time,
// and which badge may read as good.
//
// Every case here runs the real presentation interface the page renders from,
// over the approved producer fixture parsed by the real contract, or over a
// reading the backend can genuinely produce. Nothing inspects source text and
// nothing asserts a snapshot of markup.
//
// The page component itself is JSX, which this runner strips types for but
// cannot load, so the presentation decisions live in `lib/pi-usage-view.ts`
// and the component is markup over this model. That is the seam under test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
      }
      throw error;
    }
  },
});

const {
  PI_LENSES,
  PI_LENS_NATIVE,
  PI_LENS_PI,
  piDayLabel,
  piDurationText,
  piHourLabel,
  piLensIsNative,
  piLensOption,
  piMoneyView,
  piPointFraction,
  piTokensView,
  piUsageView,
  piUsdText,
  piWorkItemParts,
} = await import("../lib/pi-usage-view.ts");
const { isPiSafeLink, parsePiUsageSnapshot, readPiUsage } = await import(
  "../lib/pi-usage-contract.ts"
);

const here = dirname(fileURLToPath(import.meta.url));
const fixtureText = await readFile(
  join(here, "fixtures", "pi-usage-snapshot.json"),
  "utf8",
);
const fixture = JSON.parse(fixtureText);
const GENERATED_MS = Date.parse(fixture.generated_at);

/** A reading of some snapshot text, as the server would hand it to the page. */
function readingOf(text, nowMs = GENERATED_MS, extra = {}) {
  return readPiUsage({ text, nowMs, ...extra });
}

/** The fixture with a few fields replaced, re-serialized for a real parse. */
function variant(mutate) {
  const next = JSON.parse(fixtureText);
  mutate(next);
  return JSON.stringify(next);
}

/** A reading of a mutated fixture, refusing to proceed if it is not valid. */
function viewOf(text, nowMs = GENERATED_MS, extra = {}) {
  const parsed = parsePiUsageSnapshot(text);
  assert.equal(parsed.ok, true, `fixture variant was refused: ${parsed.reason ?? ""}`);
  return piUsageView(readingOf(text, nowMs, extra), nowMs);
}

const ZERO_TOKENS = {
  cache_read: 0,
  cache_write: 0,
  input: 0,
  output: 0,
  reasoning: 0,
};

/** A zeroed amount block, which every dimension row shares the shape of. */
function zeroAmount(extra = {}) {
  return {
    calls: 0,
    invalid_cost_calls: 0,
    known_cost_usd: "0.000000",
    known_cost_usd_exact: "0",
    missing_cost_calls: 0,
    priced_calls: 0,
    token_field_gaps: 0,
    tokens: { ...ZERO_TOKENS },
    ...extra,
  };
}

const view = piUsageView(readingOf(fixtureText), GENERATED_MS);

/* --------------------------------------------------------------- the lenses */

test("the source selector offers BB-native and Firstmate Pi, native first", () => {
  assert.deepEqual(
    PI_LENSES.map((option) => option.id),
    [PI_LENS_NATIVE, PI_LENS_PI],
  );
  assert.deepEqual(
    PI_LENSES.map((option) => option.label),
    ["BB-native", "Firstmate Pi"],
  );
  assert.equal(piLensIsNative(PI_LENS_NATIVE), true);
  assert.equal(piLensIsNative(PI_LENS_PI), false);
  assert.match(piLensOption(PI_LENS_PI).hint, /separate dataset/);
});

/* ------------------------------------------------------- the exact producer */

test("the approved fixture renders figures with every dimension present", () => {
  assert.equal(view.status.status, "ok");
  assert.equal(view.status.hasFigures, true);
  assert.notEqual(view.figures, null);
  assert.deepEqual(
    view.figures.dimensions.map((dimension) => dimension.id),
    ["tasks", "work_items", "roles", "requested_models"],
  );
  assert.equal(view.figures.producerAlias, "firstmate-pi");
  assert.equal(view.figures.parserVersion, "pi-usage-parser/2");
  assert.equal(
    view.figures.producerRevision,
    "b8770582bd78ed5d362750950f93756eec105c99",
  );
});

test("partial coverage never reads as a good, current observation", () => {
  // The fixture is fresh at its own generated_at and still only partly covers
  // its window, so the badge must not go green.
  assert.equal(view.status.status, "ok");
  assert.equal(view.figures.coverage.status, "partial");
  assert.equal(view.status.tone, "degraded");
  assert.equal(view.verifiedIdleZero, false);
  assert.match(view.status.summary, /part of the window not read/);
});

test("task rows carry the producer's keys, titles and approved links", () => {
  const tasks = view.figures.dimensions.find((d) => d.id === "tasks");
  assert.deepEqual(
    tasks.rows.map((row) => row.key),
    ["demo-task", "main_unassigned"],
  );
  const demo = tasks.rows[0];
  assert.equal(demo.label, "demo-task");
  assert.equal(demo.sublabel, "Synthetic producer contract");
  assert.deepEqual(demo.links, [
    "https://github.com/timafen-dev/agentic-engineering/issues/496",
  ]);
  assert.equal(demo.links.every(isPiSafeLink), true);
  assert.equal(demo.folded, false);
  assert.equal(demo.unassigned, false);
});

test("a task row already combines the author and No-Mistakes work on it", () => {
  const tasks = view.figures.dimensions.find((d) => d.id === "tasks");
  const work = view.figures.dimensions.find((d) => d.id === "work_items");
  const demo = tasks.rows.find((row) => row.key === "demo-task");
  const parts = work.rows.filter((row) => row.taskPart === "demo-task");
  assert.deepEqual(parts.map((row) => row.rolePart).sort(), ["author", "nm"]);
  // The task row is the sum of its own work items, not a figure to add to them.
  assert.equal(
    demo.calls,
    parts.reduce((total, row) => total + row.calls, 0),
  );
  assert.equal(
    demo.tokens.recorded,
    parts.reduce((total, row) => total + row.tokens.recorded, 0),
  );
});

test("MAIN work with no task stays unassigned in both views", () => {
  const tasks = view.figures.dimensions.find((d) => d.id === "tasks");
  const unassignedTask = tasks.rows.find((row) => row.key === "main_unassigned");
  assert.equal(unassignedTask.unassigned, true);
  assert.equal(unassignedTask.sublabel, "MAIN work with no proved task binding");
  assert.deepEqual(unassignedTask.links, []);

  assert.equal(view.figures.mainUnassigned.unassigned, true);
  assert.equal(view.figures.mainUnassigned.calls, 1);
  assert.equal(view.figures.mainUnassigned.tokens.recorded, 110);

  const work = view.figures.dimensions.find((d) => d.id === "work_items");
  const row = work.rows.find((item) => item.key === "main_unassigned · main");
  assert.equal(row.unassigned, true);
  assert.equal(row.taskPart, "main_unassigned");
  assert.equal(row.rolePart, "main");
});

test("work items split `task · role` without inventing a thread identity", () => {
  const work = view.figures.dimensions.find((d) => d.id === "work_items");
  assert.deepEqual(
    work.rows.map((row) => row.key),
    ["demo-task · author", "demo-task · nm", "main_unassigned · main"],
  );
  assert.deepEqual(piWorkItemParts("demo-task · author"), {
    taskPart: "demo-task",
    rolePart: "author",
  });
  assert.equal(piWorkItemParts("others"), null);
  assert.equal(piWorkItemParts(" · author"), null);
  // Nothing in a row claims a bb thread, event or provider.
  for (const row of work.rows) {
    assert.equal(Object.hasOwn(row, "threadId"), false);
    assert.equal(Object.hasOwn(row, "provider"), false);
  }
});

test("roles are the fixed five, in the producer's order, including zero rows", () => {
  const roles = view.figures.dimensions.find((d) => d.id === "roles");
  assert.deepEqual(
    roles.rows.map((row) => row.key),
    ["main", "supervisor", "author", "nm", "unknown"],
  );
  const supervisor = roles.rows.find((row) => row.key === "supervisor");
  assert.equal(supervisor.calls, 0);
  // No call at all is neither a known zero spend nor an unknown one.
  assert.equal(supervisor.money.kind, "none");
  assert.equal(supervisor.money.text, "—");
  assert.equal(supervisor.money.coverageText, "no recorded calls");
});

test("requested models stay requested, with no served or provider identity", () => {
  const models = view.figures.dimensions.find((d) => d.id === "requested_models");
  assert.deepEqual(
    models.rows.map((row) => row.key),
    ["claude-opus-5", "gpt-6.1-sol"],
  );
  for (const row of models.rows) {
    assert.match(row.sublabel, /served model is unknown/);
    assert.equal(Object.hasOwn(row, "provider"), false);
  }
  assert.match(view.figures.modelIdentityNote, /requested model only/);
  assert.match(models.note, /no provider is inferred from a name/);
});

test("the four dimensions are the same calls sliced four ways, never a sum", () => {
  const calls = view.figures.cost.calls;
  assert.equal(calls, 3);
  for (const dimension of view.figures.dimensions) {
    assert.equal(
      dimension.rows.reduce((total, row) => total + row.calls, 0),
      calls,
      `${dimension.id} should cover the same calls as the dataset`,
    );
    assert.match(dimension.note, /combined|not extra usage|same calls|fold/);
  }
  // The lens reports one dataset total, not the 12 calls four tables add to.
  assert.equal(view.figures.cost.calls, 3);
});

/* ------------------------------------------------------------------- money */

test("recorded USD is labelled an estimate, not an invoice or quota", () => {
  const cost = view.figures.cost;
  assert.equal(cost.kind, "known");
  assert.equal(cost.text, "$0.02");
  assert.equal(cost.exactText, "0.02");
  assert.equal(cost.currency, "USD");
  assert.equal(cost.provenance, "pi_recorded_usage_cost");
  assert.equal(cost.repricing, "none");
  assert.equal(cost.priceCatalogVersion, null);
  assert.match(cost.label, /not an invoice, a payment, or subscription quota/);
  assert.match(view.figures.quotaNote, /not Pi task attribution/);
});

test("a row with calls and no priced call is unknown spend, not a zero", () => {
  const models = view.figures.dimensions.find((d) => d.id === "requested_models");
  const unpriced = models.rows.find((row) => row.key === "gpt-6.1-sol");
  assert.equal(unpriced.calls, 2);
  assert.equal(unpriced.money.pricedCalls, 0);
  assert.equal(unpriced.money.kind, "unknown");
  assert.equal(unpriced.money.text, "—");
  assert.equal(unpriced.money.exactText, null);
  assert.match(unpriced.money.note, /unknown spend/);
  assert.equal(unpriced.money.coverageText, "0 of 2 calls priced · 2 missing a price");
});

test("a priced call that cost nothing is a known zero", () => {
  const known = viewOf(
    variant((snapshot) => {
      snapshot.requested_models[1] = {
        ...snapshot.requested_models[1],
        calls: 1,
        priced_calls: 1,
        missing_cost_calls: 0,
        invalid_cost_calls: 0,
        token_field_gaps: 0,
        known_cost_usd: "0.000000",
        known_cost_usd_exact: "0",
      };
    }),
  );
  const row = known.figures.dimensions
    .find((d) => d.id === "requested_models")
    .rows.find((item) => item.key === "gpt-6.1-sol");
  assert.equal(row.money.kind, "known");
  assert.equal(row.money.text, "$0.00");
  assert.equal(row.money.exactText, "0");
  assert.equal(row.money.coverageText, "1 of 1 calls priced");
});

test("a call whose recorded cost was unusable is reported, not hidden", () => {
  const invalid = viewOf(
    variant((snapshot) => {
      snapshot.requested_models[1] = {
        ...snapshot.requested_models[1],
        calls: 2,
        priced_calls: 0,
        missing_cost_calls: 1,
        invalid_cost_calls: 1,
      };
    }),
  );
  const row = invalid.figures.dimensions
    .find((d) => d.id === "requested_models")
    .rows.find((item) => item.key === "gpt-6.1-sol");
  assert.equal(row.money.hasInvalid, true);
  assert.equal(row.money.invalidCostCalls, 1);
  assert.match(row.money.coverageText, /1 with an unusable recorded cost/);
});

test("money rounds only for the screen, and a sub-cent sum survives it", () => {
  const amount = {
    calls: 1,
    invalid_cost_calls: 0,
    known_cost_usd: "0.000123",
    known_cost_usd_exact: "0.000123",
    missing_cost_calls: 0,
    priced_calls: 1,
    token_field_gaps: 0,
  };
  assert.equal(piUsdText(amount), "$0.000123");
  const cell = piMoneyView(amount);
  assert.equal(cell.text, "$0.000123");
  assert.equal(cell.exactText, "0.000123");

  // Above a cent, cents are enough, and the exact digits stay available.
  const bigger = piMoneyView({
    ...amount,
    known_cost_usd: "12.345678",
    known_cost_usd_exact: "12.3456784",
  });
  assert.equal(bigger.text, "$12.35");
  assert.equal(bigger.exactText, "12.3456784");
});

/* ------------------------------------------------------------------ tokens */

test("the four token fields stay separate and reasoning is never added in", () => {
  const tokens = view.figures.tokens;
  assert.equal(tokens.input, 280);
  assert.equal(tokens.cacheRead, 2170);
  assert.equal(tokens.cacheWrite, 0);
  assert.equal(tokens.output, 1080);
  assert.equal(tokens.reasoning, 520);
  assert.equal(tokens.recorded, 280 + 2170 + 0 + 1080);

  // Reasoning can grow to the whole of output without changing the total.
  const whole = piTokensView(
    { cache_read: 2170, cache_write: 0, input: 280, output: 1080, reasoning: 1080 },
    0,
  );
  assert.equal(whole.recorded, tokens.recorded);
  assert.match(view.figures.reasoningNote, /never added to output twice/);
});

test("the current context is unknown, and a cache read is not it", () => {
  assert.match(
    view.figures.observation.currentContextText,
    /cache read is not the current context/,
  );
  assert.equal(Object.hasOwn(view.figures.tokens, "currentContext"), false);
});

test("observation is completed responses with a stated lag, not streaming", () => {
  assert.match(view.figures.observation.basisText, /completed responses/);
  assert.equal(view.figures.observation.lagSeconds, 50821.865435);
  assert.equal(view.figures.observation.lagText, "14h 7m");
  assert.equal(view.figures.observation.latestRecordedAt, "2026-10-01T22:58:00Z");
  assert.equal(piDurationText(0), "0s");
  assert.equal(piDurationText(45), "45s");
  assert.equal(piDurationText(600), "10m");
  assert.equal(piDurationText(7200), "2h");
  assert.equal(piDurationText(90000), "1d 1h");
  assert.equal(piDurationText(Infinity), "unknown");
});

/* ------------------------------------------------------------------ series */

test("live bins are keyed by bin_start, ten seconds wide, placed by time", () => {
  const live = view.figures.series.live;
  assert.equal(live.binSeconds, 10);
  assert.deepEqual(
    live.points.map((point) => point.key),
    ["2026-10-01T22:50:00Z", "2026-10-01T22:55:00Z", "2026-10-01T22:58:00Z"],
  );
  assert.deepEqual(
    live.points.map((point) => point.label),
    ["22:50:00", "22:55:00", "22:58:00"],
  );
  for (const point of live.points) {
    assert.equal(point.endMs - point.startMs, 10_000);
  }
  // The chart's range is the window the producer says the bins cover.
  assert.equal(live.covers.text, "2026-10-01T22:45:00Z..2026-10-01T23:00:00Z");
  assert.equal(live.domain.startMs, Date.parse("2026-10-01T22:45:00Z"));
  assert.equal(live.domain.endMs, Date.parse("2026-10-01T23:00:00Z"));
  assert.equal(live.domain.endMs - live.domain.startMs, 15 * 60_000);

  // Points sit where their own time puts them, so the stretch the producer
  // recorded nothing in stays empty instead of closing up.
  const first = piPointFraction(live, live.points[0]);
  assert.equal(Number(first.start.toFixed(4)), Number((5 / 15).toFixed(4)));
  assert.equal(Number((first.end - first.start).toFixed(5)), Number((10 / 900).toFixed(5)));
  const second = piPointFraction(live, live.points[1]);
  assert.equal(Number(second.start.toFixed(4)), Number((10 / 15).toFixed(4)));
  assert.ok(second.start - first.end > 0.3, "the empty stretch must stay empty");
});

test("missing live bins are a lack of records, not a verified idle source", () => {
  const live = view.figures.series.live;
  assert.equal(live.hasGaps, true);
  assert.match(live.note, /not a verified idle source/);
  assert.match(live.note, /not a streaming rate/);
  assert.equal(view.verifiedIdleZero, false);
});

test("a fully recorded fifteen minutes is ninety bins with no gap", () => {
  const text = variant((snapshot) => {
    const start = Date.parse("2026-10-01T22:45:00Z");
    snapshot.live_bins.bins = Array.from({ length: 90 }, (_, index) =>
      zeroAmount({ bin_start: new Date(start + index * 10_000).toISOString() }),
    );
  });
  const full = viewOf(text);
  assert.equal(full.figures.series.live.points.length, 90);
  assert.equal(full.figures.series.live.hasGaps, false);
});

test("hour identities keep their offset and stay distinct across a DST repeat", () => {
  const dst = viewOf(
    variant((snapshot) => {
      const base = snapshot.hours[0];
      snapshot.hours = [
        { ...base, hour: "2026-10-26T02+02:00" },
        { ...base, hour: "2026-10-26T02+01:00" },
      ];
    }),
  );
  const hours = dst.figures.series.hours;
  assert.deepEqual(
    hours.points.map((point) => point.key),
    ["2026-10-26T02+02:00", "2026-10-26T02+01:00"],
  );
  assert.deepEqual(
    hours.points.map((point) => point.offset),
    ["+02:00", "+01:00"],
  );
  // The same local hour, an hour apart in real time, and two distinct points.
  assert.equal(hours.points[0].startMs, Date.parse("2026-10-26T00:00:00Z"));
  assert.equal(hours.points[1].startMs, Date.parse("2026-10-26T01:00:00Z"));
  assert.equal(hours.points[1].startMs - hours.points[0].startMs, 3_600_000);
  assert.notEqual(hours.points[0].label, hours.points[1].label);
  assert.match(hours.points[0].label, /\+02:00/);
  assert.match(hours.points[1].label, /\+01:00/);
  // Half-open: an hour ends where the next one could begin.
  assert.equal(hours.points[0].endMs, hours.points[1].startMs);
});

test("a UTC hour is normalized explicitly rather than parsed as written", () => {
  const hours = view.figures.series.hours;
  assert.equal(hours.points[0].key, "2026-10-01T22+00:00");
  assert.equal(hours.points[0].offset, "+00:00");
  assert.equal(hours.points[0].startMs, Date.parse("2026-10-01T22:00:00Z"));
  assert.equal(piHourLabel("2026-10-01T22+00:00"), "Oct 1 22:00 +00:00");
  assert.equal(piHourLabel("2026-10-01T22Z"), "Oct 1 22:00 UTC");
  assert.equal(piHourLabel("not-an-hour"), "not-an-hour");
});

test("days read as days, with a missing day not implying an idle day", () => {
  const days = view.figures.series.days;
  assert.deepEqual(
    days.points.map((point) => point.key),
    ["2026-10-01"],
  );
  assert.equal(days.points[0].label, "Oct 1");
  assert.equal(days.points[0].endMs - days.points[0].startMs, 86_400_000);
  assert.equal(days.points[0].calls, 3);
  assert.equal(days.points[0].money.text, "$0.02");
  assert.match(days.note, /not the same as a day it verified as idle/);
  assert.equal(piDayLabel("2026-12-31"), "Dec 31");
  assert.equal(piDayLabel("broken"), "broken");
});

test("an empty series draws nothing rather than a zero line", () => {
  const empty = viewOf(
    variant((snapshot) => {
      snapshot.days = [];
      snapshot.hours = [];
      snapshot.live_bins.bins = [];
    }),
  );
  assert.deepEqual(empty.figures.series.days.points, []);
  assert.equal(empty.figures.series.days.domain, null);
  assert.equal(empty.figures.series.hours.domain, null);
  // The live range is still known, because the producer declares it.
  assert.notEqual(empty.figures.series.live.domain, null);
  assert.equal(empty.figures.series.live.points.length, 0);
  assert.equal(empty.verifiedIdleZero, false);
  assert.equal(
    piPointFraction(empty.figures.series.days, {
      key: "x",
      label: "x",
      startMs: 0,
      endMs: 1,
      offset: null,
      calls: 0,
      tokens: piTokensView(ZERO_TOKENS, 0),
      money: piMoneyView(zeroAmount()),
    }),
    null,
  );
});

/* ---------------------------------------------------------------- coverage */

test("coverage counters name what was not read, and flag it as a gap", () => {
  const coverage = view.figures.coverage;
  assert.equal(coverage.status, "partial");
  assert.equal(coverage.label, "Partial");
  assert.equal(coverage.tone, "degraded");
  assert.equal(coverage.partial, true);
  assert.equal(coverage.hasGaps, true);
  assert.equal(coverage.declaredSources, 3);
  const gaps = coverage.counters.find((counter) => counter.id === "token_field_gaps");
  assert.equal(gaps.value, 1);
  assert.equal(gaps.gap, true);
  assert.deepEqual(
    coverage.sources.map((source) => source.alias),
    ["S01", "S02", "S03"],
  );
  for (const source of coverage.sources) {
    assert.equal(source.statusLabel, "Readable");
    assert.equal(source.entries, 1);
    assert.equal(source.tone, "ok");
  }
});

test("a conflicting binding or an unreadable source is not a degraded nicety", () => {
  const broken = viewOf(
    variant((snapshot) => {
      snapshot.coverage.status = "unreadable";
      snapshot.coverage.unreadable = 1;
      snapshot.coverage.readable = 2;
      snapshot.coverage.sources[0].status = "conflicting_binding";
    }),
  );
  assert.equal(broken.figures.coverage.tone, "unavailable");
  assert.equal(broken.figures.coverage.sources[0].tone, "unavailable");
  assert.equal(broken.figures.coverage.sources[0].statusLabel, "Conflicting binding");
  assert.equal(broken.status.tone, "degraded");
  assert.equal(broken.verifiedIdleZero, false);
});

/** Coverage with every counter clean, so one signal can be tested alone. */
function clearCoverage(snapshot) {
  snapshot.coverage = {
    ...snapshot.coverage,
    status: "readable",
    readable: 3,
    verified_idle_zero: 0,
    partial: 0,
    unreadable: 0,
    unreadable_paths: 0,
    never_ingested: 0,
    conflicting_binding: 0,
    ambiguous_fork_entries: 0,
    token_field_gaps: 0,
    assistant_without_usage: 0,
    invalid_rows: 0,
    pending_tails: 0,
  };
  snapshot.quarantine = [];
}

test("a declared partial status is a gap even when every counter is clean", () => {
  const stated = viewOf(
    variant((snapshot) => {
      clearCoverage(snapshot);
      snapshot.coverage.status = "partial";
    }),
  );
  assert.equal(stated.figures.coverage.hasGaps, true);
  assert.equal(stated.figures.coverage.partial, true);
  assert.equal(stated.status.tone, "degraded");

  // The same reading with nothing unread at all is the one that may be green.
  const clean = viewOf(variant(clearCoverage));
  assert.equal(clean.figures.coverage.hasGaps, false);
  assert.equal(clean.status.tone, "ok");
  assert.match(clean.status.summary, /^Recorded 0s ago$/);
});

test("one quarantined record alone keeps the reading off a clean badge", () => {
  const held = viewOf(
    variant((snapshot) => {
      clearCoverage(snapshot);
      snapshot.quarantine = [{ source: "S04", ordinal: 7 }];
    }),
  );
  assert.equal(held.figures.coverage.quarantined, 1);
  assert.equal(held.figures.coverage.hasGaps, true);
  assert.equal(held.status.tone, "degraded");
});

test("a single unreadable location alone is a gap", () => {
  const unread = viewOf(
    variant((snapshot) => {
      clearCoverage(snapshot);
      snapshot.coverage.unreadable_paths = 1;
    }),
  );
  assert.equal(unread.figures.coverage.hasGaps, true);
  assert.equal(unread.status.tone, "degraded");
  const counter = unread.figures.coverage.counters.find(
    (item) => item.id === "unreadable_paths",
  );
  assert.equal(counter.value, 1);
  assert.equal(counter.gap, true);
});

test("quarantined records are reported as a coverage gap, never as spend", () => {
  const quarantined = viewOf(
    variant((snapshot) => {
      snapshot.quarantine = [{ source: "S04", ordinal: 7, reason: "unparsable row" }];
    }),
  );
  assert.equal(quarantined.figures.coverage.quarantined, 1);
  assert.equal(quarantined.figures.coverage.hasGaps, true);
  assert.equal(quarantined.figures.cost.text, "$0.02");
});

/* -------------------------------------------------- the states and the zero */

test("a verified idle window is the one zero that is an observation", () => {
  const idleText = variant((snapshot) => {
    snapshot.coverage = {
      ...snapshot.coverage,
      status: "verified_idle_zero",
      readable: 0,
      verified_idle_zero: 3,
      token_field_gaps: 0,
      sources: snapshot.coverage.sources.map((source) => ({
        ...source,
        status: "verified_idle_zero",
        entries_in_window: 0,
      })),
    };
    snapshot.cost = {
      ...snapshot.cost,
      calls: 0,
      priced_calls: 0,
      missing_cost_calls: 0,
      invalid_cost_calls: 0,
      known_cost_usd: "0.000000",
      known_cost_usd_exact: "0",
      token_field_gaps: 0,
    };
    snapshot.tokens = { ...ZERO_TOKENS };
    snapshot.tasks = [];
    snapshot.task_labels = [];
    snapshot.work_items = [];
    snapshot.requested_models = [];
    snapshot.roles = snapshot.roles.map((role) => zeroAmount({ role: role.role }));
    snapshot.main_unassigned = zeroAmount();
    snapshot.days = [];
    snapshot.hours = [];
    snapshot.live_bins.bins = [];
    snapshot.observation = {
      ...snapshot.observation,
      lag_seconds: 0,
      latest_recorded_at: null,
    };
  });
  const idle = viewOf(idleText);
  assert.equal(idle.status.status, "ok");
  assert.equal(idle.verifiedIdleZero, true);
  assert.equal(idle.status.tone, "ok");
  assert.equal(idle.figures.coverage.hasGaps, false);
  assert.equal(idle.figures.coverage.label, "Verified idle");
  assert.equal(idle.figures.coverage.tone, "ok");
  const contradictions = [
    (snapshot) => { snapshot.coverage.pending_tails = 1; },
    (snapshot) => { snapshot.quarantine = [{ source: "S01", ordinal: 1 }]; },
    (snapshot) => { snapshot.coverage.sources[0].status = "readable"; },
    (snapshot) => { snapshot.coverage.sources[0].entries_in_window = 1; },
    ...["input", "output", "cache_read", "cache_write", "reasoning"].map((field) => (snapshot) => {
      snapshot.tokens[field] = 1;
      if (field === "reasoning") snapshot.tokens.output = 1;
    }),
    ...[
      ["tasks", "task_key", "demo"], ["requested_models", "requested_model", "model"],
      ["work_items", "work_item", "demo · author"], ["days", "day", "2026-10-01"],
      ["hours", "hour", "2026-10-01T22+00:00"], ["live", "bin_start", "2026-10-01T22:50:00Z"],
      ["roles", "role", "main"], ["main_unassigned", null, null],
    ].flatMap(([dimension, key, identity]) => ["calls", "tokens"].map((kind) => (snapshot) => {
      const amount = zeroAmount(key ? { [key]: identity } : {});
      if (kind === "calls") { amount.calls = 1; amount.missing_cost_calls = 1; }
      else amount.tokens.input = 1;
      if (dimension === "main_unassigned") snapshot.main_unassigned = amount;
      else if (dimension === "roles") snapshot.roles[0] = amount;
      else if (dimension === "live") snapshot.live_bins.bins = [amount];
      else snapshot[dimension] = [amount];
    })),
  ];
  for (const mutate of contradictions) {
    const snapshot = JSON.parse(idleText);
    mutate(snapshot);
    const contradicted = viewOf(JSON.stringify(snapshot));
    assert.equal(contradicted.status.status, "ok");
    assert.equal(contradicted.verifiedIdleZero, false);
    assert.notEqual(contradicted.figures.coverage.tone, "ok");
    assert.notEqual(contradicted.status.tone, "ok");
    assert.notEqual(contradicted.figures.coverage.label, "Verified idle");
    assert.ok(contradicted.figures.coverage.sources.every((source) => source.statusLabel !== "Verified idle"));
    assert.ok(contradicted.figures.coverage.counters.every((counter) => counter.label !== "Verified idle sources"));
  }
  assert.equal(idle.figures.cost.kind, "none");
  assert.equal(idle.figures.cost.text, "—");
  assert.equal(idle.figures.tokens.recorded, 0);
  for (const dimension of idle.figures.dimensions) {
    if (dimension.id === "roles") continue;
    assert.deepEqual(dimension.rows, []);
  }

  const late = piUsageView(
    readingOf(idleText, GENERATED_MS),
    Date.parse(fixture.generated_at) + 10 * 60_000,
  );
  assert.equal(late.status.status, "stale");
  assert.equal(late.verifiedIdleZero, false);
  assert.notEqual(late.status.tone, "ok");
  assert.notEqual(late.figures.coverage.label, "Verified idle");
  assert.notEqual(late.figures.coverage.tone, "ok");
});

test("a stale export shows real figures that are explicitly not current", () => {
  const nowMs = GENERATED_MS + 10 * 60_000;
  const stale = piUsageView(readingOf(fixtureText, nowMs), nowMs);
  assert.equal(stale.status.status, "stale");
  assert.equal(stale.status.label, "Stale export");
  assert.equal(stale.status.degraded, true);
  assert.equal(stale.status.retained, false);
  assert.equal(stale.status.tone, "degraded");
  assert.equal(stale.status.ageText, "10m");
  assert.match(stale.status.summary, /older than the expected cadence/);
  // The figures themselves are unchanged: stale is about age, not content.
  assert.equal(stale.figures.cost.text, "$0.02");
  assert.equal(stale.figures.tokens.recorded, view.figures.tokens.recorded);
});

test("an export stamped ahead of this clock is not trusted as fresh", () => {
  const nowMs = GENERATED_MS - 60_000;
  const future = piUsageView(readingOf(fixtureText, nowMs), nowMs);
  assert.equal(future.status.status, "future");
  assert.equal(future.status.tone, "degraded");
  assert.equal(Math.round(future.status.aheadSeconds), 60);
  assert.equal(future.status.ageSeconds, 0);
  assert.match(future.status.summary, /ahead of this machine's clock/);
});

test("each backend state keeps its own identity, and none becomes a zero", () => {
  const cases = [
    { reading: readPiUsage({ text: null, nowMs: GENERATED_MS }), status: "missing" },
    { reading: readPiUsage({ nowMs: GENERATED_MS }), status: "unavailable" },
    { reading: readPiUsage({ text: "{]", nowMs: GENERATED_MS }), status: "invalid" },
    {
      reading: readPiUsage({
        text: fixtureText,
        sidecarText: JSON.stringify({
          kind: "pi_usage_status",
          status: "failed",
          error_class: "ExportError",
        }),
        nowMs: GENERATED_MS,
      }),
      status: "failed",
    },
  ];
  const labels = new Set();
  for (const item of cases) {
    const state = piUsageView(item.reading, GENERATED_MS);
    assert.equal(state.status.status, item.status);
    assert.equal(state.verifiedIdleZero, false);
    assert.notEqual(state.status.tone, "ok");
    assert.ok(state.status.detail.length > 0);
    labels.add(state.status.label);
    if (item.status === "failed") {
      // A failure note outranks the artifact beside it: figures may be drawn,
      // but never as a current observation.
      assert.notEqual(state.figures, null);
      assert.equal(state.status.degraded, true);
      assert.equal(state.status.tone, "degraded");
    } else {
      assert.equal(state.figures, null);
      assert.equal(state.status.hasFigures, false);
      assert.equal(state.status.tone, "unavailable");
    }
  }
  assert.equal(labels.size, 4, "each state needs its own wording");
});

test("retained last-good figures are shown as last known, never as current", () => {
  const { snapshot } = parsePiUsageSnapshot(fixtureText);
  const nowMs = GENERATED_MS + 5 * 60_000;
  const retained = piUsageView(
    readPiUsage({ text: "{]", retained: snapshot, nowMs }),
    nowMs,
  );
  assert.equal(retained.status.status, "invalid");
  assert.equal(retained.status.retained, true);
  assert.equal(retained.status.degraded, true);
  assert.equal(retained.status.tone, "degraded");
  assert.match(retained.status.summary, /Last known figures/);
  assert.notEqual(retained.figures, null);
  assert.equal(retained.figures.cost.text, "$0.02");
  assert.equal(retained.verifiedIdleZero, false);
});

test("the producer's cleared failure note is reported as a recovery", () => {
  const recovered = piUsageView(
    readPiUsage({ text: fixtureText, nowMs: GENERATED_MS, failedBefore: true }),
    GENERATED_MS,
  );
  assert.equal(recovered.status.recoveredFromFailure, true);
  assert.equal(recovered.status.status, "ok");

  const notRecovered = piUsageView(
    readPiUsage({ nowMs: GENERATED_MS, failedBefore: true }),
    GENERATED_MS,
  );
  assert.equal(notRecovered.status.recoveredFromFailure, false);
});

test("before the first answer the lens is unread, which is not an idle zero", () => {
  const initial = piUsageView(null, GENERATED_MS);
  assert.equal(initial.figures, null);
  assert.equal(initial.verifiedIdleZero, false);
  assert.equal(initial.status.tone, "unavailable");
  assert.equal(initial.status.label, "Not read yet");
  assert.equal(initial.status.ageText, null);
  assert.match(initial.status.summary, /Waiting for the first read/);
});

/* --------------------------------------------------------- repeat and leaks */

test("reading the same export twice gives exactly the same figures", () => {
  const again = piUsageView(readingOf(fixtureText), GENERATED_MS);
  assert.deepEqual(again, view);
  assert.equal(again.figures.cost.text, view.figures.cost.text);
  assert.equal(again.figures.tokens.recorded, view.figures.tokens.recorded);
  // A third read of the same bytes still totals the same dataset, because a
  // snapshot replaces the last one rather than accruing onto it.
  const third = piUsageView(readingOf(fixtureText), GENERATED_MS);
  assert.equal(third.figures.cost.calls, 3);
  assert.equal(third.figures.tokens.recorded, 3530);
});

test("nothing a path, an identity or an exception could ride into the view", () => {
  const readings = [
    readingOf(fixtureText),
    readPiUsage({ text: "{]", nowMs: GENERATED_MS }),
    readPiUsage({ nowMs: GENERATED_MS }),
    readPiUsage({ text: null, nowMs: GENERATED_MS }),
  ];
  for (const reading of readings) {
    const text = JSON.stringify(piUsageView(reading, GENERATED_MS));
    assert.doesNotMatch(text, /\/home\/|\/Users\/|\/root\/|~\//);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9-]{8,}|bearer |access_token|api[_-]?key/i);
    assert.doesNotMatch(text, /Traceback|SyntaxError|JSON\.parse/);
  }
});

test("only approved GitHub links ever reach a row", () => {
  for (const dimension of view.figures.dimensions) {
    for (const row of dimension.rows) {
      for (const link of row.links) {
        assert.equal(isPiSafeLink(link), true, link);
        assert.match(link, /^https:\/\/github\.com\//);
      }
    }
  }
});

/* ------------------------------------------------------------ folded rows */

test("folded rows use the producer's own spelling and claim no identity", () => {
  const folded = viewOf(
    variant((snapshot) => {
      snapshot.tasks.push(zeroAmount({ task_key: "others", calls: 0 }));
      snapshot.work_items.push(zeroAmount({ work_item: "others" }));
      snapshot.requested_models.push(zeroAmount({ requested_model: "other" }));
    }),
  );
  const byId = Object.fromEntries(
    folded.figures.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const foldedTask = byId.tasks.rows.find((row) => row.key === "others");
  const foldedWork = byId.work_items.rows.find((row) => row.key === "others");
  const foldedModel = byId.requested_models.rows.find((row) => row.key === "other");
  for (const row of [foldedTask, foldedWork, foldedModel]) {
    assert.equal(row.folded, true);
    assert.deepEqual(row.links, []);
    assert.equal(row.unassigned, false);
    assert.match(row.sublabel, /folded past the producer's row limit/);
  }
  assert.equal(foldedWork.taskPart, null);
  assert.equal(foldedWork.rolePart, null);
});
