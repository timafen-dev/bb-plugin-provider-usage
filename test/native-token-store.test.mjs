import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { default: plugin } = await import("../server.ts");
const { dayKey } = await import("../lib/tokens.ts");
const { scanTokenFiles } = await import("../lib/token-scan.ts");
const { createHostTokenHistory } = await import("../lib/host-token-history.ts");
const { machineTokensSchema } = await import("../host-contract.ts");

async function homeForTest() {
  const home = await mkdtemp(join(process.cwd(), ".test-token-home-"));
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    CODEX_HOME: join(home, "codex"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    MUSE_HOME: join(home, "muse"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  });
  assert.equal(homedir(), home);
  return { home, cleanup: async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true });
  } };
}

function fakeHost({ hosts = [], call = async () => { throw new Error("unexpected host read"); }, listThreads = async () => [] } = {}) {
  return createFakePluginHost({
    pluginId: "provider-usage",
    sdk: { hosts: { list: async () => hosts }, threads: { list: listThreads } },
    experimental_callHostRpc: call,
  });
}

test("later host history wins over an earlier completed local force scan", async (t) => {
  const { home, cleanup } = await homeForTest();
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const sessions = join(home, "codex", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "usage.jsonl"), `${JSON.stringify({
    type: "event_msg", timestamp: new Date(now).toISOString(),
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 } } },
  })}\n`);
  let started;
  const hostStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const hostReleased = new Promise((resolve) => { release = resolve; });
  const { bb, harness } = fakeHost({
    hosts: [{ id: "host", name: "Host", status: "connected" }],
    call: async ({ method }) => {
      assert.equal(method, "tokenHistory");
      started();
      await hostReleased;
      return {
        computer: hostname(), scannedAt: new Date().toISOString(), changedFiles: 0,
        slices: [{ provider: "codex", location: sessions, fileCount: 1, daily: {
          [dayKey(now)]: { tokens: 120, input: 120, output: 0, cached: 0, reasoning: 0, turns: 1 },
        } }],
      };
    },
    listThreads: async () => { t.mock.timers.tick(1_000); return []; },
  });
  try {
    await plugin(bb);
    const reading = harness.behavior.callRpc("getTokens", { days: 7, force: true });
    await hostStarted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    t.mock.timers.tick(1_000);
    release();
    const snapshot = await reading;
    assert.equal(snapshot.providers.find((row) => row.id === "codex").tokens, 120);
    assert.equal(snapshot.machines.find((row) => row.id === "host").tokens, 120);
  } finally {
    release();
    await harness.lifecycle.dispose();
    t.mock.timers.reset();
    await cleanup();
  }
});

