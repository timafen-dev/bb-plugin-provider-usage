// Behavioural cover for the Firstmate Pi snapshot adapter.
//
// Everything here drives the public adapter interface over the exact synthetic
// producer fixture in test/fixtures/pi-usage-snapshot.json, which is a
// byte-for-byte copy of the approved consumer contract artifact. No test reads
// the implementation's source text; each one states a behaviour the panel
// depends on and would notice losing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
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
  PI_FOLDED_MODEL,
  PI_FOLDED_ROW,
  PI_GRACE_SECONDS,
  PI_MAIN_UNASSIGNED,
  PI_MAX_SNAPSHOT_BYTES,
  PI_ROLES,
  isPiSafeLink,
  parsePiUsageSnapshot,
  piCostAgrees,
  piExactCost,
  piFreshness,
  piHourInstantMs,
  piHourOffset,
  piHourRfc3339,
  piSpendIsKnown,
  piVerifiedIdleZero,
  readPiUsage,
} = await import("../lib/pi-usage-contract.ts");

const { piDecimal, piDecimalAdd, piDecimalEquals, piDecimalFixed, piDecimalText } =
  await import("../lib/pi-usage-decimal.ts");

/** The approved artifact, exactly as the producer emitted it. */
const FIXTURE_BYTES = 10836;
const FIXTURE_SHA256 =
  "e3085412e928273825523b3d034d3794c1505c56bac2ca051c738d791391f6a0";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi-usage-snapshot.json",
);
const fixtureText = await readFile(fixturePath, "utf8");

/** A fresh mutable copy, so one test cannot leak into the next. */
const clone = () => JSON.parse(fixtureText);

/** Accepts a mutated snapshot and returns the verdict. */
const parseObject = (snapshot) => parsePiUsageSnapshot(JSON.stringify(snapshot));

/** The snapshot as the adapter accepts it, for tests that need the typed shape. */
const accepted = () => {
  const verdict = parsePiUsageSnapshot(fixtureText);
  assert.equal(verdict.ok, true);
  return verdict.snapshot;
};

const generatedAtMs = Date.parse(accepted().generated_at);

const zeroAmount = () => ({
  calls: 0,
  invalid_cost_calls: 0,
  known_cost_usd: "0.000000",
  known_cost_usd_exact: "0",
  missing_cost_calls: 0,
  priced_calls: 0,
  token_field_gaps: 0,
  tokens: { cache_read: 0, cache_write: 0, input: 0, output: 0, reasoning: 0 },
});

const row = (key, value, extra = {}) => ({ ...zeroAmount(), [key]: value, ...extra });

const find = (rows, key, value) => {
  const found = rows.find((candidate) => candidate[key] === value);
  assert.ok(found, `expected a row where ${key} is ${value}`);
  return found;
};

/* ------------------------------------------------- the fixture is the contract */

test("the tracked fixture is the exact approved producer artifact", () => {
  assert.equal(Buffer.byteLength(fixtureText, "utf8"), FIXTURE_BYTES);
  assert.equal(
    createHash("sha256").update(fixtureText, "utf8").digest("hex"),
    FIXTURE_SHA256,
  );
});

test("the approved snapshot is accepted, with its pinned producer identity", () => {
  const verdict = parsePiUsageSnapshot(fixtureText);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.bytes, FIXTURE_BYTES);
  assert.deepEqual(verdict.snapshot.producer, {
    alias: "firstmate-pi",
    ledger_schema_version: 2,
    parser_version: "pi-usage-parser/2",
    revision: "b8770582bd78ed5d362750950f93756eec105c99",
    source_schema_version: "pi-session-jsonl/1",
  });
  assert.equal(verdict.snapshot.schema_version, 1);
  assert.equal(verdict.snapshot.kind, "pi_usage_snapshot");
});

test("Pi is a source harness, not a provider identity, and nothing else is invented", () => {
  const snapshot = accepted();
  // The requested model is the requested identity; the served model is unknown.
  assert.match(snapshot.token_semantics.model_identity, /requested model only/);
  assert.deepEqual(
    snapshot.requested_models.map((model) => model.requested_model).sort(),
    ["claude-opus-5", "gpt-6.1-sol"],
  );
  // The producer alias is the harness. No provider key is asserted anywhere.
  assert.equal(snapshot.producer.alias, "firstmate-pi");
  assert.equal(snapshot.cost.provenance, "pi_recorded_usage_cost");
  assert.equal(snapshot.cost.repricing, "none");
  assert.equal(snapshot.cost.price_catalog_version, null);
});

/* ------------------------------------------------------- replacement, not a sum */

test("polling the same snapshot repeatedly keeps exactly the same totals", () => {
  const polls = [0, 1, 2].map(() =>
    readPiUsage({ text: fixtureText, nowMs: generatedAtMs + 1_000 }),
  );
  assert.deepEqual(polls[1], polls[0]);
  assert.deepEqual(polls[2], polls[0]);
  for (const poll of polls) {
    assert.equal(poll.status, "ok");
    // A replacement dataset: three calls stay three calls, never nine.
    assert.equal(poll.data.snapshot.cost.calls, 3);
    assert.equal(poll.data.snapshot.cost.known_cost_usd_exact, "0.02");
    assert.equal(poll.data.snapshot.tokens.output, 1080);
  }
});

/* ------------------------------------------------------------ task attribution */

