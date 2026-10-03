import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
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
const { slicesFromScan, mergeMachineTokens } = await import("../lib/machine-tokens.ts");
const { createHostTokenHistory } = await import("../lib/host-token-history.ts");
const { machineTokensSchema } = await import("../host-contract.ts");
const { dayKey, formatTokenText, assembleTokenSnapshot } = await import("../lib/tokens.ts");
const bucket = (tokens) => ({ tokens, input: tokens, output: 0, cached: 0, reasoning: 0, turns: 1 });
const source = (id, tokens) => ({ id, name: id, error: null, tokens });

async function fixture(t) {
  const home = await mkdtemp(join(process.cwd(), ".test-provenance-"));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"), MUSE_HOME: join(home, "muse"), XDG_DATA_HOME: join(home, "xdg") });
  const dataDir = join(home, "data");
  await mkdir(dataDir);
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true });
  });
  return { home, dataDir };
}

function cursorDb(path, output) {
  const db = new DatabaseSync(path);
  db.exec("create table blobs (data blob)");
  db.prepare("insert into blobs values (?)").run(Buffer.from(JSON.stringify({ role: "user", content: "hi", providerOptions: { cursor: { requestId: "request" } } })));
  db.prepare("insert into blobs values (?)").run(Buffer.from(JSON.stringify({ role: "assistant", content: "x".repeat(output * 3.6) })));
  db.close();
}

function opencodeDb(path, atMs, tokens) {
  const db = new DatabaseSync(path);
  db.exec("create table message (time_created integer, data text)");
  db.prepare("insert into message values (?, ?)").run(atMs, JSON.stringify({ role: "assistant", tokens: { total: tokens, input: tokens } }));
  db.close();
}

async function codexFile(path, atMs, tokens) {
  await writeFile(path, JSON.stringify({ type: "event_msg", timestamp: new Date(atMs).toISOString(), payload: { type: "token_count", info: { total_token_usage: { total_tokens: tokens, input_tokens: tokens } } } }) + "\n");
}

test("per-file observations survive host persistence and select Cursor120 despite unchanged Codex t0", async (t) => {
  const { home, dataDir } = await fixture(t);
  const t0 = Date.now(), t1 = t0 + 60_000, t2 = t0 + 180_000;
  let clock = t0;
  const codex = { path: join(home, "codex/sessions/a.jsonl"), provider: "codex", mtimeMs: t0, size: 1, daily: { [dayKey(t0)]: bucket(5) }, events: [{ atMs: t0, bucket: bucket(5) }], observedAt: new Date(t0).toISOString() };
  const cursor = (tokens, at) => ({ path: join(home, ".cursor/acp-sessions/S/store.db"), provider: "cursor", mtimeMs: at, size: tokens, daily: {}, unknownWindow: bucket(tokens), observedAt: new Date(at).toISOString() });
  const scan = async () => ({ files: clock === t0 ? [codex] : [codex, cursor(120, t2)], changedFiles: 1, sources: [], daily: {} });
  const history = createHostTokenHistory({ dataDir, computer: "pc", now: () => clock, scan });
  await history.read({});
  clock = t2;
  const host = machineTokensSchema.parse(await history.read({}));
  const local = { computer: "pc", scannedAt: new Date(t1).toISOString(), changedFiles: 1, slices: slicesFromScan({ files: [codex, cursor(100, t1)], daily: {} }) };
  for (const sources of [[source("host", host), source("server", local)], [source("server", local), source("host", host)]]) {
    const merged = mergeMachineTokens(sources, 7, t2);
    assert.equal(merged.observations.find((row) => row.provider === "cursor").unknownWindow, 120);
    assert.equal(merged.observations.find((row) => row.provider === "cursor").observedAt, new Date(t2).toISOString());
    assert.equal(merged.observations.find((row) => row.provider === "codex").observedAt, new Date(t0).toISOString());
  }
  const restarted = await createHostTokenHistory({ dataDir, computer: "pc", now: () => clock, scan }).read({});
  assert.deepEqual(restarted.slices, host.slices);
  const rows = JSON.parse(await readFile(join(dataDir, "token-cache.json"), "utf8"));
  delete rows[0][1].observedAt;
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify(rows));
  const unknown = await createHostTokenHistory({ dataDir, computer: "pc", now: () => clock, scan }).read({});
  assert.equal(unknown.slices.find((row) => row.provider === "codex").observedAt, undefined);
});

