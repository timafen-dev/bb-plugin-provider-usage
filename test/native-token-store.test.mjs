import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { hostname } from "node:os";
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
  return { home, cleanup: async () => { process.env = saved; await rm(home, { recursive: true, force: true }); } };
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