test("one task key already combines its author and No Mistakes work", () => {
  const snapshot = accepted();
  const task = find(snapshot.tasks, "task_key", "demo-task");
  const author = find(snapshot.work_items, "work_item", "demo-task \u00b7 author");
  const nm = find(snapshot.work_items, "work_item", "demo-task \u00b7 nm");

  // Two work items, one billable task key -- not two.
  assert.equal(task.calls, author.calls + nm.calls);
  assert.equal(task.calls, 2);
  assert.ok(
    piDecimalEquals(
      piExactCost(task),
      piDecimalAdd(piExactCost(author), piExactCost(nm)),
    ),
  );
  // A response copied into the No Mistakes fork counts once across the snapshot.
  assert.equal(snapshot.cost.calls, 3);
});

test("a work item is the string `task . role`, over the fixed role identities", () => {
  const snapshot = accepted();
  const taskKeys = new Set(
    snapshot.tasks.map((task) => task.task_key).filter((key) => key !== PI_FOLDED_ROW),
  );
  for (const item of snapshot.work_items) {
    const parts = item.work_item.split(" \u00b7 ");
    assert.equal(parts.length, 2, `work item ${item.work_item} is not "task . role"`);
    assert.ok(taskKeys.has(parts[0]));
    assert.ok(PI_ROLES.includes(parts[1]));
  }
});

test("MAIN work with no proved binding stays unassigned, not a task of its own", () => {
  const snapshot = accepted();
  const unassignedTask = find(snapshot.tasks, "task_key", PI_MAIN_UNASSIGNED);
  assert.deepEqual(snapshot.main_unassigned.tokens, unassignedTask.tokens);
  assert.equal(snapshot.main_unassigned.calls, unassignedTask.calls);
  // It is carried under the reserved key and labelled with nothing to link to.
  const label = find(snapshot.task_labels, "task_key", PI_MAIN_UNASSIGNED);
  assert.equal(label.title, null);
  assert.deepEqual(label.urls, []);
  // And it is MAIN's row in the role dimension.
  assert.equal(find(snapshot.roles, "role", "main").calls, 1);
});

test("the folded row is an aggregate, never a labelled task or a fake thread", () => {
  const snapshot = clone();
  snapshot.tasks.push(row("task_key", PI_FOLDED_ROW));
  assert.equal(parseObject(snapshot).ok, true, "a folded aggregate row is allowed");

  snapshot.task_labels.push({ task_key: PI_FOLDED_ROW, title: "Others", urls: [] });
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "structure");
  assert.match(verdict.detail, /label_without_task/);
});

test("task labels follow emitted non-folded keys and carry at most four safe links", () => {
  const snapshot = accepted();
  const emitted = new Set(
    snapshot.tasks.map((task) => task.task_key).filter((key) => key !== PI_FOLDED_ROW),
  );
  for (const label of snapshot.task_labels) {
    assert.ok(emitted.has(label.task_key));
    assert.ok(label.urls.length <= 4);
    for (const url of label.urls) assert.ok(isPiSafeLink(url));
  }
  assert.deepEqual(find(snapshot.task_labels, "task_key", "demo-task").urls, [
    "https://github.com/timafen-dev/agentic-engineering/issues/496",
  ]);

  const tooMany = clone();
  tooMany.task_labels[0].urls = [1, 2, 3, 4, 5].map(
    (n) => `https://github.com/timafen-dev/agentic-engineering/issues/${n}`,
  );
  assert.equal(parseObject(tooMany).ok, false);
});

/* --------------------------------------------------------- overlapping dimensions */

test("each view re-partitions the same calls instead of adding a new total", () => {
  const snapshot = accepted();
  const sum = (rows) => rows.reduce((total, r) => total + r.calls, 0);
  const total = snapshot.cost.calls;

  assert.equal(sum(snapshot.tasks), total);
  assert.equal(sum(snapshot.roles), total);
  assert.equal(sum(snapshot.requested_models), total);
  assert.equal(sum(snapshot.work_items), total);
  // Which is exactly why the dimensions must never be added together.
  assert.notEqual(
    sum(snapshot.tasks) + sum(snapshot.roles) + sum(snapshot.work_items),
    total,
  );

  // Token totals partition the same way.
  const tokenSum = (rows, field) =>
    rows.reduce((t, r) => t + r.tokens[field], 0);
  for (const field of ["input", "output", "cache_read", "cache_write", "reasoning"]) {
    assert.equal(tokenSum(snapshot.tasks, field), snapshot.tokens[field], field);
    assert.equal(tokenSum(snapshot.roles, field), snapshot.tokens[field], field);
  }
});

/* ------------------------------------------------------------------------- money */

test("known USD stays exact as digits and rounds only for rendering", () => {
  const snapshot = accepted();
  assert.equal(snapshot.cost.known_cost_usd_exact, "0.02");
  assert.equal(snapshot.cost.known_cost_usd, "0.020000");
  assert.ok(piCostAgrees(snapshot.cost));
  // Rendering rounds; the exact companion is untouched.
  const exact = piExactCost(snapshot.cost);
  assert.equal(piDecimalText(exact), "0.02");
  assert.equal(piDecimalFixed(exact, 2), "0.02");
  assert.equal(piDecimalFixed(exact, 6), "0.020000");
});