test("host token wire accepts optional Cursor representation provenance and unchanged legacy slices", () => {
  const now = Date.now();
  const legacy = { computer: "pc", scannedAt: new Date(now).toISOString(), changedFiles: 0, slices: [{
    provider: "cursor", location: "/cursor", sourceId: "/cursor/session/S", fileCount: 1,
    daily: {}, unknownWindow: bucket(8120), retained: true, readError: true,
  }] };
  const parsed = machineTokensSchema.parse(legacy);
  assert.deepEqual(parsed, legacy);
  assert.equal(Object.hasOwn(parsed.slices[0], "cursorRepresentation"), false);
  assert.equal(Object.hasOwn(parsed.slices[0], "observedAt"), false);
  for (const cursorRepresentation of ["acp", "chats", "missing-acp", "missing-chats"]) {
    const wire = structuredClone(legacy);
    wire.slices[0].cursorRepresentation = cursorRepresentation;
    assert.deepEqual(machineTokensSchema.parse(JSON.parse(JSON.stringify(wire))), wire);
  }
  for (const cursorRepresentation of ["unknown", "/private/store.db", true, null]) {
    const wire = structuredClone(legacy);
    wire.slices[0].cursorRepresentation = cursorRepresentation;
    assert.equal(machineTokensSchema.safeParse(wire).success, false);
  }
});

test("newest-wins operates independently within one provider:160 not140", async () => {
  const now = Date.now();
  const slices = (first, second, firstAt, secondAt) => [
    { provider: "codex", location: "/scope", sourceId: "/scope/a", daily: { [dayKey(now)]: bucket(first) }, fileCount: 1, observedAt: new Date(firstAt).toISOString() },
    { provider: "codex", location: "/scope", sourceId: "/scope/b", daily: { [dayKey(now)]: bucket(second) }, fileCount: 1, observedAt: new Date(secondAt).toISOString() },
  ];
  const answer = (slices) => ({ computer: "pc", scannedAt: new Date(now).toISOString(), changedFiles: 0, slices });
  const merged = mergeMachineTokens([source("old", answer(slices(40, 100, now - 180_000, now - 60_000))), source("new", answer(slices(40, 120, now - 180_000, now)))], 7, now);
  assert.equal(merged.daily[dayKey(now)].codex.tokens, 160);
  assert.equal(merged.fileCount, 2);
});

test("Cursor session selection precedes scanned, retained and cached-only aggregation", async (t) => {
  const { home } = await fixture(t);
  const chats = join(home, ".cursor/chats/W/S"), acp = join(home, ".cursor/acp-sessions/S");
  await mkdir(chats, { recursive: true });
  cursorDb(join(chats, "store.db"), 100);
  const first = await scanTokenFiles();
  assert.equal(first.files[0].unknownWindow.tokens, 8100);
  await mkdir(acp, { recursive: true });
  cursorDb(join(acp, "store.db"), 120);
  const scan = await scanTokenFiles({ cached: new Map(first.files.map((file) => [file.path, file])) });
  assert.equal(scan.files.filter((file) => file.provider === "cursor").length, 1);
  assert.equal(scan.files.find((file) => file.provider === "cursor").unknownWindow.tokens, 8120);
  assert.deepEqual(scan.daily, {});
  const cache = new Map([
    [join(chats, "store.db"), { mtimeMs: 0, size: 0, daily: {}, unknownWindow: bucket(100) }],
    [join(acp, "store.db"), { mtimeMs: 0, size: 0, daily: {}, unknownWindow: bucket(120) }],
  ]);
  const paint = { daily: {}, files: [], sources: [] };
  seedDailyFromCache(paint.daily, paint.sources, cache, "cursor", paint.files);
  assert.equal(paint.files.length, 1);
  const merged = mergeMachineTokens([source("server", { computer: "pc", scannedAt: new Date().toISOString(), changedFiles: 0, slices: slicesFromScan(paint) })], 7);
  assert.equal(merged.observations[0].unknownWindow, 120);
});

