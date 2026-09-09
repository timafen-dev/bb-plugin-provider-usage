import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

// The module is TypeScript; strip types the way the plugin's own tests do.
const { claudeDirectory, planLabel, windowsFromUsage } = await import(
  "../lib/claude-machine.ts"
);

test("uses the machine's own Claude directory, not the home one", () => {
  assert.equal(
    claudeDirectory({ CLAUDE_CONFIG_DIR: "/home/u/.bb-accounts/2/claude" }, "/home/u"),
    "/home/u/.bb-accounts/2/claude",
  );
  assert.equal(claudeDirectory({}, "/home/u"), "/home/u/.claude");
  // A variable set to nothing is not a directory.
  assert.equal(claudeDirectory({ CLAUDE_CONFIG_DIR: "   " }, "/home/u"), "/home/u/.claude");
});

test("reads session and week as used percentages", () => {
  const windows = windowsFromUsage({
    five_hour: { utilization: 20, resets_at: "2026-09-09T17:00:00Z" },
    seven_day: { utilization: 94 },
  });
  assert.deepEqual(
    windows.map((w) => [w.label, w.usedPercent]),
    [
      ["Current session", 20],
      ["Weekly limit", 94],
    ],
  );
});

test("accepts the older field spelling", () => {
  assert.equal(windowsFromUsage({ five_hour: { percent: 25 } })[0].usedPercent, 25);
});

test("adds a row for a model with its own weekly bucket", () => {
  const windows = windowsFromUsage({
    limits: [
      { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Fable" } } },
      { kind: "daily", percent: 5, scope: { model: { display_name: "Другое" } } },
    ],
  });
  assert.deepEqual(windows.map((w) => w.label), ["Fable"]);
});

test("a broken answer yields no rows instead of throwing", () => {
  assert.deepEqual(windowsFromUsage(null), []);
  assert.deepEqual(windowsFromUsage({ five_hour: { utilization: "много" } }), []);
});

test("an unparseable reset time becomes absent", () => {
  assert.equal(windowsFromUsage({ five_hour: { utilization: 1, resets_at: "скоро" } })[0].resetsAt, null);
});

test("names the plan from the tier, then the subscription", () => {
  assert.equal(planLabel({ rateLimitTier: "default_claude_max_20x" }), "Max (20x)");
  assert.equal(planLabel({ subscriptionType: "pro" }), "Pro");
  assert.equal(planLabel({}), null);
});