test("exact sums of many rows do not drift the way floats do", () => {
  // 0.1 + 0.2 as doubles is famously not 0.3; as recorded decimals it is.
  const sum = piDecimalAdd(piDecimal("0.1"), piDecimal("0.2"));
  assert.equal(piDecimalText(sum), "0.3");
  assert.ok(piDecimalEquals(sum, piDecimal("0.300")));

  const tenths = Array.from({ length: 10 }, () => piDecimal("0.1")).reduce(piDecimalAdd);
  assert.equal(piDecimalFixed(tenths, 6), "1.000000");
});

test("a zero sum with no priced call is unknown spend, not a known zero", () => {
  const snapshot = accepted();
  const nm = find(snapshot.work_items, "work_item", "demo-task \u00b7 nm");
  assert.equal(nm.priced_calls, 0);
  assert.equal(nm.missing_cost_calls, 1);
  assert.equal(nm.known_cost_usd_exact, "0");
  assert.equal(piSpendIsKnown(nm), false, "no priced call means spend is unknown");

  const author = find(snapshot.work_items, "work_item", "demo-task \u00b7 author");
  assert.equal(piSpendIsKnown(author), true);

  // The snapshot overall has known spend and two calls whose cost is unknown.
  assert.equal(piSpendIsKnown(snapshot.cost), true);
  assert.equal(snapshot.cost.missing_cost_calls, 2);
  assert.equal(snapshot.cost.invalid_cost_calls, 0);
});

test("a known explicit zero is distinguishable from a missing cost", () => {
  const snapshot = clone();
  // An explicit recorded 0 is a priced call: known, and known to be nothing.
  const priced = find(snapshot.work_items, "work_item", "demo-task \u00b7 nm");
  priced.priced_calls = 1;
  priced.missing_cost_calls = 0;
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, true);
  const updated = find(verdict.snapshot.work_items, "work_item", "demo-task \u00b7 nm");
  assert.equal(piSpendIsKnown(updated), true);
  assert.equal(updated.known_cost_usd_exact, "0");
  assert.equal(updated.missing_cost_calls, 0);
});

test("spend that no priced call supports is refused rather than displayed", () => {
  const snapshot = clone();
  snapshot.work_items[1].known_cost_usd_exact = "5";
  snapshot.work_items[1].known_cost_usd = "5.000000";
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "structure");
  assert.match(verdict.detail, /cost_without_priced_call/);
});

test("a rounded figure that disagrees with its exact companion is refused", () => {
  const snapshot = clone();
  snapshot.cost.known_cost_usd = "0.030000";
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /rounding_mismatch/);
});

test("call counters that do not add up are refused", () => {
  const snapshot = clone();
  snapshot.cost.missing_cost_calls = 1;
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /call_counts_disagree/);
});

test("a negative recorded cost is refused", () => {
  const snapshot = clone();
  snapshot.cost.known_cost_usd_exact = "-0.02";
  assert.equal(parseObject(snapshot).ok, false);
});

/* ------------------------------------------------------------------------ tokens */

test("the four token kinds stay separate and reasoning is never added to output", () => {
  const snapshot = accepted();
  assert.deepEqual(snapshot.tokens, {
    cache_read: 2170,
    cache_write: 0,
    input: 280,
    output: 1080,
    reasoning: 520,
  });
  // Reasoning is a possible subset of output, so it cannot exceed it...
  assert.ok(snapshot.tokens.reasoning <= snapshot.tokens.output);
  // ...and output is not the sum of the two.
  assert.notEqual(snapshot.tokens.output, 1080 + 520);
  assert.match(snapshot.token_semantics.reasoning, /never added to output twice/);
  assert.equal(snapshot.token_semantics.input, "non-cached input");
});

test("reasoning larger than output is refused as double counting", () => {
  const snapshot = clone();
  snapshot.days[0].tokens.reasoning = snapshot.days[0].tokens.output + 1;
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /reasoning_exceeds_output/);
});

test("the current context is unknown, and a cache read is not it", () => {
  const snapshot = accepted();
  assert.equal(snapshot.observation.current_context_tokens, null);
  assert.equal(snapshot.observation.current_context_status, "unknown_no_recorded_proof");
  assert.ok(snapshot.tokens.cache_read > 0, "cache reads exist but are not the context");

  // A number there would be an invented context size.
  const invented = clone();
  invented.observation.current_context_tokens = 2170;
  assert.equal(parseObject(invented).ok, false);
});

test("the observation is completed responses with a stated lag, not a stream", () => {
  const snapshot = accepted();
  assert.equal(snapshot.observation.basis, "completed_assistant_responses");
  assert.ok(snapshot.observation.lag_seconds > 0);
  assert.equal(snapshot.observation.latest_recorded_at, "2026-10-01T22:58:00Z");
  assert.match(snapshot.observation.finality, /revise the affected hour and day/);
});

/* ---------------------------------------------------------------------- coverage */

test("the approved fixture is partial coverage, with a token field gap", () => {
  const snapshot = accepted();
  assert.equal(snapshot.coverage.status, "partial");
  assert.equal(snapshot.coverage.token_field_gaps, 1);
  assert.equal(snapshot.cost.token_field_gaps, 1);
  assert.equal(snapshot.coverage.declared_sources, 3);
  assert.equal(snapshot.coverage.readable, 3);
  // The gap sits on the MAIN row whose reasoning field was never recorded.
  assert.equal(find(snapshot.tasks, "task_key", PI_MAIN_UNASSIGNED).token_field_gaps, 1);
  // Known token totals do not erase the gap.
  assert.ok(snapshot.tokens.output > 0);
  assert.equal(snapshot.coverage.token_field_gaps, 1);
});