test("unreadable host stores retain900 and provenance across refresh and restart", async (t) => {
  const { home, dataDir } = await fixture(t);
  const dir = join(home, "xdg/opencode");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "opencode.db");
  opencodeDb(path, Date.now(), 900);
  const history = createHostTokenHistory({ dataDir, computer: "pc" });
  const first = await history.read({ force: true });
  await writeFile(path, "corrupt sqlite");
  const retained = machineTokensSchema.parse(await history.read({ force: true }));
  assert.equal(retained.slices[0].observedAt, first.slices[0].observedAt);
  assert.equal(retained.slices[0].readError, true);
  assert.equal(Object.values(retained.slices[0].daily)[0].tokens, 900);
  const restart = await createHostTokenHistory({ dataDir, computer: "pc" }).read({});
  assert.deepEqual(restart.slices, retained.slices);
  const merged = mergeMachineTokens([source("host", restart)], 7);
  assert.equal(merged.machines[0].status, "stale");
  assert.equal(merged.observations[0].tokens, 900);
  const text = formatTokenText({ ...assembleTokenSnapshot({ days: 7, fileCount: 1, changedFiles: 0, sources: merged.providers, daily: merged.daily }), observations: merged.observations });
  assert.match(text, /observed .*Last known/);
  assert.match(text, /could not be read/);
  await utimes(path, new Date(Date.now() - 100 * 86400_000), new Date(Date.now() - 100 * 86400_000));
  const oldMainFile = await history.read({ force: true });
  assert.equal(mergeMachineTokens([source("host", oldMainFile)], 7).machines[0].tokens, 900);
});

test("removed daily-only host cache stays visible with unknown window and unknown age", async (t) => {
  const { home, dataDir } = await fixture(t);
  const path = join(home, "codex/sessions/removed.jsonl");
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify([[path, { mtimeMs: 1, size: 1, daily: { "2026-10-02": bucket(900) } }]]));
  const host = await createHostTokenHistory({ dataDir, computer: "pc" }).read({ force: true });
  const merged = mergeMachineTokens([source("host", host)], 7);
  assert.deepEqual(merged.daily, {});
  assert.equal(merged.observations[0].unknownWindow, 900);
  assert.equal(merged.observations[0].observedAt, null);
  assert.equal(host.slices[0].readError, false);
});

