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

test("limits are read from lines or a comma-separated list", () => {
  const limits = parseDailyLimits("gpt-5* = 1M\ngpt-4.1-mini = 2M, o3-mini=10M");
  assert.deepEqual(limits.map((l) => [l.pattern, l.tokens]), [
    ["gpt-5*", 1_000_000],
    ["gpt-4.1-mini", 2_000_000],
    ["o3-mini", 10_000_000],
  ]);
});

test("the most specific rule wins, so an exact model beats a prefix", () => {
  const limits = parseDailyLimits("gpt-5* = 1M\ngpt-5-mini = 10M");
  assert.equal(limitFor("gpt-5-mini", limits)?.tokens, 10_000_000);
  assert.equal(limitFor("gpt-5-codex", limits)?.tokens, 1_000_000);
  assert.equal(limitFor("claude-opus", limits), null);
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
  const limits = parseDailyLimits("gpt-5* = 1M\ngpt-5-mini = 10M");
  const { groups, unlimited } = groupAgainstLimits(
    [
      { model: "gpt-5", tokens: 250_000 },
      { model: "gpt-5-codex", tokens: 250_000 },
      { model: "gpt-5-mini", tokens: 1_000_000 },
      { model: "some-other-model", tokens: 42 },
    ],
    limits,
  );
  const big = groups.find((g) => g.label === "gpt-5*");
  assert.equal(big?.used, 500_000);
  assert.equal(big?.remainingPercent, 50);
  assert.equal(groups.find((g) => g.label === "gpt-5-mini")?.remainingPercent, 90);
  // Spend with no allowance is still shown, not silently dropped.
  assert.deepEqual(unlimited, [{ model: "some-other-model", tokens: 42 }]);
});

test("an allowance with no spend today is still listed, at full", () => {
  const { groups } = groupAgainstLimits([], parseDailyLimits("gpt-5* = 1M"));
  assert.deepEqual(groups.map((g) => [g.label, g.used, g.remainingPercent]), [["gpt-5*", 0, 100]]);
});

test("going over the allowance clamps at nothing left, not a negative", () => {
  const { groups } = groupAgainstLimits(
    [{ model: "gpt-5", tokens: 3_000_000 }],
    parseDailyLimits("gpt-5* = 1M"),
  );
  assert.equal(groups[0].remainingPercent, 0);
  assert.equal(groups[0].used, 3_000_000);
});

test("the day is OpenAI's, which starts at midnight UTC", () => {
  const noonUtc = new Date("2026-09-09T12:00:00Z");
  assert.equal(startOfUtcDay(noonUtc), Math.floor(Date.parse("2026-09-09T00:00:00Z") / 1000));
  assert.equal(secondsUntilReset(noonUtc), 12 * 3600);
});