test("partial coverage is not a verified idle zero", () => {
  const reading = readPiUsage({ text: fixtureText, nowMs: generatedAtMs + 1_000 });
  assert.equal(reading.status, "ok");
  assert.equal(piVerifiedIdleZero(reading), false);
});

test("an unreadable declared path stays a gap even when retained totals are known", () => {
  const snapshot = clone();
  snapshot.coverage.status = "unreadable";
  snapshot.coverage.sources[0].status = "unreadable";
  snapshot.coverage.readable = 2;
  snapshot.coverage.unreadable = 1;
  snapshot.coverage.unreadable_paths = 1;

  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, true, "retained costs remain readable alongside the gap");
  // The known spend survives...
  assert.equal(piSpendIsKnown(verdict.snapshot.cost), true);
  assert.equal(verdict.snapshot.cost.known_cost_usd_exact, "0.02");
  // ...and the gap is still reported, so it is never read as an idle hour.
  assert.equal(verdict.snapshot.coverage.unreadable_paths, 1);
  const reading = readPiUsage({
    text: JSON.stringify(snapshot),
    nowMs: generatedAtMs + 1_000,
  });
  assert.equal(reading.status, "ok");
  assert.equal(piVerifiedIdleZero(reading), false);
});

test("an ambiguous fork entry stays a coverage gap, not a billed guess", () => {
  const snapshot = clone();
  snapshot.coverage.ambiguous_fork_entries = 1;
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.snapshot.coverage.ambiguous_fork_entries, 1);
  // Totals are unchanged by the ambiguity: nothing was attributed to a guess.
  assert.equal(verdict.snapshot.cost.calls, 3);
  assert.equal(
    piVerifiedIdleZero(
      readPiUsage({ text: JSON.stringify(snapshot), nowMs: generatedAtMs + 1_000 }),
    ),
    false,
  );
});

/** A snapshot the producer itself verified as idle across every source. */
const idleSnapshot = () => {
  const snapshot = clone();
  snapshot.coverage = {
    ...snapshot.coverage,
    status: "verified_idle_zero",
    readable: 0,
    verified_idle_zero: 3,
    partial: 0,
    token_field_gaps: 0,
    unreadable: 0,
    unreadable_paths: 0,
    never_ingested: 0,
    conflicting_binding: 0,
    ambiguous_fork_entries: 0,
    assistant_without_usage: 0,
    invalid_rows: 0,
    pending_tails: 0,
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
  snapshot.tokens = { cache_read: 0, cache_write: 0, input: 0, output: 0, reasoning: 0 };
  snapshot.tasks = [];
  snapshot.task_labels = [];
  snapshot.work_items = [];
  snapshot.requested_models = [];
  snapshot.roles = PI_ROLES.map((role) => row("role", role));
  snapshot.days = [];
  snapshot.hours = [];
  snapshot.live_bins = { ...snapshot.live_bins, bins: [] };
  snapshot.main_unassigned = zeroAmount();
  return snapshot;
};

test("only the producer may say an hour was idle, and then the panel agrees", () => {
  const text = JSON.stringify(idleSnapshot());
  const verdict = parsePiUsageSnapshot(text);
  assert.equal(verdict.ok, true);
  const reading = readPiUsage({ text, nowMs: generatedAtMs + 1_000 });
  assert.equal(reading.status, "ok");
  assert.equal(piVerifiedIdleZero(reading), true);
});

test("no failure state is ever mistaken for a verified idle zero", () => {
  const idle = JSON.stringify(idleSnapshot());
  const now = generatedAtMs + 1_000;
  const readings = {
    unavailable: readPiUsage({ nowMs: now }),
    missing: readPiUsage({ text: null, nowMs: now }),
    invalid: readPiUsage({ text: "{ not json", nowMs: now }),
    failed: readPiUsage({
      text: idle,
      sidecarText: JSON.stringify({ status: "failed", error_class: "OSError" }),
      nowMs: now,
    }),
    stale: readPiUsage({ text: idle, nowMs: generatedAtMs + 600_000 }),
    future: readPiUsage({ text: idle, nowMs: generatedAtMs - 600_000 }),
    partial: readPiUsage({ text: fixtureText, nowMs: now }),
  };
  // Every state is its own status, so the panel can word each one honestly.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(readings).map(([name, reading]) => [name, reading.status]),
    ),
    {
      unavailable: "unavailable",
      missing: "missing",
      invalid: "invalid",
      failed: "failed",
      stale: "stale",
      future: "future",
      partial: "ok",
    },
  );
  for (const [name, reading] of Object.entries(readings)) {
    assert.equal(piVerifiedIdleZero(reading), false, `${name} must not read as idle zero`);
  }
});

test("retained or degraded figures never read as a verified idle zero", () => {
  // `readPiUsage` only ever attaches retained figures to a failed status, but
  // the panel keeps last-good data across polls, so the idle-zero verdict is
  // asked to be total over its input: a reading that claims to be current
  // while carrying retained or degraded figures is still not proof of idleness.
  const idle = JSON.parse(JSON.stringify(idleSnapshot()));
  const honest = readPiUsage({ text: JSON.stringify(idle), nowMs: generatedAtMs + 1_000 });
  assert.equal(piVerifiedIdleZero(honest), true);

  for (const data of [
    { ...honest.data, retained: true },
    { ...honest.data, degraded: true },
    { ...honest.data, retained: true, degraded: true },
  ]) {
    assert.equal(
      piVerifiedIdleZero({ ...honest, data }),
      false,
      "last-good figures cannot verify an idle hour",
    );
  }
  assert.equal(piVerifiedIdleZero({ ...honest, data: null }), false);
});