test("genuine instants rebucket across timezone, cold force and removed Claude replay", async (t) => {
  const { home, dataDir } = await fixture(t);
  const at = Date.parse("2026-10-01T23:30:00Z"), now = Date.parse("2026-10-01T23:45:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const codexDir = join(home, "codex/sessions"), claudeDir = join(home, "claude/projects/p"), ocDir = join(home, "xdg/opencode");
  for (const dir of [codexDir, claudeDir, ocDir]) await mkdir(dir, { recursive: true });
  await codexFile(join(codexDir, "s.jsonl"), at, 100);
  opencodeDb(join(ocDir, "opencode.db"), at, 200);
  const claude = JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { id: "same", usage: { input_tokens: 300 } } }) + "\n";
  for (const file of [join(claudeDir, "a.jsonl"), join(claudeDir, "b.jsonl")]) await writeFile(file, claude);
  for (const path of [join(codexDir, "s.jsonl"), join(ocDir, "opencode.db"), join(claudeDir, "a.jsonl"), join(claudeDir, "b.jsonl")]) await utimes(path, new Date(now), new Date(now));
  process.env.TZ = "Asia/Tokyo";
  const history = createHostTokenHistory({ dataDir, computer: "pc" });
  const host = machineTokensSchema.parse(await history.read({ force: true }));
  assert.equal(host.slices.find((row) => row.provider === "codex").daily["2026-10-02"].tokens, 100);
  process.env.TZ = "UTC";
  const merged = mergeMachineTokens([source("host", host)], 7, now);
  assert.equal(merged.daily["2026-10-01"].codex.tokens, 100);
  assert.equal(merged.daily["2026-10-01"].opencode.tokens, 200);
  assert.equal(merged.daily["2026-10-01"]["claude-code"].tokens, 300);
  const rows = JSON.parse(await readFile(join(dataDir, "token-cache.json"), "utf8"));
  for (const [, row] of rows) {
    if (row.events?.length) row.events[0].bucket.tokens = 999;
  }
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify(rows));
  const cold = await createHostTokenHistory({ dataDir, computer: "pc" }).read({ force: true });
  assert.equal(cold.slices.find((row) => row.provider === "codex").daily["2026-10-01"].tokens, 100);
  assert.equal(cold.slices.find((row) => row.provider === "opencode").daily["2026-10-01"].tokens, 200);
  await rm(claudeDir, { recursive: true });
  const replay = await createHostTokenHistory({ dataDir, computer: "pc" }).read({ force: true });
  const combined = mergeMachineTokens([source("host", replay)], 7, now);
  assert.equal(combined.daily["2026-10-01"]["claude-code"].tokens, 300);
});

test("unreadable Cursor retains its timeless amount and neutral filesystem facts", async (t) => {
  const { home, dataDir } = await fixture(t);
  const directory = join(home, ".cursor/acp-sessions/S");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "store.db");
  cursorDb(path, 100);
  const history = createHostTokenHistory({ dataDir, computer: "pc" });
  const first = await history.read({ force: true });
  await writeFile(path, "corrupt sqlite");
  const failed = await history.read({ force: true });
  assert.equal(failed.slices[0].unknownWindow.tokens, 8100);
  assert.equal(failed.slices[0].observedAt, first.slices[0].observedAt);
  assert.equal(failed.slices[0].birthMs, first.slices[0].birthMs);
  assert.equal(failed.slices[0].mtimeMs, first.slices[0].mtimeMs);
  assert.equal(failed.slices[0].readError, true);
  const restarted = await createHostTokenHistory({ dataDir, computer: "pc" }).read({});
  assert.deepEqual(restarted.slices, failed.slices);
  const merged = mergeMachineTokens([source("host", restarted)], 7);
  assert.deepEqual(merged.daily, {});
  assert.equal(merged.observations[0].unknownWindow, 8100);
});

test("unreadable legacy stores expose raw900 without guessing reporting-day membership", async (t) => {
  const { home, dataDir } = await fixture(t);
  const directory = join(home, "xdg/opencode");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "opencode.db");
  await writeFile(path, "corrupt sqlite");
  const info = await stat(path);
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify([[path, { mtimeMs: Math.round(info.mtimeMs), size: info.size, daily: { "2026-10-02": bucket(900) } }]]));
  const host = await createHostTokenHistory({ dataDir, computer: "pc" }).read({ force: true });
  const merged = mergeMachineTokens([source("host", host)], 7);
  assert.deepEqual(merged.daily, {});
  assert.equal(merged.observations[0].rawTokens, 900);
  assert.equal(merged.observations[0].unknownWindow, 0);
  assert.equal(merged.observations[0].status, "stale");
  assert.match(merged.observations[0].message, /reporting-day membership cannot be recovered/);
});

