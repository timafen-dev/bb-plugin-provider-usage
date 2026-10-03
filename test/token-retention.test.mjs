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
const { scanTokenFiles, seedDailyFromCache } = await import("../lib/token-scan.ts");
const { scanCursorStores } = await import("../lib/cursor-scan.ts");
const { createHostTokenHistory } = await import("../lib/host-token-history.ts");
const { slicesFromScan, mergeMachineTokens } = await import("../lib/machine-tokens.ts");
const { dayKey } = await import("../lib/tokens.ts");
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