test("an idle claim contradicted by its own counters is not believed", () => {
  const now = generatedAtMs + 1_000;
  const contradictions = [
    ["a token field gap", (s) => (s.coverage.token_field_gaps = 1)],
    ["an unreadable path", (s) => (s.coverage.unreadable_paths = 1)],
    ["a response without usage", (s) => (s.coverage.assistant_without_usage = 1)],
    ["an invalid row", (s) => (s.coverage.invalid_rows = 1)],
    ["a conflicting binding", (s) => (s.coverage.conflicting_binding = 1)],
    ["an unverified source", (s) => (s.coverage.verified_idle_zero = 2)],
    ["no declared source at all", (s) => {
      s.coverage.declared_sources = 0;
      s.coverage.verified_idle_zero = 0;
      s.coverage.sources = [];
    }],
  ];
  for (const [name, mutate] of contradictions) {
    const snapshot = idleSnapshot();
    mutate(snapshot);
    const reading = readPiUsage({ text: JSON.stringify(snapshot), nowMs: now });
    assert.equal(reading.status, "ok", `${name} should still parse`);
    assert.equal(piVerifiedIdleZero(reading), false, `${name} contradicts idleness`);
  }
});

/* ----------------------------------------------------------------- reading states */

test("an unknown owning machine is unavailable, never a zero or a native fallback", () => {
  const reading = readPiUsage({
    nowMs: generatedAtMs,
    unavailable: { reason: "owning_host_unknown", detail: "the approved machine is not registered" },
  });
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "owning_host_unknown");
  assert.equal(reading.data, null, "no figures at all, rather than zeroes");
});

test("freshness comes from generated_at, not from a file timestamp", () => {
  assert.equal(piFreshness(accepted().generated_at, generatedAtMs + 10_000).state, "fresh");
  assert.equal(
    piFreshness(accepted().generated_at, generatedAtMs + (PI_GRACE_SECONDS + 1) * 1000).state,
    "stale",
  );
  // A snapshot rewritten today but generated long ago is stale, however new
  // the file looks on disk: the adapter is never told the modification time.
  const old = clone();
  old.generated_at = "2026-09-01T00:00:00Z";
  const reading = readPiUsage({ text: JSON.stringify(old), nowMs: generatedAtMs });
  assert.equal(reading.status, "stale");
  assert.equal(reading.data.degraded, true);
  assert.ok(reading.data.freshness.ageSeconds > 86_400);
});

test("a snapshot stamped ahead of the clock is not treated as fresh", () => {
  const reading = readPiUsage({ text: fixtureText, nowMs: generatedAtMs - 3_600_000 });
  assert.equal(reading.status, "future");
  assert.equal(reading.data.freshness.state, "future");
  assert.equal(reading.data.degraded, true);
  // A small clock disagreement is tolerated rather than called a time paradox.
  assert.equal(readPiUsage({ text: fixtureText, nowMs: generatedAtMs - 2_000 }).status, "ok");
});

test("retained last-good figures are marked degraded and never fresh", () => {
  const snapshot = accepted();
  const reading = readPiUsage({
    text: null,
    retained: snapshot,
    nowMs: generatedAtMs + 1_000,
  });
  assert.equal(reading.status, "missing");
  assert.equal(reading.data.retained, true);
  assert.equal(reading.data.degraded, true);
  assert.equal(reading.data.snapshot.cost.known_cost_usd_exact, "0.02");
  assert.notEqual(reading.status, "ok");
});

test("a producer failure note outranks the artifact still sitting on disk", () => {
  const reading = readPiUsage({
    text: fixtureText,
    sidecarText: JSON.stringify({
      status: "failed",
      error_class: "PermissionError",
      reason: "the export could not be replaced",
      artifact: "snapshot.json",
    }),
    nowMs: generatedAtMs + 1_000,
  });
  assert.equal(reading.status, "failed");
  assert.equal(reading.reason, "producer_failed:PermissionError");
  // The readable artifact may be an older generation, so it is shown degraded.
  assert.equal(reading.data.degraded, true);
  assert.equal(reading.data.snapshot.cost.calls, 3);
});

test("a failure note the panel cannot read is still a failure, not an absence", () => {
  for (const sidecarText of ["{ broken", JSON.stringify({ status: "ok" }), "[]"]) {
    const reading = readPiUsage({
      text: fixtureText,
      sidecarText,
      nowMs: generatedAtMs + 1_000,
    });
    assert.equal(reading.status, "failed", `sidecar ${sidecarText}`);
    assert.match(reading.reason, /^producer_failed_note_unreadable:/);
    assert.equal(reading.data.degraded, true);
  }
});

test("a successful retry removes the note, and the reader observes the recovery", () => {
  const failed = readPiUsage({
    text: fixtureText,
    sidecarText: JSON.stringify({ status: "failed", error_class: "OSError" }),
    nowMs: generatedAtMs + 1_000,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.recoveredFromFailure, false);

  const recovered = readPiUsage({
    text: fixtureText,
    sidecarText: null,
    failedBefore: true,
    nowMs: generatedAtMs + 1_000,
  });
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.recoveredFromFailure, true);
  assert.equal(recovered.data.degraded, false);
  assert.equal(recovered.data.retained, false);
});