test("fresh legacy host caches cold-reconstruct readable originals before returning after restart", async (t) => {
  const { home, dataDir } = await fixture(t);
  const at = Date.parse("2026-10-01T23:30:00Z"), now = at + 60_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const codexDir = join(home, "codex/sessions"), ocDir = join(home, "xdg/opencode"), claudeDir = join(home, "claude/projects/p");
  for (const directory of [codexDir, ocDir, claudeDir]) await mkdir(directory, { recursive: true });
  const codex = join(codexDir, "s.jsonl"), oc = join(ocDir, "opencode.db");
  await codexFile(codex, at, 100);
  opencodeDb(oc, at, 200);
  const claude = JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { id: "same", usage: { input_tokens: 300 } } }) + "\n";
  const paths = [codex, oc, join(claudeDir, "a.jsonl"), join(claudeDir, "b.jsonl")];
  for (const path of paths.slice(2)) await writeFile(path, claude);
  for (const path of paths) await utimes(path, new Date(now), new Date(now));
  process.env.TZ = "Asia/Tokyo";
  const old = await scanTokenFiles();
  assert.equal(old.daily["2026-10-02"].codex.tokens, 100);
  const legacy = old.files.map(({ events, path, ...entry }) => [path, entry]);
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify(legacy));
  await writeFile(join(dataDir, "token-last.json"), JSON.stringify({ computer: "pc", scannedAt: new Date(now).toISOString(), changedFiles: 0, slices: slicesFromScan(old) }));
  process.env.TZ = "UTC";
  const restored = machineTokensSchema.parse(await createHostTokenHistory({ dataDir, computer: "pc" }).read({}));
  assert.ok(restored.slices.every((slice) => slice.events !== undefined));
  assert.equal(restored.slices.find((slice) => slice.provider === "codex").daily["2026-10-01"].tokens, 100);
  assert.equal(restored.slices.find((slice) => slice.provider === "opencode").daily["2026-10-01"].tokens, 200);
  const merged = mergeMachineTokens([source("host", restored)], 7, now);
  assert.equal(merged.machines[0].tokens, 600);
  assert.equal(merged.daily["2026-10-01"]["claude-code"].tokens, 300);
  assert.equal(merged.daily["2026-10-02"], undefined);
  assert.ok(merged.observations.every((row) => row.unknownWindow === 0));
  const replay = await createHostTokenHistory({ dataDir, computer: "pc" }).read({});
  assert.deepEqual(replay.slices, restored.slices);
});

test("fresh removed legacy host caches separate irrecoverable amounts from surviving keyed instants", async (t) => {
  const { home, dataDir } = await fixture(t);
  const at = Date.parse("2026-10-01T23:30:00Z"), now = at + 60_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  process.env.TZ = "UTC";
  const rows = [
    [join(home, "codex/sessions/removed.jsonl"), { mtimeMs: now, size: 1, daily: { "2026-10-02": bucket(100) } }],
    [join(home, "xdg/opencode/opencode.db"), { mtimeMs: now, size: 1, daily: { "2026-10-02": bucket(200) } }],
    ...["a", "b"].map((name) => [join(home, `claude/projects/p/${name}.jsonl`), { mtimeMs: now, size: 1, daily: name === "a" ? { "2026-10-02": bucket(50) } : {}, observedAt: new Date(at).toISOString(), keyedEvents: { same: { atMs: at, bucket: bucket(900) } } }]),
  ];
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify(rows));
  await writeFile(join(dataDir, "token-last.json"), JSON.stringify({ computer: "pc", scannedAt: new Date(now).toISOString(), changedFiles: 0, slices: [] }));
  const restored = machineTokensSchema.parse(await createHostTokenHistory({ dataDir, computer: "pc" }).read({}));
  const merged = mergeMachineTokens([source("host", restored)], 7, now);
  assert.equal(merged.daily["2026-10-01"]["claude-code"].tokens, 900);
  assert.equal(merged.daily["2026-10-02"], undefined);
  assert.equal(merged.observations.reduce((total, row) => total + row.unknownWindow, 0), 350);
  assert.equal(merged.observations.reduce((total, row) => total + row.rawTokens, 0), 1250);
  assert.ok(merged.observations.filter((row) => row.provider === "claude-code").every((row) => row.observedAt === new Date(at).toISOString()));
  const snapshot = { ...assembleTokenSnapshot({ days: 7, fileCount: merged.fileCount, changedFiles: 0, sources: merged.providers, daily: merged.daily }), observations: merged.observations };
  const text = formatTokenText(snapshot);
  assert.match(text, /Last known 100 · unknown window/);
  assert.match(text, /Last known 200 · unknown window/);
  assert.match(text, /Last known 50 · unknown window/);
  assert.deepEqual((await createHostTokenHistory({ dataDir, computer: "pc" }).read({})).slices, restored.slices);
});

