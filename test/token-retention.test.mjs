import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { scanTokenFiles, seedDailyFromCache, selectCursorFiles, dailyFromFiles } = await import("../lib/token-scan.ts");
const { scanCursorStores } = await import("../lib/cursor-scan.ts");
const { createHostTokenHistory } = await import("../lib/host-token-history.ts");
const { slicesFromScan, mergeMachineTokens } = await import("../lib/machine-tokens.ts");
const { dayKey, assembleTokenSnapshot, formatTokenText, formatTokenCount } = await import("../lib/tokens.ts");
const bucket = (tokens) => ({ tokens, input: tokens, output: 0, cached: 0, reasoning: 0, turns: 1 });

async function fixture(t) {
  const home = await fsPromises.mkdtemp(join(process.cwd(), ".test-retention-"));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"), MUSE_HOME: join(home, "muse"), XDG_DATA_HOME: join(home, "xdg") });
  const dataDir = join(home, "data");
  await fsPromises.mkdir(dataDir);
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fsPromises.rm(home, { recursive: true, force: true });
  });
  return { home, dataDir };
}

const pathsFor = (home) => [
  ["codex", join(home, "codex/sessions/a.jsonl")],
  ["claude-code", join(home, "claude/projects/p/a.jsonl")],
  ["muse", join(home, "muse/data/sessions/a.jsonl")],
  ["cursor", join(home, ".cursor/acp-sessions/S/store.db")],
  ["opencode", join(home, "xdg/opencode/opencode.db")],
];

function assertRetained(file, entry, provider) {
  assert.equal(file.readError, true);
  assert.equal(file.retained, true);
  for (const field of ["observedAt", "mtimeMs", "birthMs", "events", "keyedEvents"]) assert.deepEqual(file[field], entry[field]);
  assert.deepEqual(file.daily, provider === "cursor" ? {} : entry.daily);
  assert.equal(file.unknownWindow.tokens, provider === "cursor" ? 900 : entry.unknownWindow?.tokens ?? 0);
}

test("stat access and I/O failures preserve live representations in scans, paints and host restarts", async (t) => {
  const { home, dataDir } = await fixture(t);
  const now = Date.now(), observedAt = new Date(now - 60_000).toISOString();
  const paths = pathsFor(home), inaccessible = new Set(paths.map(([, path]) => path));
  for (const [, path] of paths) {
    await fsPromises.mkdir(join(path, ".."), { recursive: true });
    await fsPromises.writeFile(path, "unreadable source");
  }
  const statSync = fs.statSync, stat = fsPromises.stat;
  let code;
  const failure = () => Object.assign(new Error("synthetic stat failure"), { code });
  t.mock.method(fs, "statSync", (path, ...args) => { if (inaccessible.has(path)) throw failure(); return statSync(path, ...args); });
  t.mock.method(fsPromises, "stat", (path, ...args) => { if (inaccessible.has(path)) return Promise.reject(failure()); return stat(path, ...args); });
  syncBuiltinESMExports();
  for (code of ["EACCES", "EPERM", "EIO"]) {
    for (const modern of [false, true]) {
      for (const priorError of [false, true]) {
        const rows = paths.map(([provider, path]) => [path, {
          provider, mtimeMs: now, birthMs: now - 1000, size: 1, observedAt, readError: priorError,
          daily: provider === "cursor" && modern ? {} : { [dayKey(now)]: bucket(900) },
          ...(modern ? provider === "cursor" ? { unknownWindow: bucket(900) } : { events: [{ atMs: now, bucket: bucket(900) }] } : {}),
          ...(provider === "claude-code" ? { keyedEvents: { message: { atMs: now, bucket: bucket(10) } } } : {}),
        }]);
        const cached = new Map(rows);
        const scan = await scanTokenFiles({ cached, force: true, nowMs: now });
        assert.equal(scan.files.length, paths.length);
        for (const file of scan.files) assertRetained(file, cached.get(file.path), file.provider);
        const paint = { files: [], daily: {}, sources: [] };
        for (const provider of ["cursor", "opencode"]) {
          assert.equal(seedDailyFromCache(paint.daily, paint.sources, cached, provider, paint.files), 1);
        }
        for (const file of paint.files) assertRetained(file, cached.get(file.path), file.provider);
        await fsPromises.writeFile(join(dataDir, "token-cache.json"), JSON.stringify(rows));
        const host = await createHostTokenHistory({ dataDir, computer: "pc" }).read({ force: true });
        assert.deepEqual(host.slices, slicesFromScan(scan));
        const persisted = new Map(JSON.parse(await fsPromises.readFile(join(dataDir, "token-cache.json"), "utf8")));
        for (const [path, file] of persisted) assertRetained(file, cached.get(path), file.provider);
        const restart = await createHostTokenHistory({ dataDir, computer: "pc" }).read({});
        assert.deepEqual(restart.slices, host.slices);
        const merged = mergeMachineTokens([{ id: "host", name: "Host", error: null, tokens: restart }], 7, now);
        assert.equal(merged.machines[0].status, "stale");
        for (const row of merged.observations) {
          assert.equal(row.observedAt, observedAt);
          assert.equal(row.status, "stale");
          assert.match(row.message, /could not be read/);
          assert.equal(row.unknownWindow, row.provider === "cursor" ? 900 : 0);
        }
      }
    }
  }
});

