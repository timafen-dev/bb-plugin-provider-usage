import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { default: plugin } = await import("../server.ts");
const { scanTokenFiles, seedDailyFromCache } = await import("../lib/token-scan.ts");
const { createHostTokenHistory } = await import("../lib/host-token-history.ts");
const { mergeMachineTokens } = await import("../lib/machine-tokens.ts");
const { machineTokensSchema } = await import("../host-contract.ts");
const { dayKey, formatTokenText, assembleTokenSnapshot } = await import("../lib/tokens.ts");
const { PROVIDER_KEYS } = await import("../lib/dashboard.ts");
const { overlayLastGoodLimits, rememberGoodLimits } = await import("../lib/limits-cache.ts");
const { readPiExportFacts, piExportLocation } = await import("../lib/pi-usage-source.ts");
const { parsePiUsageSnapshot, piPrivacyHits } = await import("../lib/pi-usage-contract.ts");
const piFixture = await readFile(new URL("./fixtures/pi-usage-snapshot.json", import.meta.url), "utf8");
const bucket = (tokens) => ({ tokens, input: tokens, output: 0, cached: 0, reasoning: 0, turns: 1 });
const gate = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};

async function fixture(t) {
  const home = await mkdtemp(join(process.cwd(), ".test-review-boundaries-"));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"), MUSE_HOME: join(home, "muse"), XDG_DATA_HOME: join(home, "xdg") });
  const dataDir = join(home, "data");
  await mkdir(dataDir);
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true });
  });
  return { home, dataDir };
}

async function codexFile(path, tokens) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "token_count", info: { total_token_usage: { total_tokens: tokens, input_tokens: tokens } } } }) + "\n");
}

function fakeHost({ hosts = [], call = async () => { throw new Error("unexpected host read"); }, listThreads = async () => [] } = {}) {
  return createFakePluginHost({ pluginId: "provider-usage", sdk: { hosts: { list: async () => hosts }, threads: { list: listThreads } }, experimental_callHostRpc: call });
}

function observation(snapshot, provider) {
  return snapshot.observations.find((row) => row.provider === provider);
}

function merged(answer) {
  return mergeMachineTokens([{ id: "host", name: "Host", error: null, tokens: answer }], 7);
}

function tokenText(result) {
  return formatTokenText({ ...assembleTokenSnapshot({ days: 7, fileCount: result.fileCount, changedFiles: 0, sources: result.providers, daily: result.daily }), observations: result.observations });
}

test("all provider overlays and persisted last-good state refuse incompatible accounts", () => {
  for (const key of PROVIDER_KEYS) {
    const initial = Object.fromEntries(PROVIDER_KEYS.map((provider) => [provider, { status: "unknown", windows: [] }]));
    initial[key] = { status: "ok", accountEmail: "a@example.test", windows: [{ label: "Weekly", usedPercent: 41, resetsAt: null }] };
    const lastGood = rememberGoodLimits(initial);
    for (const accountEmail of ["a@example.test", " A@EXAMPLE.TEST ", null]) {
      const fresh = { ...initial, [key]: { status: "error", accountEmail, message: "rate limited", windows: [] } };
      const kept = overlayLastGoodLimits(fresh, lastGood);
      assert.equal(kept[key].status, "stale");
      assert.equal(kept[key].windows[0].usedPercent, 41);
    }
    for (const status of ["error", "unknown", "unauthenticated"]) {
      const fresh = { ...initial, [key]: { status, accountEmail: "b@example.test", message: "rate limited", windows: [] } };
      const refused = overlayLastGoodLimits(fresh, lastGood);
      assert.equal(refused[key].status, status);
      assert.deepEqual(refused[key].windows, []);
      const persisted = JSON.parse(JSON.stringify(rememberGoodLimits(refused, lastGood)));
      assert.equal(persisted[key], undefined);
      const unknown = { ...fresh, [key]: { status: "error", accountEmail: null, message: "rate limited", windows: [] } };
      assert.deepEqual(overlayLastGoodLimits(unknown, persisted)[key].windows, []);
    }
    const unbound = { ...lastGood, [key]: { ...lastGood[key], accountEmail: null } };
    const fresh = { ...initial, [key]: { status: "error", accountEmail: "b@example.test", message: "rate limited", windows: [] } };
    assert.deepEqual(overlayLastGoodLimits(fresh, unbound)[key].windows, []);
  }
});