test("Cursor WAL cache hits retain observation age across window changes and host restarts", async (t) => {
  const { home, cleanup } = await homeForTest();
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const directory = join(home, ".cursor", "acp-sessions", "session");
  const dataDir = join(home, "host-data");
  await mkdir(directory, { recursive: true });
  await mkdir(dataDir);
  const path = join(directory, "store.db");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("create table blobs (id text primary key, data blob)");
  db.prepare("insert into blobs values (?, ?)").run("user", Buffer.from(JSON.stringify({
    role: "user", content: "hi", providerOptions: { cursor: { requestId: "request" } },
  })));
  db.prepare("insert into blobs values (?, ?)").run("assistant", Buffer.from(JSON.stringify({
    role: "assistant", content: "x".repeat(360),
  })));
  db.pragma("wal_checkpoint(TRUNCATE)");
  const fingerprint = await stat(path);
  const hosts = [{ id: "host", name: "Host", status: "disconnected" }];
  const history = createHostTokenHistory({ dataDir, computer: hostname() });
  const { bb, harness } = fakeHost({
    hosts,
    call: async ({ method }) => {
      assert.equal(method, "tokenHistory");
      return history.read({ force: true });
    },
  });
  try {
    await plugin(bb);
    const first = await harness.behavior.callRpc("getTokens", { days: 30, force: true });
    const oldTokens = first.observations.find((row) => row.provider === "cursor").unknownWindow;
    t.mock.timers.tick(1_000);
    db.prepare("update blobs set data = ? where id = 'assistant'").run(Buffer.from(JSON.stringify({
      role: "assistant", content: "x".repeat(432),
    })));
    const unchanged = await stat(path);
    assert.equal(unchanged.mtimeMs, fingerprint.mtimeMs);
    assert.equal(unchanged.size, fingerprint.size);
    const fresh = await history.read({ force: true });
    assert.equal(machineTokensSchema.safeParse(fresh).success, true);
    const newTokens = fresh.slices.find((row) => row.provider === "cursor").unknownWindow.tokens;
    assert.ok(newTokens > oldTokens);
    hosts[0].status = "connected";
    t.mock.timers.tick(1_000);
    const combined = await harness.behavior.callRpc("getTokens", { days: 30, force: true });
    assert.equal(combined.observations.find((row) => row.provider === "cursor").unknownWindow, newTokens);
    t.mock.timers.tick(1_000);
    const window = await harness.behavior.callRpc("getTokens", { days: 90, force: false });
    assert.equal(window.observations.find((row) => row.provider === "cursor").unknownWindow, newTokens);
    const cached = await history.read({});
    assert.equal(cached.slices[0].unknownWindow.tokens, newTokens);
    assert.ok(Date.parse(cached.slices[0].observedAt) >= Date.parse(fresh.slices[0].observedAt));
    assert.equal(machineTokensSchema.safeParse(cached).success, true);
    const olderAnswer = structuredClone(fresh);
    olderAnswer.scannedAt = new Date(now).toISOString();
    olderAnswer.slices.find((row) => row.provider === "cursor").unknownWindow.tokens = oldTokens;
    await writeFile(join(dataDir, "token-last.json"), JSON.stringify(olderAnswer));
    const interrupted = await createHostTokenHistory({ dataDir, computer: hostname() }).read({});
    assert.equal(interrupted.scannedAt, olderAnswer.scannedAt);
    assert.equal(interrupted.slices[0].unknownWindow.tokens, newTokens);
    t.mock.timers.tick(5 * 60_000);
    const restarted = createHostTokenHistory({ dataDir, computer: hostname() });
    const retained = await restarted.read({ force: true });
    assert.equal(retained.scannedAt, new Date().toISOString());
    assert.equal(retained.slices[0].unknownWindow.tokens, newTokens);
    const cachePath = join(dataDir, "token-cache.json");
    const rows = JSON.parse(await readFile(cachePath, "utf8"));
    for (const [, row] of rows) delete row.observedAt;
    await writeFile(cachePath, JSON.stringify(rows));
    const legacy = await createHostTokenHistory({ dataDir, computer: hostname() }).read({});
    assert.equal(legacy.slices[0].observedAt, undefined);
    assert.equal(legacy.slices[0].unknownWindow.tokens, newTokens);
  } finally {
    await harness.lifecycle.dispose();
    db.close();
    t.mock.timers.reset();
    await cleanup();
  }
});

