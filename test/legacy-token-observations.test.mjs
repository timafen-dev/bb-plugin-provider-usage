import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { mergeMachineTokens } = await import("../lib/machine-tokens.ts");
const { assembleTokenSnapshot, dayKey, formatTokenText } = await import("../lib/tokens.ts");
const now = Date.now();
const today = dayKey(now);
const bucket = (tokens) => ({ tokens, input: tokens, output: 0, cached: 0, reasoning: 0, turns: 1 });
const source = (id, computer, slices, error = null) => ({
  id, name: id, error, tokens: { computer, scannedAt: new Date(now).toISOString(), changedFiles: 0, slices },
});
const aggregate = (provider, location, tokens, observedAt) => ({
  provider, location, fileCount: 2, daily: { "2026-10-02": bucket(tokens) }, ...(observedAt === undefined ? {} : { observedAt }),
});
const attributed = (provider, location, tokens) => ({
  provider, location, sourceId: `${location}/A`, fileCount: 1, observedAt: new Date(now - 1000).toISOString(),
  daily: provider === "cursor" ? {} : { [today]: bucket(tokens) },
  ...(provider === "cursor" ? { unknownWindow: bucket(tokens) } : {}),
});

test("legacy150 remains historical while attributed120 owns totals in either order and at any legacy age", () => {
  for (const provider of ["codex", "claude-code", "cursor", "opencode", "muse"]) {
    for (const observedAt of [undefined, new Date(now - 5000).toISOString(), new Date(now).toISOString()]) {
      const legacy = source("offline", "pc", [aggregate(provider, "/scope", 150, observedAt)], "Machine is offline.");
      const current = source("server", "pc", [attributed(provider, "/scope", 120)]);
      for (const sources of [[legacy, current], [current, legacy]]) {
        const persisted = JSON.stringify(sources);
        const merged = mergeMachineTokens(sources, 7, now);
        assert.equal(merged.fileCount, 1);
        assert.equal(merged.machines.find((row) => row.id === "offline").tokens, 0);
        const historical = merged.observations.filter((row) => row.historicalAggregate);
        assert.equal(historical.length, 1);
        assert.equal(historical[0].rawTokens, 150);
        assert.equal(historical[0].tokens, 0);
        assert.equal(historical[0].unknownWindow, 0);
        assert.equal(historical[0].status, "stale");
        assert.equal(historical[0].observedAt, observedAt ?? null);
        assert.match(historical[0].message, /Historical overlapping observation/);
        assert.match(historical[0].message, /membership unknown; not included in totals/);
        assert.match(historical[0].message, /Machine is offline/);
        assert.equal(merged.observations.find((row) => !row.historicalAggregate).rawTokens, 120);
        if (provider === "cursor") {
          assert.deepEqual(merged.daily, {});
          assert.equal(merged.observations.find((row) => !row.historicalAggregate).unknownWindow, 120);
        } else {
          assert.equal(merged.daily[today][provider].tokens, 120);
          assert.equal(merged.machines.find((row) => row.id === "server").tokens, 120);
        }
        assert.equal(JSON.stringify(sources), persisted);
        assert.deepEqual(mergeMachineTokens(JSON.parse(persisted), 7, now), merged);
      }
    }
  }
});

test("aggregate-only responses remain visible without allocating days or using machine scan time as observation", () => {
  for (const observedAt of [undefined, "invalid", "1970-01-01T00:00:00.000Z", new Date(now + 1000).toISOString()]) {
    const merged = mergeMachineTokens([source("host", "pc", [aggregate("codex", "/scope", 150, observedAt)])], 7, now);
    assert.deepEqual(merged.daily, {});
    assert.equal(merged.fileCount, 0);
    assert.equal(merged.observations[0].rawTokens, 150);
    assert.equal(merged.observations[0].observedAt, null);
    assert.equal(merged.machines[0].status, "stale");
    const snapshot = { ...assembleTokenSnapshot({ days: 7, fileCount: 0, changedFiles: 0, sources: merged.providers, daily: merged.daily }), observations: merged.observations };
    const text = formatTokenText(snapshot);
    assert.match(text, /Historical overlapping observation · Last known 150 · observed unknown/);
    assert.match(text, /reporting-window membership unknown; not included in totals/);
    assert.doesNotMatch(text, /0 in window|150 in window|incomplete/);
  }
});

test("every overlapping aggregate is preserved rather than choosing one registration's historical record", () => {
  const earlier = new Date(now - 5000).toISOString();
  const merged = mergeMachineTokens([
    source("host", "pc", [aggregate("codex", "/scope", 150, earlier), aggregate("codex", "/scope", 140)]),
    source("peer", "pc", [aggregate("codex", "/scope", 160)]),
    source("server", "pc", [attributed("codex", "/scope", 120)]),
  ], 7, now);
  assert.equal(merged.daily[today].codex.tokens, 120);
  assert.deepEqual(merged.observations.filter((row) => row.historicalAggregate).map((row) => row.rawTokens), [150, 140, 160]);
  const snapshot = { ...assembleTokenSnapshot({ days: 7, fileCount: 1, changedFiles: 0, sources: merged.providers, daily: merged.daily }), observations: merged.observations };
  const text = formatTokenText(snapshot);
  assert.match(text, /Total\s+120 /);
  for (const amount of [150, 140, 160]) assert.match(text, new RegExp(`Historical overlapping observation · Last known ${amount} · observed`));
  assert.match(text, new RegExp(`observed ${earlier}`));
});

test("historical observations never replace attributed contributions on another computer or location", () => {
  const merged = mergeMachineTokens([
    source("history", "pc", [aggregate("codex", "/scope", 150)]),
    source("current", "pc", [attributed("codex", "/scope", 120), attributed("codex", "/other", 30)]),
    source("other-computer", "vps", [attributed("codex", "/scope", 40)]),
  ], 7, now);
  assert.equal(merged.daily[today].codex.tokens, 190);
  assert.equal(merged.fileCount, 3);
  assert.equal(merged.observations.find((row) => row.historicalAggregate).rawTokens, 150);
});