test("host forced callers share a cold successor after a held warm read, including warm failure", async (t) => {
  const { home, dataDir: root } = await fixture(t);
  for (const failWarm of [false, true]) {
    const dataDir = join(root, String(failWarm));
    await mkdir(dataDir);
    const path = join(home, "codex/sessions/a.jsonl");
    await codexFile(path, 100);
    const started = gate(), released = gate();
    const passes = [];
    let leases = 0, disposed = 0;
    const history = createHostTokenHistory({ dataDir, computer: "pc", scan: async (options) => {
      passes.push(options.force);
      const result = await scanTokenFiles(options);
      if (passes.length === 1) {
        started.release();
        await released.promise;
        if (failWarm) throw new Error("synthetic warm failure");
      }
      return result;
    } });
    const retain = () => { leases += 1; return { dispose() { disposed += 1; } }; };
    const warm = history.read({ retain }).catch(() => null);
    await started.promise;
    await codexFile(path, 120);
    const forced = [history.read({ force: true, waitMs: 0, retain }), history.read({ force: true, waitMs: 0, retain })];
    released.release();
    const [old, ...answers] = await Promise.all([warm, ...forced]);
    if (!failWarm) assert.equal(merged(old).machines[0].tokens, 100);
    for (const answer of answers) {
      assert.equal(merged(machineTokensSchema.parse(answer)).machines[0].tokens, 120);
      assert.deepEqual(answer, answers[0]);
    }
    assert.deepEqual(passes, [false, true]);
    assert.equal(leases, 2);
    assert.equal(disposed, 2);
    assert.deepEqual((await history.read({})).slices, answers[0].slices);
  }
});

test("server RPC and CLI forced callers run a cold successor after warm local100", async (t) => {
  const { home } = await fixture(t);
  const path = join(home, "codex/sessions/a.jsonl");
  await codexFile(path, 100);
  const started = gate(), released = gate();
  let threadReads = 0;
  const remoteForces = [];
  const { bb, harness } = fakeHost({
    hosts: [{ id: "remote", name: "Remote", status: "connected" }],
    call: async ({ method, input }) => {
      assert.equal(method, "tokenHistory");
      remoteForces.push(input.force);
      return { computer: "remote", scannedAt: new Date().toISOString(), changedFiles: 0, slices: [] };
    },
    listThreads: async () => {
      threadReads += 1;
      if (threadReads === 1) { started.release(); await released.promise; }
      return [];
    },
  });
  try {
    await plugin(bb);
    assert.equal((await harness.behavior.callRpc("getTokens", { days: 7, force: false })).totals.tokens, 100);
    await started.promise;
    await codexFile(path, 120);
    const forced = harness.behavior.callRpc("getTokens", { days: 7, force: true });
    const cli = harness.behavior.runCli(["tokens", "--days", "7", "--force", "--json"]);
    assert.equal((await harness.behavior.callRpc("getTokens", { days: 7, force: false })).totals.tokens, 100);
    released.release();
    assert.equal((await forced).totals.tokens, 120);
    const answer = await cli;
    assert.equal(answer.exitCode, 0);
    assert.equal(JSON.parse(answer.stdout).totals.tokens, 120);
    assert.deepEqual(remoteForces, [false, true]);
    assert.equal(threadReads, 2);
  } finally {
    released.release();
    await harness.lifecycle.dispose();
  }
});