test("only missing paths and non-directory parents unplace removed legacy amounts", async (t) => {
  const { home } = await fixture(t);
  const now = Date.now();
  for (const nonDirectory of [false, true]) {
    const root = join(home, nonDirectory ? "not-directory" : "missing");
    if (nonDirectory) await fsPromises.writeFile(root, "file");
    const cached = new Map(pathsFor(root).map(([provider, path]) => [path, { provider, mtimeMs: now, size: 1, readError: true, daily: { [dayKey(now)]: bucket(900) } }]));
    const scan = await scanTokenFiles({ cached, force: true });
    assert.equal(scan.files.length, 5);
    for (const file of scan.files) {
      assert.equal(file.readError, false);
      assert.deepEqual(file.daily, {});
      assert.equal(file.unknownWindow.tokens, 900);
    }
  }
});

test("Cursor retention matches scanner expiry for both stores and preserves failed-read900", async (t) => {
  const { home, dataDir } = await fixture(t);
  const now = Date.now(), old = now - 100 * 86400_000, recent = now - 86400_000;
  const observedAt = new Date(now - 60_000).toISOString();
  const paths = [join(home, ".cursor/acp-sessions/A/store.db"), join(home, ".cursor/chats/W/B/store.db")];
  for (const path of paths) {
    await fsPromises.mkdir(join(path, ".."), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("create table blobs (data blob)");
    db.close();
  }
  const statSync = fs.statSync;
  let mtimeMs, birthtimeMs, legacy;
  t.mock.method(fs, "statSync", (path, ...args) => {
    const info = statSync(path, ...args);
    if (!paths.includes(path)) return info;
    return Object.assign(info, { mtimeMs, birthtimeMs });
  });
  syncBuiltinESMExports();
  const times = [[old, recent], [recent, old], [recent, recent], [old, old], [old, NaN]];
  for ([mtimeMs, birthtimeMs, legacy] of times.flatMap(([mtime, birth]) => [false, true].map((legacy) => [mtime, birth, legacy]))) {
    const admitted = mtimeMs >= now - 90 * 86400_000 || (Number.isFinite(birthtimeMs) && birthtimeMs >= now - 90 * 86400_000);
    const rows = paths.map((path) => [path, { provider: "cursor", mtimeMs, birthMs: Number.isFinite(birthtimeMs) ? birthtimeMs : mtimeMs, size: statSync(path).size, observedAt,
      ...(legacy ? { daily: { [dayKey(now)]: bucket(900) } } : { daily: {}, unknownWindow: bucket(900) }),
    }]);
    const cached = new Map(rows);
    assert.equal(scanCursorStores({ cached, nowMs: now }).length, admitted ? 2 : 0);
    const paint = { files: [], daily: {}, sources: [] };
    assert.equal(seedDailyFromCache(paint.daily, paint.sources, cached, "cursor", paint.files), admitted ? 2 : 0);
    assert.deepEqual(paint.daily, {});
    for (const file of paint.files) {
      assert.equal(file.unknownWindow.tokens, 900);
      assert.equal(file.observedAt, observedAt);
      assert.equal(file.readError, false);
      assert.equal(file.mtimeMs, mtimeMs);
      assert.equal(file.birthMs, birthtimeMs);
    }
    for (const path of paths) {
      const db = new DatabaseSync(path);
      db.exec("drop table if exists blobs");
      db.close();
    }
    await fsPromises.writeFile(join(dataDir, "token-cache.json"), JSON.stringify(rows));
    const host = await createHostTokenHistory({ dataDir, computer: "pc" }).read({ force: true });
    assert.equal(host.slices.length, admitted ? 2 : 0);
    for (const slice of host.slices) {
      assert.equal(slice.unknownWindow.tokens, 900);
      assert.equal(slice.observedAt, observedAt);
      assert.equal(slice.readError, true);
      assert.deepEqual(slice.daily, {});
      assert.equal(slice.mtimeMs, mtimeMs);
      assert.equal(slice.birthMs, birthtimeMs);
    }
    const restart = await createHostTokenHistory({ dataDir, computer: "pc" }).read({});
    assert.deepEqual(restart.slices, host.slices);
    for (const path of paths) {
      const db = new DatabaseSync(path);
      db.exec("create table blobs (data blob)");
      db.prepare("insert into blobs values (?)").run(Buffer.from(JSON.stringify({ role: "user", content: "hi", providerOptions: { cursor: { requestId: "request" } } })));
      db.close();
    }
    const recovered = await scanTokenFiles({ cached, force: true, nowMs: now });
    assert.equal(recovered.files.length, admitted ? 2 : 0);
    for (const file of recovered.files) assert.equal(file.readError, undefined);
  }
});

test("competing chats8100 cannot replace inaccessible ACP8120 across refresh, paint and restart", async (t) => {
  const { home, dataDir } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const chats = join(home, ".cursor/chats/W/S/store.db"), acp = join(home, ".cursor/acp-sessions/S/store.db");
  const createStore = async (path, output) => {
    await fsPromises.mkdir(join(path, ".."), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("create table blobs (data blob)");
    const insert = db.prepare("insert into blobs values (?)");
    insert.run(Buffer.from(JSON.stringify({ role: "user", content: "hi", providerOptions: { cursor: { requestId: "request" } } })));
    insert.run(Buffer.from(JSON.stringify({ role: "assistant", content: "x".repeat(output * 3.6) })));
    db.close();
  };
  const history = createHostTokenHistory({ dataDir, computer: "pc" });
  await createStore(chats, 100);
  const first = await history.read({ force: true });
  assert.equal(first.slices[0].unknownWindow.tokens, 8100);
  const chatsCache = JSON.parse(await fsPromises.readFile(join(dataDir, "token-cache.json"), "utf8"))[0][1];
  t.mock.timers.tick(60_000);
  await createStore(acp, 120);
  const second = await history.read({ force: true });
  assert.equal(second.slices.length, 1);
  assert.equal(second.slices[0].unknownWindow.tokens, 8120);
  const cached = new Map(JSON.parse(await fsPromises.readFile(join(dataDir, "token-cache.json"), "utf8")));
  assert.deepEqual([...cached.keys()], [acp]);
  const statSync = fs.statSync, existsSync = fs.existsSync;
  let code;
  t.mock.method(fs, "statSync", (path, ...args) => {
    if (path === acp) throw Object.assign(new Error("synthetic inaccessible ACP"), { code });
    return statSync(path, ...args);
  });
  t.mock.method(fs, "existsSync", (path) => path === acp ? false : existsSync(path));
  syncBuiltinESMExports();
  for (code of ["EACCES", "EPERM", "EIO"]) {
    t.mock.timers.tick(60_000);
    assert.equal(scanCursorStores({ cached }).at(0).path, chats);
    const scan = await scanTokenFiles({ cached, force: true });
    assert.deepEqual(scan.files.map((file) => file.path), [acp]);
    const expected = [{ ...second.slices[0], retained: true, readError: true }];
    assert.deepEqual(slicesFromScan(scan), expected);
    const paint = { files: [{ ...chatsCache, path: chats }], daily: {}, sources: ["cursor"] };
    seedDailyFromCache(paint.daily, paint.sources, cached, "cursor", paint.files);
    assert.deepEqual(paint.files.map((file) => file.path), [acp]);
    assert.deepEqual(slicesFromScan(paint), expected);
    assert.deepEqual(paint.daily, {});
    const retained = await history.read({ force: true });
    assert.deepEqual(retained.slices, expected);
    const persisted = JSON.parse(await fsPromises.readFile(join(dataDir, "token-cache.json"), "utf8"));
    assert.deepEqual(persisted.map(([path]) => path), [acp]);
    assert.equal(persisted[0][1].unknownWindow.tokens, 8120);
    assert.equal(persisted[0][1].observedAt, second.slices[0].observedAt);
    assert.equal(persisted[0][1].readError, true);
    const restarted = createHostTokenHistory({ dataDir, computer: "pc" });
    assert.deepEqual((await restarted.read({})).slices, expected);
    const refreshed = await restarted.read({ force: true });
    assert.deepEqual(refreshed.slices, expected);
    const local = await scanTokenFiles({ force: true });
    assert.deepEqual(local.files.map((file) => file.path), [chats]);
    const server = { id: "server", name: "Server", error: null, tokens: {
      computer: "pc", scannedAt: new Date().toISOString(), changedFiles: local.changedFiles, slices: slicesFromScan(local),
    } };
    const host = { id: "host", name: "Host", error: null, tokens: JSON.parse(JSON.stringify(refreshed)) };
    assert.equal(host.tokens.slices[0].cursorRepresentation, "acp");
    assert.equal(server.tokens.slices[0].cursorRepresentation, "chats");
    assert.equal(server.tokens.slices[0].sourceId, host.tokens.slices[0].sourceId);
    assert.ok(Date.parse(server.tokens.slices[0].observedAt) > Date.parse(host.tokens.slices[0].observedAt));
    for (const sources of [[host, server], [server, host], JSON.parse(JSON.stringify([server, host]))]) {
      const merged = mergeMachineTokens(sources, 7);
      assert.equal(merged.fileCount, 1);
      assert.deepEqual(merged.daily, {});
      assert.equal(merged.observations.length, 1);
      assert.equal(merged.observations[0].machineId, "host");
      assert.equal(merged.observations[0].unknownWindow, 8120);
      assert.equal(merged.observations[0].rawTokens, 8120);
      assert.equal(merged.observations[0].observedAt, second.slices[0].observedAt);
      assert.equal(merged.observations[0].status, "stale");
      const text = formatTokenText({ ...assembleTokenSnapshot({ days: 7, fileCount: 1, changedFiles: 0, sources: merged.providers, daily: merged.daily }), observations: merged.observations });
      assert.ok(text.includes(`Last known ${formatTokenCount(8120)} · unknown window`));
      assert.ok(text.includes(`observed ${second.slices[0].observedAt}`));
      assert.match(text, /could not be read/);
    }
  }
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const recovered = await history.read({ force: true });
  assert.equal(recovered.slices.length, 1);
  assert.equal(recovered.slices[0].unknownWindow.tokens, 8120);
  assert.equal(recovered.slices[0].readError, undefined);
  assert.equal(recovered.slices[0].retained, false);
});

test("Cursor selection distinguishes proven absence in either direction and cache representation", async (t) => {
  const { home } = await fixture(t);
  const chats = join(home, ".cursor/chats/W/S/store.db"), acp = join(home, ".cursor/acp-sessions/S/store.db");
  for (const path of [chats, acp]) {
    await fsPromises.mkdir(join(path, ".."), { recursive: true });
    await fsPromises.writeFile(path, "store");
  }
  const statSync = fs.statSync;
  let faults = new Map();
  t.mock.method(fs, "statSync", (path, ...args) => {
    if (faults.get(path)) throw Object.assign(new Error("synthetic source stat failure"), { code: faults.get(path) });
    return statSync(path, ...args);
  });
  syncBuiltinESMExports();
  const cases = [[null, null, acp], ["ENOENT", null, chats], ["ENOTDIR", null, chats], [null, "ENOENT", acp], [null, "ENOTDIR", acp], ["ENOENT", "ENOTDIR", acp]];
  for (const code of ["EACCES", "EPERM", "EIO"]) cases.push([code, null, acp], [null, code, acp], [code, code, acp], [code, "ENOENT", acp], ["ENOENT", code, chats]);
  const now = Date.now(), observedAt = new Date(now - 60_000).toISOString();
  for (const [acpCode, chatsCode, chosen] of cases) {
    faults = new Map([[acp, acpCode], [chats, chatsCode]]);
    for (const legacy of [false, true]) {
      const files = [[chats, 8100], [acp, 8120]].map(([path, tokens]) => ({
        path, provider: "cursor", observedAt, mtimeMs: now, birthMs: now - 1000, size: 1,
        ...(legacy ? { daily: { [dayKey(now)]: bucket(tokens) } } : { daily: {}, unknownWindow: bucket(tokens) }),
      }));
      for (const rows of [files, [...files].reverse()]) {
        const prior = structuredClone(rows);
        const selected = selectCursorFiles(rows);
        assert.deepEqual(selected.map((file) => file.path), [chosen]);
        assert.deepEqual(rows, prior);
        const tokens = chosen === acp ? 8120 : 8100;
        assert.deepEqual(dailyFromFiles(rows), legacy ? { [dayKey(now)]: { cursor: bucket(tokens) } } : {});
        const slices = slicesFromScan({ files: rows, daily: {} });
        assert.equal(slices.length, 1);
        assert.equal(slices[0].unknownWindow.tokens, tokens);
        assert.equal(slices[0].observedAt, observedAt);
        const representation = chosen === acp ? "acp" : "chats";
        const missing = ["ENOENT", "ENOTDIR"].includes(faults.get(chosen));
        assert.equal(slices[0].cursorRepresentation, `${missing ? "missing-" : ""}${representation}`);
        const paint = { files: [], daily: {}, sources: [] };
        seedDailyFromCache(paint.daily, paint.sources, rows.map(({ path, ...entry }) => [path, entry]), "cursor", paint.files);
        assert.deepEqual(paint.files.map((file) => file.path), [chosen]);
        assert.equal(paint.files[0].unknownWindow.tokens, tokens);
        assert.equal(paint.files[0].observedAt, observedAt);
        assert.deepEqual(paint.daily, {});
      }
    }
  }
});