/* --------------------------------------------------------------- window and time */

test("the window is half open, and an inverted one is refused", () => {
  const snapshot = accepted();
  assert.equal(snapshot.window.mode, "half_open");
  assert.equal(snapshot.window.boundary, "[start,end)");
  assert.ok(Date.parse(snapshot.window.start) < Date.parse(snapshot.window.end));

  const inverted = clone();
  inverted.window.end = inverted.window.start;
  const verdict = parseObject(inverted);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /window_not_half_open/);
});

test("hour identities are offset bearing and hour precision, normalized explicitly", () => {
  const snapshot = accepted();
  assert.equal(snapshot.hours[0].hour, "2026-10-01T22+00:00");
  assert.equal(piHourOffset("2026-10-01T22+00:00"), "+00:00");
  // The raw identity is not what a chart's date parser wants, so normalizing
  // is a deliberate step rather than an assumption.
  assert.equal(piHourRfc3339("2026-10-01T22+00:00"), "2026-10-01T22:00:00+00:00");
  assert.equal(
    piHourInstantMs("2026-10-01T22+00:00"),
    Date.parse("2026-10-01T22:00:00Z"),
  );
  assert.equal(piHourInstantMs("2026-10-01T22:00:00Z"), null, "seconds are not an hour id");
  assert.equal(piHourInstantMs("2026-10-01T22"), null, "an offset is required");
});

test("the repeated local hour of a DST day stays two distinct points", () => {
  const snapshot = clone();
  const before = { ...snapshot.hours[0], hour: "2026-11-01T01-04:00" };
  const after = { ...snapshot.hours[0], hour: "2026-11-01T01-05:00" };
  snapshot.hours = [before, after];

  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, true, "the same local hour twice is legitimate");
  const [first, second] = verdict.snapshot.hours;
  assert.notEqual(first.hour, second.hour, "the offset keeps them distinct");
  assert.equal(piHourOffset(first.hour), "-04:00");
  assert.equal(piHourOffset(second.hour), "-05:00");
  // Ordered by instant, an hour apart, even though both read "01".
  assert.equal(
    piHourInstantMs(second.hour) - piHourInstantMs(first.hour),
    3_600_000,
  );

  // The identical identity twice is a different thing, and is refused.
  const duplicated = clone();
  duplicated.hours = [before, { ...before }];
  assert.match(parseObject(duplicated).detail, /duplicate_hour/);
});

test("series points stay ordered, so a chart never draws backwards", () => {
  const snapshot = clone();
  snapshot.hours = [
    { ...snapshot.hours[0], hour: "2026-10-01T23+00:00" },
    { ...snapshot.hours[0], hour: "2026-10-01T22+00:00" },
  ];
  assert.match(parseObject(snapshot).detail, /hours_out_of_order/);
});

test("live rows are keyed by bin_start at the declared ten second width", () => {
  const snapshot = accepted();
  assert.equal(snapshot.live_bins.bin_seconds, 10);
  assert.deepEqual(
    snapshot.live_bins.bins.map((bin) => bin.bin_start),
    ["2026-10-01T22:50:00Z", "2026-10-01T22:55:00Z", "2026-10-01T22:58:00Z"],
  );
  assert.equal(snapshot.live_bins.covers, "2026-10-01T22:45:00Z..2026-10-01T23:00:00Z");
  for (const bin of snapshot.live_bins.bins) {
    assert.equal(Date.parse(bin.bin_start) % 10_000, 0);
  }

  const unaligned = clone();
  unaligned.live_bins.bins[0].bin_start = "2026-10-01T22:50:03Z";
  assert.match(parseObject(unaligned).detail, /bin_unaligned/);
});

