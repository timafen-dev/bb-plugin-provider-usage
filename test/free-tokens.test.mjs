import assert from "node:assert/strict";
import { test } from "node:test";
const {
  groupAgainstLimits, limitFor, parseAdminAccounts, parseDailyLimits,
  parseTokenAmount, secondsUntilReset, startOfUtcDay, tokensByModel,
} = await import("../lib/free-tokens.ts");

test("reads accounts one per line, labelled or not", () => {
  const accounts = parseAdminAccounts("Нус = sk-admin-aaa111\n\n# комментарий\nsk-admin-bbb222\n");
  assert.deepEqual(accounts.map((a) => a.label), ["Нус", "…bbb222"]);
  assert.deepEqual(accounts.map((a) => a.key), ["sk-admin-aaa111", "sk-admin-bbb222"]);
});

test("a line without a key is skipped rather than creating an empty account", () => {
  assert.deepEqual(parseAdminAccounts("Метка =\n   \n"), []);
});

test("understands the shorthand people actually type for amounts", () => {
  assert.equal(parseTokenAmount("5M"), 5_000_000);
  assert.equal(parseTokenAmount("250k"), 250_000);
  assert.equal(parseTokenAmount("900 000"), 900000);
  assert.equal(parseTokenAmount("1_000_000"), 1_000_000);
  assert.equal(parseTokenAmount("2,5M"), 2_500_000);
  assert.equal(parseTokenAmount("нисколько"), null);
});

test("a line is one allowance shared by every model on it", () => {
  const limits = parseDailyLimits("Крупные: gpt-5*, gpt-4.1*, o3* = 250k\nМелкие: gpt-5-mini*, o4-mini* = 2.5M");
  assert.deepEqual(limits.map((l) => [l.label, l.patterns.length, l.tokens]), [
    ["Крупные", 3, 250_000],
    ["Мелкие", 2, 2_500_000],
  ]);
});

test("without a name the models name the row themselves", () => {
  const [limit] = parseDailyLimits("gpt-5*, gpt-4.1* = 250k");
  assert.equal(limit.label, "gpt-5*, gpt-4.1*");
});

test("the most specific pattern wins, across groups", () => {
  const limits = parseDailyLimits("Крупные: gpt-5*, gpt-4.1* = 250k\nМелкие: gpt-4.1-mini* = 2.5M");
  assert.equal(limitFor("gpt-4.1-mini-2025-04-14", limits)?.tokens, 2_500_000);
  assert.equal(limitFor("gpt-4.1-2025-04-14", limits)?.tokens, 250_000);
  assert.equal(limitFor("claude-opus", limits), null);
});

test("a dated model id still lands in its group", () => {
  const limits = parseDailyLimits("Крупные: o3* = 250k");
  assert.equal(limitFor("o3-2025-04-16", limits)?.tokens, 250_000);
});

test("sums input and output tokens per model across buckets", () => {
  const usage = tokensByModel({
    data: [
      { results: [
        { model: "gpt-5", input_tokens: 100, output_tokens: 50 },
        { model: "gpt-5-mini", input_tokens: 10, output_tokens: 5 },
      ] },
      { results: [{ model: "gpt-5", input_tokens: 1, output_tokens: 1 }] },
    ],
  });
  assert.deepEqual(usage, [
    { model: "gpt-5", tokens: 152 },
    { model: "gpt-5-mini", tokens: 15 },
  ]);
});

test("a shape that is not the usage answer yields nothing instead of throwing", () => {
  assert.deepEqual(tokensByModel(null), []);
  assert.deepEqual(tokensByModel({ data: "нет" }), []);
  assert.deepEqual(tokensByModel({ data: [{ results: [null, 7] }] }), []);
});

test("groups usage under its allowance and reports what is left", () => {
  const limits = parseDailyLimits("Крупные: gpt-5* = 1M\nМелкие: gpt-5-mini = 10M");
  const { groups, unlimited } = groupAgainstLimits(
    [
      { model: "gpt-5", tokens: 250_000 },
      { model: "gpt-5-codex", tokens: 250_000 },
      { model: "gpt-5-mini", tokens: 1_000_000 },
      { model: "some-other-model", tokens: 42 },
    ],
    limits,
  );
  const big = groups.find((g) => g.label === "Крупные");
  assert.equal(big?.used, 500_000);
  assert.equal(big?.remainingPercent, 50);
  assert.equal(groups.find((g) => g.label === "Мелкие")?.remainingPercent, 90);
  // Spend with no allowance is still shown, not silently dropped.
  assert.deepEqual(unlimited, [{ model: "some-other-model", tokens: 42 }]);
});

test("an allowance with no spend today is still listed, at full", () => {
  const { groups } = groupAgainstLimits([], parseDailyLimits("Крупные: gpt-5* = 1M"));
  assert.deepEqual(groups.map((g) => [g.label, g.used, g.remainingPercent]), [["Крупные", 0, 100]]);
});

test("going over the allowance clamps at nothing left, not a negative", () => {
  const { groups } = groupAgainstLimits(
    [{ model: "gpt-5", tokens: 3_000_000 }],
    parseDailyLimits("Крупные: gpt-5* = 1M"),
  );
  assert.equal(groups[0].remainingPercent, 0);
  assert.equal(groups[0].used, 3_000_000);
});

test("the day is OpenAI's, which starts at midnight UTC", () => {
  const noonUtc = new Date("2026-09-09T12:00:00Z");
  assert.equal(startOfUtcDay(noonUtc), Math.floor(Date.parse("2026-09-09T00:00:00Z") / 1000));
  assert.equal(secondsUntilReset(noonUtc), 12 * 3600);
});

test("models in one group share a single pool, not one each", () => {
  const limits = parseDailyLimits("Крупные: gpt-5*, gpt-4.1*, o3* = 250k");
  const { groups } = groupAgainstLimits(
    [
      { model: "gpt-5", tokens: 100_000 },
      { model: "gpt-4.1-2025-04-14", tokens: 100_000 },
      { model: "o3-2025-04-16", tokens: 50_000 },
    ],
    limits,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].used, 250_000);
  assert.equal(groups[0].remainingPercent, 0);
});
