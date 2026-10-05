import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
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
const { seedDailyFromCache } = await import("../lib/token-scan.ts");
const { createHostTokenHistory } = await import("../lib/host-token-history.ts");
const { dayKey } = await import("../lib/tokens.ts");

const testNow = Date.now();
const today = dayKey(testNow);
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
  tokens: { computer, scannedAt: new Date(testNow).toISOString(), changedFiles: 0, slices },
});
const slice = (provider, location, tokens) => ({
  provider,
  location,
  sourceId: location,
  observedAt: new Date(testNow).toISOString(),
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

test("newest observations win regardless of registration order", () => {
  const old = machine("offline", "pc", [slice("codex", "/a", 100)], "offline");
  const fresh = machine("connected", "pc", [slice("codex", "/a", 120)]);
  old.tokens.scannedAt = new Date(Date.now() - 300_000).toISOString();
  old.tokens.slices[0].observedAt = old.tokens.scannedAt;
  for (const sources of [[old, fresh], [fresh, old]]) {
    const merged = mergeMachineTokens(sources, 7);
    assert.equal(merged.daily[today].codex.tokens, 120);
    assert.equal(merged.fileCount, 1);
    assert.equal(merged.machines.find((row) => row.id === "connected").tokens, 120);
  }
  old.error = null;
  const retained = mergeMachineTokens([old], 7);
  assert.equal(retained.machines[0].status, "stale");
  assert.equal(retained.machines[0].tokens, 100);
});

test("Cursor representation precedence precedes observation age without inventing legacy provenance", () => {
  const cursor = (representation, tokens, at) => ({
    ...slice("cursor", "/cursor", tokens), sourceId: "/cursor/session/S", daily: {}, unknownWindow: bucket(tokens),
    observedAt: at === undefined ? undefined : new Date(at).toISOString(),
    ...(representation === undefined ? {} : { cursorRepresentation: representation }),
  });
  const cases = [
    ["acp", "chats", "older"], ["chats", "acp", "newer"],
    ["acp", "acp", "newer"], ["chats", "chats", "newer"],
    ["missing-acp", "chats", "newer"], ["chats", "missing-acp", "older"],
    ["missing-chats", "acp", "newer"], ["acp", "missing-chats", "older"],
    ["missing-acp", "missing-chats", "older"], ["missing-chats", "missing-acp", "newer"],
    [undefined, "chats", "newer"], ["acp", undefined, "newer"], [undefined, undefined, "newer"],
  ];
  for (const [oldRepresentation, newRepresentation, winner] of cases) {
    const older = machine("older", "pc", [{ ...cursor(oldRepresentation, 8120, testNow - 60_000), retained: true, readError: true }]);
    const newer = machine("newer", "pc", [cursor(newRepresentation, 8100, testNow)]);
    for (const sources of [[older, newer], [newer, older]]) {
      const original = JSON.stringify(sources);
      const merged = mergeMachineTokens(sources, 7, testNow);
      assert.equal(merged.fileCount, 1);
      assert.equal(merged.observations.length, 1);
      assert.equal(merged.observations[0].machineId, winner);
      assert.equal(merged.observations[0].unknownWindow, winner === "older" ? 8120 : 8100);
      assert.equal(merged.observations[0].observedAt, winner === "older" ? older.tokens.slices[0].observedAt : newer.tokens.slices[0].observedAt);
      assert.equal(merged.observations[0].status, winner === "older" ? "stale" : "ok");
      assert.deepEqual(merged.daily, {});
      assert.equal(JSON.stringify(sources), original);
    }
  }
  const acp = machine("acp", "pc", [{ ...cursor("acp", 8120, testNow - 60_000), retained: true, readError: true }]);
  const chats = machine("chats", "pc", [cursor("chats", 8100, testNow)]);
  const legacy = machine("legacy", "pc", [cursor(undefined, 8000, undefined)]);
  for (const sources of [[acp, chats, legacy], [legacy, chats, acp], [chats, acp, legacy], [acp, legacy, chats]]) {
    const merged = mergeMachineTokens(sources, 7, testNow);
    assert.equal(merged.observations.length, 1);
    assert.equal(merged.observations[0].unknownWindow, 8120);
    assert.equal(merged.observations[0].observedAt, acp.tokens.slices[0].observedAt);
  }
  const unknownAge = structuredClone(acp);
  delete unknownAge.tokens.slices[0].observedAt;
  const unknown = mergeMachineTokens([chats, unknownAge], 7, testNow);
  assert.equal(unknown.observations[0].unknownWindow, 8120);
  assert.equal(unknown.observations[0].observedAt, null);
  assert.equal(Object.hasOwn(legacy.tokens.slices[0], "cursorRepresentation"), false);
  for (const field of ["computer", "location", "sourceId"]) {
    const separate = structuredClone(chats);
    if (field === "computer") separate.tokens.computer = "other-pc";
    else separate.tokens.slices[0][field] += "/other";
    const merged = mergeMachineTokens([acp, separate], 7, testNow);
    assert.equal(merged.fileCount, 2);
    assert.equal(merged.observations.length, 2);
  }
});

test("Cursor removal ordering uses genuine presence observations rather than amount age or legacy guesses", () => {
  const t1 = testNow - 60_000, t2 = testNow - 30_000;
  const acp = machine("host", "pc", [{ ...slice("cursor", "/cursor", 0), sourceId: "/cursor/session/S", cursorRepresentation: "acp", daily: {}, unknownWindow: bucket(8120), retained: true, readError: true, observedAt: new Date(t1).toISOString(), cursorAcpPresence: { present: true, observedAt: new Date(t1).toISOString() } }]);
  const chats = machine("server", "pc", [{ ...slice("cursor", "/cursor", 0), sourceId: "/cursor/session/S", cursorRepresentation: "chats", daily: {}, unknownWindow: bucket(8500), observedAt: new Date(t2).toISOString(), cursorAcpPresence: { present: false, observedAt: new Date(t2).toISOString() } }]);
  for (const presentAt of [t1, testNow]) {
    const host = structuredClone(acp);
    host.tokens.slices[0].cursorAcpPresence.observedAt = new Date(presentAt).toISOString();
    for (const sources of [[host, chats], [chats, host]]) {
      const result = mergeMachineTokens(sources, 7, testNow);
      assert.equal(result.fileCount, 1);
      assert.equal(result.observations[0].unknownWindow, presentAt === t1 ? 8500 : 8120);
      assert.equal(result.observations[0].observedAt, new Date(presentAt === t1 ? t2 : t1).toISOString());
    }
  }
  for (const observedAt of ["invalid", new Date(0).toISOString(), new Date(testNow + 1).toISOString()]) {
    const invalid = structuredClone(chats);
    invalid.tokens.slices[0].cursorAcpPresence.observedAt = observedAt;
    assert.equal(mergeMachineTokens([acp, invalid], 7, testNow).observations[0].unknownWindow, 8120);
  }
  const removed = structuredClone(acp);
  removed.tokens.slices[0].cursorRepresentation = "missing-acp";
  removed.tokens.slices[0].cursorAcpPresence = { present: false, observedAt: new Date(t1).toISOString() };
  const recreated = structuredClone(chats);
  recreated.tokens.slices[0].cursorAcpPresence = { present: true, observedAt: new Date(testNow).toISOString() };
  for (const sources of [[removed, recreated], [recreated, removed]]) {
    const original = JSON.stringify(sources);
    const result = mergeMachineTokens(sources, 7, testNow);
    assert.equal(result.fileCount, 1);
    assert.equal(result.observations[0].unknownWindow, 8120);
    assert.equal(result.observations[0].observedAt, new Date(t1).toISOString());
    assert.equal(result.observations[0].status, "stale");
    assert.equal(JSON.stringify(sources), original);
  }
  const legacy = structuredClone(acp);
  delete legacy.tokens.slices[0].cursorAcpPresence;
  assert.equal(mergeMachineTokens([legacy, chats], 7, testNow).observations[0].unknownWindow, 8120);
  assert.equal(Object.hasOwn(legacy.tokens.slices[0], "cursorAcpPresence"), false);
});

test("overlapping opencode database sets count each database once", () => {
  const scan = (paths) => ({
    files: paths.map(([path, tokens]) => ({ path, daily: { [today]: bucket(tokens) } })),
    daily: { [today]: { opencode: bucket(paths.reduce((sum, [, tokens]) => sum + tokens, 0)) } },
  });
  const shared = ["/home/u/.local/share/opencode/opencode.db", 7];
  const both = slicesFromScan(scan([["/xdg/opencode/opencode.db", 5], shared]), "/home/u", { XDG_DATA_HOME: "/xdg" });
  const one = slicesFromScan(scan([shared]), "/home/u", {});
  const merged = mergeMachineTokens([machine("both", "pc", both), machine("one", "pc", one)], 7);
  assert.equal(merged.daily[today].opencode.tokens, 12);
  assert.equal(merged.fileCount, 2);
});

test("retained database slices preserve their observations across cached paints", () => {
  const path = "/home/u/.local/share/opencode/opencode.db";
  const old = new Date(testNow - 300_000).toISOString();
  const cache = new Map([[path, { daily: { [today]: bucket(100) }, events: [{ atMs: testNow, bucket: bucket(100) }], observedAt: old }]]);
  const scan = { files: [], sources: [], daily: {} };
  seedDailyFromCache(scan.daily, scan.sources, cache, "opencode", scan.files);
  const local = machine("server", "pc", slicesFromScan(scan));
  const remote = machine("host", "pc", [slice("opencode", path, 120)]);
  const merged = mergeMachineTokens([local, remote], 7, testNow);
  assert.equal(merged.daily[today].opencode.tokens, 120);
  assert.equal(merged.machines.find((row) => row.id === "server").status, "stale");
  assert.equal(mergeMachineTokens([local], 90, testNow).daily[today].opencode.tokens, 100);
  assert.equal(local.tokens.slices[0].observedAt, old);
});

test("cached paint retains missing databases alongside successfully scanned databases", () => {
  const first = "/xdg/opencode/opencode.db";
  const second = "/home/u/.local/share/opencode/opencode.db";
  const scan = {
    files: [{ path: first, daily: { [today]: bucket(5) }, observedAt: new Date(testNow).toISOString() }],
    sources: ["opencode"],
    daily: { [today]: { opencode: bucket(5) } },
  };
  const cache = new Map([[first, { daily: { [today]: bucket(4) } }], [second, { daily: { [today]: bucket(7) } }]]);
  assert.equal(seedDailyFromCache(scan.daily, scan.sources, cache, "opencode", scan.files), 1);
  assert.equal(seedDailyFromCache(scan.daily, scan.sources, cache, "opencode", scan.files), 0);
  const merged = mergeMachineTokens([machine("server", "pc", slicesFromScan(scan))], 7, testNow);
  assert.equal(merged.daily[today].opencode.tokens, 5);
  assert.equal(merged.observations.reduce((sum, row) => sum + row.unknownWindow, 0), 7);
  assert.equal(merged.fileCount, 2);
  assert.equal(merged.machines[0].status, "stale");
});

test("window totals ignore days outside the window", () => {
  const old = dayKey(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const merged = mergeMachineTokens(
    [
      machine("one", "pc", [
        { ...slice("codex", "/a", 5), daily: { [today]: bucket(5), [old]: bucket(1000) } },
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
        { path: "/acc/2/codex/sessions/a.jsonl", mtimeMs: 1, size: 1, daily: { [today]: bucket(3) } },
        { path: "/nowhere-home/.claude/projects/p/b.jsonl", mtimeMs: 1, size: 1, daily: { [today]: bucket(4) } },
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
  const dataDir = await mkdtemp(join(process.cwd(), ".test-host-tokens-"));
  try {
    const calls = [];
    const scan = async ({ cached }) => {
      calls.push(cached.size);
      return {
        files: [{ path: "/x/sessions/a.jsonl", provider: "codex", mtimeMs: 1, size: 9, daily: { [today]: bucket(42) }, events: [{ atMs: testNow, bucket: bucket(42) }], observedAt: cached.get("/x/sessions/a.jsonl")?.observedAt ?? new Date(clock).toISOString() }],
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
    const retained = await second.read({ force: true });
    assert.equal(retained.slices[0].observedAt, answer.slices[0].observedAt);
    assert.equal(retained.scannedAt, new Date(clock).toISOString());
    assert.deepEqual(calls, [0, 1]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("host warm timeout retains last answer while force awaits a cold successor", async () => {
  const dataDir = await mkdtemp(join(process.cwd(), ".test-host-tokens-"));
  try {
    let release;
    let count = 0;
    const scan = async () => {
      count += 1;
      if (count === 2) await new Promise((resolve) => (release = resolve));
      return {
        files: [{ path: "/x/sessions/a.jsonl", provider: "codex", mtimeMs: count, size: count, daily: { [today]: bucket(count) }, events: [{ atMs: Date.now(), bucket: bucket(count) }], observedAt: new Date().toISOString() }],
        changedFiles: 1,
        sources: [],
        daily: { [today]: { codex: bucket(count) } },
      };
    };
    let disposed = 0;
    let clock = Date.now();
    const history = createHostTokenHistory({ dataDir, computer: "pc", scan, now: () => clock });
    await history.read({});
    clock += 5 * 60_000;
    const stale = await history.read({
      waitMs: 10,
      retain: () => ({ dispose: () => (disposed += 1) }),
    });
    assert.equal(stale.slices[0].daily[today].tokens, 1);
    assert.equal(disposed, 0);
    const forced = history.read({ force: true, waitMs: 0, retain: () => ({ dispose: () => (disposed += 1) }) });
    release();
    const cold = await forced;
    assert.equal(cold.slices[0].daily[today].tokens, 3);
    assert.equal(disposed, 2);
    const fresh = await history.read({});
    assert.equal(fresh.slices[0].daily[today].tokens, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("host history scans real transcript folders", async () => {
  const home = await mkdtemp(join(process.cwd(), ".test-host-home-"));
  const dataDir = await mkdtemp(join(process.cwd(), ".test-host-tokens-"));
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