test("only the declared number of points is accepted", () => {
  const overHours = clone();
  overHours.hours = Array.from({ length: 169 }, (_, i) =>
    row("hour", `2026-10-01T${String(i % 24).padStart(2, "0")}+00:00`),
  );
  assert.equal(parseObject(overHours).ok, false);

  const overBins = clone();
  overBins.live_bins.bins = Array.from({ length: 91 }, (_, i) =>
    row("bin_start", new Date(Date.parse("2026-10-01T22:00:00Z") + i * 10_000).toISOString()),
  );
  assert.equal(parseObject(overBins).ok, false);

  const overDays = clone();
  overDays.days = Array.from({ length: 91 }, (_, i) =>
    row("day", new Date(Date.parse("2026-01-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10)),
  );
  assert.equal(parseObject(overDays).ok, false);
});

/* ------------------------------------------------------------------ bounds, rows */

test("a folded row buys one extra slot, and nothing buys a second", () => {
  const base = clone();
  const keep = base.tasks;
  const filler = (count, offset) =>
    Array.from({ length: count }, (_, i) => row("task_key", `filler-${offset + i}`));

  // Twenty real tasks plus the folded aggregate is twenty-one rows, and fine.
  const atBound = clone();
  atBound.tasks = [...keep, ...filler(18, 0), row("task_key", PI_FOLDED_ROW)];
  assert.equal(atBound.tasks.length, 21);
  assert.equal(parseObject(atBound).ok, true);

  // Twenty-one real tasks is over the bound even though it is still 21 rows.
  const overBound = clone();
  overBound.tasks = [...keep, ...filler(19, 0)];
  assert.equal(overBound.tasks.length, 21);
  const verdict = parseObject(overBound);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /too_many_rows/);

  // And twenty-two rows is refused outright.
  const wayOver = clone();
  wayOver.tasks = [...keep, ...filler(20, 0)];
  assert.equal(parseObject(wayOver).ok, false);
});

test("requested models fold into `other`, work items into `others`", () => {
  const models = clone();
  models.requested_models = [
    ...models.requested_models,
    ...Array.from({ length: 14 }, (_, i) => row("requested_model", `m-${i}`)),
    row("requested_model", PI_FOLDED_MODEL),
  ];
  assert.equal(models.requested_models.length, 17);
  assert.equal(parseObject(models).ok, true);

  const tooManyModels = clone();
  tooManyModels.requested_models = Array.from({ length: 17 }, (_, i) =>
    row("requested_model", `m-${i}`),
  );
  assert.match(parseObject(tooManyModels).detail, /too_many_rows/);

  const items = clone();
  items.work_items = [
    ...items.work_items,
    ...Array.from({ length: 47 }, (_, i) => row("work_item", `demo-task \u00b7 filler-${i}`)),
    row("work_item", PI_FOLDED_ROW),
  ];
  assert.equal(items.work_items.length, 51);
  assert.equal(parseObject(items).ok, true);
});

test("a duplicated aggregate row is refused rather than counted twice", () => {
  const snapshot = clone();
  snapshot.tasks = [...snapshot.tasks, { ...snapshot.tasks[0] }];
  assert.match(parseObject(snapshot).detail, /duplicate_rows/);
});

test("the snapshot may not be larger than the agreed two mebibytes", () => {
  const padded = fixtureText + " ".repeat(PI_MAX_SNAPSHOT_BYTES);
  const verdict = parsePiUsageSnapshot(padded);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "too_large", "the size is checked before parsing");

  // Right up to the bound is still read.
  const justUnder =
    fixtureText + " ".repeat(PI_MAX_SNAPSHOT_BYTES - Buffer.byteLength(fixtureText, "utf8"));
  assert.equal(Buffer.byteLength(justUnder, "utf8"), PI_MAX_SNAPSHOT_BYTES);
  assert.equal(parsePiUsageSnapshot(justUnder).ok, true);
});

test("the declared limits themselves must be the agreed ones", () => {
  const snapshot = clone();
  snapshot.limits.max_tasks = 2000;
  assert.equal(parseObject(snapshot).ok, false);

  const bytes = clone();
  bytes.limits.max_export_bytes = 1_000_000_000;
  assert.equal(parseObject(bytes).ok, false);
});

/* ---------------------------------------------------------------- fixed identities */

test("role and coverage identities are closed sets", () => {
  const roles = clone();
  roles.roles[0].role = "reviewer";
  assert.equal(parseObject(roles).ok, false);

  const missing = clone();
  missing.roles = missing.roles.slice(0, 4);
  assert.match(parseObject(missing).detail, /role_identities_unexpected/);

  const coverage = clone();
  coverage.coverage.status = "probably_fine";
  assert.equal(parseObject(coverage).ok, false);

  const sourceStatus = clone();
  sourceStatus.coverage.sources[0].status = "maybe";
  assert.equal(parseObject(sourceStatus).ok, false);
});

test("an incompatible producer, schema, ledger or parser version is refused", () => {
  const cases = [
    ["schema_version", (s) => (s.schema_version = 2)],
    ["kind", (s) => (s.kind = "pi_usage_report")],
    ["alias", (s) => (s.producer.alias = "pi-local")],
    ["ledger 1", (s) => (s.producer.ledger_schema_version = 1)],
    ["parser 1", (s) => (s.producer.parser_version = "pi-usage-parser/1")],
    ["source schema", (s) => (s.producer.source_schema_version = "pi-session-jsonl/2")],
    ["revision", (s) => (s.producer.revision = "not-a-revision")],
    ["currency", (s) => (s.cost.currency = "EUR")],
    ["provenance", (s) => (s.cost.provenance = "estimated_from_catalog")],
    ["repricing", (s) => (s.cost.repricing = "today")],
    ["basis", (s) => (s.observation.basis = "streaming_events")],
    ["bin width", (s) => (s.live_bins.bin_seconds = 60)],
  ];
  for (const [name, mutate] of cases) {
    const snapshot = clone();
    mutate(snapshot);
    const verdict = parseObject(snapshot);
    assert.equal(verdict.ok, false, `${name} should be refused`);
    assert.equal(verdict.reason, "schema");
  }
});

test("an unexpected key is refused instead of being silently dropped", () => {
  const snapshot = clone();
  snapshot.cost.subscription_consumed_usd = "9.99";
  const verdict = parseObject(snapshot);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "schema");
});

test("something that is not a snapshot object at all is refused plainly", () => {
  for (const text of ["[]", "null", '"text"', "7"]) {
    const verdict = parsePiUsageSnapshot(text);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "not_an_object");
  }
  assert.equal(parsePiUsageSnapshot("{oops").reason, "not_json");
});

/* --------------------------------------------------------------------- privacy */