test("JSONL and database cache hits retain their original observation times", async (t) => {
  const { home, cleanup } = await homeForTest();
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const sessions = join(home, "codex", "sessions");
  const directory = join(home, ".local", "share", "opencode");
  await mkdir(sessions, { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(sessions, "usage.jsonl"), `${JSON.stringify({
    type: "event_msg", timestamp: new Date(now).toISOString(),
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, total_tokens: 100 } } },
  })}\n`);
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(join(directory, "opencode.db"));
  db.exec("create table message (time_created integer, data text)");
  db.prepare("insert into message values (?, ?)").run(now, JSON.stringify({ tokens: { total: 200, input: 200 } }));
  db.close();
  try {
    const first = await scanTokenFiles();
    assert.equal(first.files.length, 2);
    for (const file of first.files) {
      assert.equal(file.observedAt, new Date(now).toISOString());
      assert.equal(file.retained, false);
    }
    const cache = new Map(first.files.map((file) => [file.path, file]));
    t.mock.timers.tick(60_000);
    const second = await scanTokenFiles({ cached: cache });
    assert.deepEqual(second.daily, first.daily);
    for (const file of second.files) {
      assert.equal(file.observedAt, new Date(now).toISOString());
      assert.equal(file.retained, false);
    }
    const legacyCache = new Map(first.files.map(({ observedAt, ...file }) => [file.path, file]));
    const legacy = await scanTokenFiles({ cached: legacyCache });
    for (const file of legacy.files) {
      assert.equal(file.observedAt, undefined);
      assert.equal(file.retained, false);
    }
  } finally {
    t.mock.timers.reset();
    await cleanup();
  }
});

test("persisted database history survives startup and unreadable window-change scans", async () => {
  const { home, cleanup } = await homeForTest();
  const directory = join(home, ".local", "share", "opencode");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "opencode.db");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path);
  const now = Date.now();
  db.exec("create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)");
  db.prepare("insert into message values (?, ?, ?, ?, ?)").run("message", "session", now, now, JSON.stringify({
    role: "assistant", tokens: { total: 900, input: 100, output: 50, reasoning: 0, cache: { read: 750, write: 0 } },
  }));
  db.close();
  const { bb, harness } = fakeHost();
  let reloaded;
  try {
    await plugin(bb);
    const first = await harness.behavior.callRpc("getTokens", { days: 30, force: true });
    assert.equal(first.providers.find((row) => row.id === "opencode").tokens, 900);
    await writeFile(path, "not a readable database");
    reloaded = await harness.lifecycle.reload(plugin);
    const current = reloaded.harness;
    const cached = await current.behavior.callRpc("getTokens", { days: 30, force: false });
    assert.equal(cached.providers.find((row) => row.id === "opencode").tokens, 900);
    assert.equal(cached.machines.find((row) => row.id === "server").status, "stale");
    await current.behavior.callRpc("getTokens", { days: 30, force: true });
    const window = await current.behavior.callRpc("getTokens", { days: 90, force: false });
    assert.equal(window.providers.find((row) => row.id === "opencode").tokens, 900);
    assert.equal(window.machines.find((row) => row.id === "server").status, "stale");
  } finally {
    if (reloaded) await reloaded.harness.lifecycle.dispose();
    await harness.lifecycle.dispose();
    await cleanup();
  }
});

test("local tokens CLI force cold-reconstructs Codex and Opencode in the current dashboard day", async (t) => {
  const { home, cleanup } = await homeForTest();
  const at = Date.parse("2026-10-01T23:30:00Z"), now = at + 60_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const sessions = join(home, "codex/sessions"), directory = join(home, ".local/share/opencode");
  await mkdir(sessions, { recursive: true });
  await mkdir(directory, { recursive: true });
  const codex = join(sessions, "usage.jsonl"), opencode = join(directory, "opencode.db");
  await writeFile(codex, `${JSON.stringify({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, total_tokens: 100 } } } })}\n`);
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(opencode);
  db.exec("create table message (time_created integer, data text)");
  db.prepare("insert into message values (?, ?)").run(at, JSON.stringify({ tokens: { total: 200, input: 200 } }));
  db.close();
  for (const path of [codex, opencode]) await utimes(path, new Date(now), new Date(now));
  const { bb, harness } = fakeHost();
  let reloaded;
  try {
    process.env.TZ = "Asia/Tokyo";
    await plugin(bb);
    const first = await harness.behavior.callRpc("getTokens", { days: 7, force: true });
    assert.equal(first.series.at(-1).day, "2026-10-02");
    assert.equal(first.totals.tokens, 300);
    const storage = bb.storage.database();
    for (const row of storage.prepare("select path, daily_json from token_file_cache").all()) {
      const cached = JSON.parse(row.daily_json);
      for (const event of cached.events) event.bucket.tokens = 999;
      storage.prepare("update token_file_cache set daily_json = ? where path = ?").run(JSON.stringify(cached), row.path);
    }
    process.env.TZ = "UTC";
    reloaded = await harness.lifecycle.reload(plugin);
    const result = await reloaded.harness.behavior.runCli(["tokens", "--days", "7", "--force", "--json"]);
    assert.equal(result.exitCode, 0);
    const current = JSON.parse(result.stdout);
    assert.equal(current.totals.tokens, 300);
    assert.equal(current.series.at(-1).day, "2026-10-01");
    assert.equal(current.series.at(-1).byProvider.codex, 100);
    assert.equal(current.series.at(-1).byProvider.opencode, 200);
    assert.ok(current.observations.every((row) => row.unknownWindow === 0));
  } finally {
    if (reloaded) await reloaded.harness.lifecycle.dispose();
    await harness.lifecycle.dispose();
    t.mock.timers.reset();
    await cleanup();
  }
});