test("legacy unreadable Claude keyed events remain exactly rebucketable and deduplicated", async (t) => {
  const { home, dataDir } = await fixture(t);
  const now = Date.now(), observedAt = new Date(now - 60_000).toISOString();
  const directory = join(home, "claude/projects/P");
  await mkdir(directory, { recursive: true });
  const rows = [];
  for (const name of ["a", "b"]) {
    const path = join(directory, `${name}.jsonl`);
    await writeFile(path, "unreadable fixture".repeat(4));
    const info = await stat(path);
    rows.push([path, { mtimeMs: Math.round(info.mtimeMs), size: info.size, daily: {}, keyedEvents: { same: { atMs: now, bucket: bucket(900) } }, observedAt }]);
  }
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify(rows));
  const mock = t.mock.method(fs, "createReadStream", () => { throw new Error("synthetic EACCES"); });
  syncBuiltinESMExports();
  const history = createHostTokenHistory({ dataDir, computer: "pc" });
  const answer = await history.read({ force: true });
  const restart = await createHostTokenHistory({ dataDir, computer: "pc" }).read({});
  for (const value of [answer, restart]) {
    const result = merged(machineTokensSchema.parse(value));
    assert.equal(result.daily[dayKey(now)]["claude-code"].tokens, 900);
    assert.equal(result.observations.reduce((sum, row) => sum + row.rawTokens, 0), 900);
    assert.ok(result.observations.every((row) => row.status === "stale" && row.observedAt === observedAt));
    assert.match(tokenText(result), /could not be read/);
    assert.doesNotMatch(tokenText(result), /cannot be recovered/);
  }
  mock.mock.restore();
  syncBuiltinESMExports();
});