test("legacy Cursor history stays unplaced across fresh restart, force, cached paint and growth", async (t) => {
  const { home, dataDir } = await fixture(t);
  const directory = join(home, ".cursor/acp-sessions/S");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "store.db");
  cursorDb(path, 100);
  const info = await stat(path), now = Date.now(), observedAt = new Date(now - 60_000).toISOString();
  const daily = {
    "2026-10-01": { ...bucket(8000), input: 8000 },
    "2026-10-02": { ...bucket(600), input: 0, output: 600, turns: 0 },
  };
  const entry = { mtimeMs: Math.round(info.mtimeMs), birthMs: Math.round(info.birthtimeMs), size: info.size, daily, blobCount: 2, maxRowid: 2, observedAt };
  await writeFile(join(dataDir, "token-cache.json"), JSON.stringify([[path, entry]]));
  await writeFile(join(dataDir, "token-last.json"), JSON.stringify({ computer: "pc", scannedAt: new Date(now).toISOString(), changedFiles: 0, slices: [] }));
  const history = createHostTokenHistory({ dataDir, computer: "pc" });
  const fresh = await history.read({});
  assert.deepEqual(fresh.slices[0].daily, {});
  assert.equal(fresh.slices[0].unknownWindow.tokens, 8600);
  const forced = await history.read({ force: true });
  assert.deepEqual(forced.slices[0].daily, {});
  assert.equal(forced.slices[0].unknownWindow.tokens, 8600);
  assert.equal(forced.slices[0].observedAt, observedAt);
  const paint = { daily: {}, sources: [], files: [] };
  seedDailyFromCache(paint.daily, paint.sources, new Map([[path, entry]]), "cursor", paint.files);
  assert.deepEqual(paint.daily, {});
  assert.equal(slicesFromScan(paint)[0].unknownWindow.tokens, 8600);
  const db = new DatabaseSync(path);
  db.prepare("update blobs set data = ? where rowid = 2").run(Buffer.from(JSON.stringify({ role: "assistant", content: "x".repeat(6480) })));
  db.close();
  const grown = machineTokensSchema.parse(await history.read({ force: true }));
  assert.equal(grown.slices[0].unknownWindow.tokens, 9800);
  assert.deepEqual(grown.slices[0].daily, {});
  const merged = mergeMachineTokens([source("host", grown)], 7);
  assert.deepEqual(merged.daily, {});
  assert.equal(merged.observations[0].rawTokens, 9800);
  assert.equal(merged.observations[0].unknownWindow, 9800);
  assert.equal(merged.observations[0].birthMs, Math.round(info.birthtimeMs));
  const text = formatTokenText({ ...assembleTokenSnapshot({ days: 7, fileCount: 1, changedFiles: 0, sources: merged.providers, daily: merged.daily }), observations: merged.observations });
  assert.match(text, /unknown window/);
  assert.match(text, /Filesystem birth/);
  assert.match(text, /Filesystem mtime/);
  assert.doesNotMatch(text, /not earlier|not later|event time/i);
});