test("a snapshot carrying private detail is refused, not displayed", () => {
  const cases = [
    ["a home path", (s) => s.warnings.push("could not read /home/example/.pi/sessions/a.jsonl")],
    ["a tilde path", (s) => s.warnings.push("missing ~/state/pi-usage/manifest.json")],
    ["a windows path", (s) => s.warnings.push("C:\\Users\\owner\\pi.jsonl is gone")],
    ["an address", (s) => s.warnings.push("account owner@example.invalid")],
    ["a key", (s) => s.warnings.push("sk-ant-api03-abcdefgh12345")],
    ["a bearer token", (s) => s.warnings.push("Authorization: Bearer abcdefgh12345678")],
    ["a jwt", (s) => s.warnings.push("eyJhbGciOiJIUzI1NiJ9abcdefg")],
    ["an oauth field", (s) => s.warnings.push("oauthAccount was refreshed")],
    ["a traceback", (s) => s.warnings.push("Traceback (most recent call last): boom")],
    ["a python frame", (s) => s.warnings.push('File "pi_usage.py", line 42')],
    ["a path in a label", (s) => (s.task_labels[0].title = "/home/example/work")],
    ["a path in a quarantine row", (s) => s.quarantine.push({ alias: "/home/example/a.jsonl" })],
    ["a private key name", (s) => (s.coverage.sources[0].alias = "/var/lib/pi/s01")],
  ];
  for (const [name, mutate] of cases) {
    const snapshot = clone();
    mutate(snapshot);
    const verdict = parseObject(snapshot);
    assert.equal(verdict.ok, false, `${name} should be refused`);
    assert.equal(verdict.reason, "privacy", name);
  }
});

test("only approved HTTPS GitHub issue and pull links survive", () => {
  assert.equal(
    isPiSafeLink("https://github.com/timafen-dev/agentic-engineering/issues/496"),
    true,
  );
  assert.equal(isPiSafeLink("https://github.com/timafen-dev/bb-plugin-provider-usage/pull/7"), true);
  for (const unsafe of [
    "http://github.com/a/b/issues/1",
    "https://github.com/a/b/issues/1?token=secret",
    "https://github.com/a/b/commit/deadbeef",
    "https://github.example.com/a/b/issues/1",
    "https://evil.test/github.com/a/b/issues/1",
    "https://github.com/a/b/issues/0",
    "javascript:alert(1)",
  ]) {
    assert.equal(isPiSafeLink(unsafe), false, unsafe);
  }

  for (const url of ["http://github.com/a/b/issues/1", "https://evil.test/x"]) {
    const snapshot = clone();
    snapshot.task_labels[0].urls = [url];
    const verdict = parseObject(snapshot);
    assert.equal(verdict.ok, false, url);
    assert.equal(verdict.reason, "privacy");
  }
});

test("a link smuggled into prose is refused along with the rest", () => {
  const snapshot = clone();
  snapshot.cost.label = "see https://evil.test/leak for detail";
  assert.equal(parseObject(snapshot).reason, "privacy");
});

test("no rejection message repeats the content that caused it", () => {
  const secrets = [
    ["/home/example/.pi/private-session.jsonl", (s) => s.warnings.push("read /home/example/.pi/private-session.jsonl")],
    ["owner@example.invalid", (s) => s.warnings.push("owner owner@example.invalid")],
    ["sk-ant-api03-supersecret", (s) => s.warnings.push("sk-ant-api03-supersecret")],
  ];
  for (const [secret, mutate] of secrets) {
    const snapshot = clone();
    mutate(snapshot);
    const verdict = parseObject(snapshot);
    assert.equal(verdict.ok, false);
    // The detail names the field, never what was in it.
    assert.ok(!verdict.detail.includes(secret), `detail leaked ${secret}`);
    assert.match(verdict.detail, /warnings\[|task_labels|cost|coverage/);
  }

  // Nor does a parser failure quote the file it choked on.
  const broken = parsePiUsageSnapshot('{"secret": "/home/example/private", ');
  assert.equal(broken.ok, false);
  assert.ok(!broken.detail.includes("/home/example/private"));

  // Nor does a schema failure echo the value it rejected.
  const snapshot = clone();
  snapshot.cost.currency = "sk-ant-api03-supersecret";
  const rejected = parseObject(snapshot);
  assert.equal(rejected.ok, false);
  assert.ok(!rejected.detail.includes("sk-ant-api03-supersecret"));
});

/* ---------------------------------------------------- quota stays where it belongs */

test("the snapshot says in its own words that quota is not Pi attribution", () => {
  const snapshot = accepted();
  assert.match(snapshot.consumer.quota, /subscriptions view/);
  assert.match(snapshot.consumer.quota, /not Pi task attribution/);
  assert.match(snapshot.consumer.usage, /not a stream to bill again/);
  // The recorded figure is labelled an estimate, not an invoice or a payment.
  assert.match(snapshot.cost.label, /API-equivalent estimate/);
  assert.match(snapshot.cost.label, /not an invoice, a payment, or subscription quota/);
  // And no remaining/reset field exists anywhere to be mistaken for quota.
  assert.ok(!("remaining" in snapshot));
  assert.ok(!("limits" in snapshot.cost));
  assert.deepEqual(Object.keys(snapshot.limits).sort(), [
    "max_days",
    "max_export_bytes",
    "max_hours",
    "max_live_bins",
    "max_requested_models",
    "max_tasks",
    "max_work_items",
  ]);
});