test("JSONL, Cursor and Opencode unchanged fingerprints never erase read failures", async (t) => {
  const { home, dataDir } = await fixture(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const codex = join(home, "codex/sessions/a.jsonl");
  await codexFile(codex, 100);
  const cursor = join(home, ".cursor/acp-sessions/S/store.db"), opencode = join(home, "xdg/opencode/opencode.db");
  for (const path of [cursor, opencode]) await mkdir(join(path, ".."), { recursive: true });
  const cdb = new DatabaseSync(cursor);
  cdb.exec("create table blobs (data blob)");
  cdb.prepare("insert into blobs values (?)").run(Buffer.from(JSON.stringify({ role: "assistant", content: "x".repeat(360) })));
  cdb.close();
  const odb = new DatabaseSync(opencode);
  odb.exec("create table message (time_created integer, data text)");
  odb.prepare("insert into message values (?, ?)").run(now, JSON.stringify({ tokens: { total: 900, input: 900 } }));
  odb.close();
  const originals = new Map();
  for (const path of [cursor, opencode]) originals.set(path, { bytes: await readFile(path), info: await stat(path) });
  const history = createHostTokenHistory({ dataDir, computer: hostname() });
  const first = await history.read({ force: true });
  const { bb, harness } = fakeHost();
  let reloaded;
  try {
    await plugin(bb);
    await harness.behavior.callRpc("getTokens", { days: 7, force: true });
    for (const [path, { bytes, info }] of originals) {
      await writeFile(path, Buffer.alloc(bytes.length));
      await utimes(path, info.atime, info.mtime);
    }
    const mock = t.mock.method(fs, "createReadStream", () => { throw new Error("synthetic EACCES"); });
    syncBuiltinESMExports();
    t.mock.timers.tick(1_000);
    const failed = await history.read({ force: true });
    const localFailed = await harness.behavior.callRpc("getTokens", { days: 7, force: true });
    t.mock.timers.tick(180_000);
    const warm = await history.read({});
    const restarted = await createHostTokenHistory({ dataDir, computer: hostname() }).read({});
    const localWarm = await harness.behavior.callRpc("getTokens", { days: 30, force: false });
    reloaded = await harness.lifecycle.reload(plugin);
    const localRestart = await reloaded.harness.behavior.callRpc("getTokens", { days: 7, force: false });
    await reloaded.harness.behavior.callRpc("getTokens", { days: 7, force: true });
    for (const value of [failed, warm, restarted]) {
      for (const slice of value.slices) {
        assert.equal(slice.readError, true, slice.provider);
        assert.equal(slice.retained, true, slice.provider);
        assert.equal(slice.observedAt, first.slices.find((row) => row.provider === slice.provider).observedAt);
      }
    }
    for (const value of [localFailed, localWarm, localRestart]) {
      assert.equal(value.totals.tokens, 1000);
      for (const provider of ["codex", "cursor", "opencode"]) {
        assert.equal(observation(value, provider).status, "stale");
        assert.match(observation(value, provider).message, /could not be read/);
        assert.equal(observation(value, provider).observedAt, observation(localFailed, provider).observedAt);
      }
    }
    mock.mock.restore();
    syncBuiltinESMExports();
    for (const [path, { bytes, info }] of originals) {
      await writeFile(path, bytes);
      await utimes(path, info.atime, info.mtime);
    }
    t.mock.timers.tick(180_000);
    const recovered = await history.read({});
    for (const slice of recovered.slices) {
      assert.notEqual(slice.readError, true);
      assert.equal(slice.retained, false);
      assert.ok(Date.parse(slice.observedAt) > Date.parse(first.slices.find((row) => row.provider === slice.provider).observedAt));
    }
  } finally {
    if (reloaded) await reloaded.harness.lifecycle.dispose();
    await harness.lifecycle.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("recent Opencode WAL events survive old mainfile cached paints, failed reads and restarts", async (t) => {
  const { home, dataDir } = await fixture(t);
  const path = join(home, "xdg/opencode/opencode.db");
  await mkdir(join(path, ".."), { recursive: true });
  const now = Date.now(), old = new Date(now - 100 * 86400_000);
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode=WAL; pragma wal_autocheckpoint=0; create table message (time_created integer, data text); pragma wal_checkpoint(TRUNCATE)");
  await utimes(path, old, old);
  db.prepare("insert into message values (?, ?)").run(now - 86400_000, JSON.stringify({ tokens: { total: 900, input: 900 } }));
  const history = createHostTokenHistory({ dataDir, computer: hostname() });
  const { bb, harness } = fakeHost();
  let reloaded;
  try {
    const first = await history.read({ force: true });
    assert.ok((await stat(path)).mtimeMs < now - 90 * 86400_000);
    const cache = new Map(JSON.parse(await readFile(join(dataDir, "token-cache.json"), "utf8")));
    const paint = { daily: {}, files: [], sources: [] };
    seedDailyFromCache(paint.daily, paint.sources, cache, "opencode", paint.files);
    assert.equal(paint.files.length, 1);
    assert.equal(paint.files[0].observedAt, first.slices[0].observedAt);
    const expired = structuredClone([...cache]);
    expired[0][1].events[0].atMs = now - 100 * 86400_000;
    const expiredPaint = { daily: {}, files: [], sources: [] };
    seedDailyFromCache(expiredPaint.daily, expiredPaint.sources, expired, "opencode", expiredPaint.files);
    assert.equal(expiredPaint.files.length, 0);
    await plugin(bb);
    const localFirst = await harness.behavior.callRpc("getTokens", { days: 7, force: true });
    assert.equal(localFirst.totals.tokens, 900);
    db.exec("drop table message");
    const failed = await history.read({ force: true });
    const restarted = await createHostTokenHistory({ dataDir, computer: hostname() }).read({});
    for (const value of [failed, restarted]) {
      assert.equal(merged(value).machines[0].tokens, 900);
      assert.equal(value.slices[0].readError, true);
      assert.equal(value.slices[0].observedAt, first.slices[0].observedAt);
    }
    const localFailed = await harness.behavior.callRpc("getTokens", { days: 7, force: true });
    reloaded = await harness.lifecycle.reload(plugin);
    const localRestart = await reloaded.harness.behavior.callRpc("getTokens", { days: 30, force: false });
    await reloaded.harness.behavior.callRpc("getTokens", { days: 30, force: true });
    for (const value of [localFailed, localRestart]) {
      assert.equal(value.totals.tokens, 900);
      assert.equal(observation(value, "opencode").observedAt, observation(localFirst, "opencode").observedAt);
      assert.match(observation(value, "opencode").message, /could not be read/);
    }
  } finally {
    if (reloaded) await reloaded.harness.lifecycle.dispose();
    await harness.lifecycle.dispose();
    db.close();
  }
});

const privatePaths = ["/run/user/1000/pi/private-session.jsonl", "D:\\build\\pi\\private-session.jsonl", "\\\\private-server\\share\\pi.jsonl", "//private-server/share/pi.jsonl", "/Applications/private/pi.jsonl", "/custom-root/pi.jsonl"];
const privateFields = [
  (s, value) => { s.window.timezone = value; },
  (s, value) => { s.coverage.sources[0].alias = value; },
  (s, value) => { s.cost.label = value; },
  (s, value) => { s.cost.price_catalog_version = value; },
  (s, value) => { s.tasks[0].task_key = value; },
  (s, value) => { s.task_labels[0].task_key = value; },
  (s, value) => { s.task_labels[0].title = value; },
  (s, value) => { s.requested_models[0].requested_model = value; },
  (s, value) => { s.work_items[0].work_item = value; },
  (s, value) => { s.live_bins.covers = value; },
  (s, value) => { s.observation.finality = value; },
  (s, value) => { s.warnings = [`unreadable ${value}`]; },
  (s, value) => { s.quarantine = [{ [value]: 1 }]; },
  (s, value) => { s.quarantine = [{ note: value }]; },
  (s, value) => { s.consumer.quota = value; },
  (s, value) => { s.consumer.usage = value; },
  (s, value) => { s.token_semantics.input = value; },
  (s, value) => { s.token_semantics.model_identity = value; },
  (s, value) => { s.token_semantics.reasoning = value; },
];

test("absolute paths in every Pi free-text representation are refused safely through RPC", async (t) => {
  const { home } = await fixture(t);
  const location = piExportLocation(home);
  await mkdir(location.root, { recursive: true });
  const { bb, harness } = fakeHost({ hosts: [{ id: "pi", name: "homeserver", status: "connected" }], call: async ({ method }) => {
    assert.equal(method, "externalPiUsage");
    return { version: 1, ...(await readPiExportFacts({ home })) };
  } });
  try {
    await plugin(bb);
    for (const path of privatePaths) {
      for (const mutate of privateFields) {
        const snapshot = JSON.parse(piFixture);
        mutate(snapshot, path);
        const verdict = parsePiUsageSnapshot(JSON.stringify(snapshot));
        assert.equal(verdict.ok, false);
        assert.equal(verdict.reason, "privacy");
        await writeFile(location.snapshot, JSON.stringify(snapshot));
        const reading = await harness.behavior.callRpc("getExternalPiUsage", null);
        assert.equal(reading.status, "invalid");
        if (reading.data !== null) {
          assert.equal(reading.data.retained, true);
          assert.equal(reading.data.degraded, true);
          assert.deepEqual(reading.data.snapshot, JSON.parse(piFixture));
        }
        assert.ok(!JSON.stringify(reading).includes(path));
      }
      await writeFile(location.snapshot, piFixture);
      await writeFile(location.sidecar, JSON.stringify({ status: "failed", error_class: path }));
      const reading = await harness.behavior.callRpc("getExternalPiUsage", null);
      assert.equal(reading.status, "failed");
      assert.equal(reading.reason, "producer_failed_note_unreadable:privacy");
      assert.ok(!JSON.stringify(reading).includes(path));
      await rm(location.sidecar);
    }
    assert.equal(parsePiUsageSnapshot(piFixture).ok, true);
    assert.deepEqual(piPrivacyHits({ timezone: "America/New_York", parser: "pi-usage-parser/2", model: "openai/gpt-6.1-sol", hour: "2026-10-01T23:00:00+09:00", url: "https://github.com/timafen-dev/bb-plugin-provider-usage/pull/7" }), []);
  } finally {
    await harness.lifecycle.dispose();
  }
});
