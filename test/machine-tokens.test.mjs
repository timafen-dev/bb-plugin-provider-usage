import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const { mergeMachineTokens, slicesFromScan } = await import(
  "../lib/machine-tokens.ts"
);
const { createHostTokenHistory } = await import("../lib/host-token-history.ts");
const { dayKey } = await import("../lib/tokens.ts");

const today = dayKey(Date.now());
const bucket = (tokens) => ({
  tokens,
  input: tokens,
  output: 0,
  cached: 0,
  reasoning: 0,
  turns: 1,
});
const machine = (id, computer, slices, error = null) => ({
  id,
  name: id,
  error,
  tokens: { computer, scannedAt: new Date().toISOString(), changedFiles: 0, slices },
});
const slice = (provider, location, tokens) => ({
  provider,
  location,
  fileCount: 1,
  daily: { [today]: bucket(tokens) },
});

test("history shared by two machines on one computer is counted once", () => {
  const merged = mergeMachineTokens(
    [
      machine("one", "pc", [slice("codex", "/a/codex", 100), slice("opencode", "/oc.db", 7)]),
      machine("two", "pc", [slice("codex", "/b/codex", 50), slice("opencode", "/oc.db", 7)]),
    ],
    7,
  );
  assert.equal(merged.daily[today].codex.tokens, 150);
  assert.equal(merged.daily[today].opencode.tokens, 7);
  assert.deepEqual(
    merged.machines.map((row) => [row.id, row.tokens]),
    [
      ["one", 107],
      ["two", 50],
    ],
  );
});

test("the same path on two computers is two histories", () => {
  const merged = mergeMachineTokens(
    [
      machine("one", "pc", [slice("codex", "/home/u/.codex/sessions", 10)]),
      machine("two", "vps", [slice("codex", "/home/u/.codex/sessions", 20)]),
    ],
    7,
  );
  assert.equal(merged.daily[today].codex.tokens, 30);
});

test("a machine that did not answer keeps its last numbers, marked stale", () => {
  const merged = mergeMachineTokens(
    [
      machine("one", "pc", [slice("codex", "/a", 10)], "Machine is offline."),
      { id: "two", name: "two", tokens: null, error: "boom" },
    ],
    7,
  );
  assert.equal(merged.daily[today].codex.tokens, 10);
  assert.deepEqual(
    merged.machines.map((row) => [row.id, row.status, row.tokens]),
    [
      ["one", "stale", 10],
      ["two", "error", 0],
    ],
  );
});

test("window totals ignore days outside the window", () => {
  const old = dayKey(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const merged = mergeMachineTokens(
    [
      machine("one", "pc", [
        { provider: "codex", location: "/a", fileCount: 1, daily: { [today]: bucket(5), [old]: bucket(1000) } },
      ]),
    ],
    30,
  );
  assert.equal(merged.machines[0].tokens, 5);
});

test("slices are keyed by where each provider's files live", () => {
  const home = "/nowhere-home";
  const env = { CODEX_HOME: "/acc/2/codex" };
  const slices = slicesFromScan(
    {
      files: [
        { path: "/acc/2/codex/sessions/a.jsonl", mtimeMs: 1, size: 1, daily: {} },
        { path: "/nowhere-home/.claude/projects/p/b.jsonl", mtimeMs: 1, size: 1, daily: {} },
      ],
      daily: { [today]: { codex: bucket(3), "claude-code": bucket(4) } },
    },
    home,
    env,
  );
  const byProvider = Object.fromEntries(slices.map((row) => [row.provider, row]));
  assert.equal(byProvider.codex.location, "/acc/2/codex/sessions");
  assert.equal(byProvider.codex.fileCount, 1);
  assert.equal(byProvider["claude-code"].location, "/nowhere-home/.claude/projects");
  assert.equal(byProvider["claude-code"].daily[today].tokens, 4);
});

test("host history reuses its parse cache and answers from disk after a restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "host-tokens-"));
  try {
    const calls = [];
    const scan = async ({ cached }) => {
      calls.push(cached.size);
      return {
        files: [{ path: "/x/sessions/a.jsonl", mtimeMs: 1, size: 9, daily: {} }],
        changedFiles: cached.size === 0 ? 1 : 0,
        sources: ["codex"],
        daily: { [today]: { codex: bucket(42) } },
      };
    };
    let clock = Date.now();
    const first = createHostTokenHistory({ dataDir, computer: "pc", scan, now: () => clock });
    const answer = await first.read({});
    assert.equal(answer.computer, "pc");
    assert.equal(answer.slices[0].daily[today].tokens, 42);
    assert.deepEqual(calls, [0]);

    // Fresh answers are served without scanning again.
    await first.read({});
    assert.deepEqual(calls, [0]);

    // A new worker starts from what the old one wrote.
    const second = createHostTokenHistory({ dataDir, computer: "pc", scan, now: () => clock });
    clock += 5 * 60_000;
    await second.read({ force: true });
    assert.deepEqual(calls, [0, 1]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("host history hands back the last answer while a slow scan continues", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "host-tokens-"));
  try {
    let release;
    let count = 0;
    const scan = async () => {
      count += 1;
      if (count === 2) await new Promise((resolve) => (release = resolve));
      return {
        files: [],
        changedFiles: 0,
        sources: [],
        daily: { [today]: { codex: bucket(count) } },
      };
    };
    let disposed = 0;
    const history = createHostTokenHistory({ dataDir, computer: "pc", scan });
    await history.read({});
    const stale = await history.read({
      force: true,
      waitMs: 10,
      retain: () => ({ dispose: () => (disposed += 1) }),
    });
    assert.equal(stale.slices[0].daily[today].tokens, 1);
    assert.equal(disposed, 0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disposed, 1);
    const fresh = await history.read({});
    assert.equal(fresh.slices[0].daily[today].tokens, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("host history scans real transcript folders", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-home-"));
  const dataDir = await mkdtemp(join(tmpdir(), "host-tokens-"));
  const saved = { ...process.env };
  try {
    const sessions = join(home, "codex", "sessions", "2026");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "s.jsonl"),
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 } },
        },
      })}\n`,
    );
    process.env.CODEX_HOME = join(home, "codex");
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    process.env.MUSE_HOME = join(home, "muse");
    process.env.XDG_DATA_HOME = join(home, "xdg");
    process.env.HOME = home;
    const history = createHostTokenHistory({ dataDir, computer: "pc" });
    const answer = await history.read({});
    const codex = answer.slices.find((row) => row.provider === "codex");
    assert.ok(codex, "codex slice present");
    assert.equal(codex.daily[today].tokens, 100);
    assert.equal(codex.fileCount, 1);
  } finally {
    process.env = saved;
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
