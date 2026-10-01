import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { assembleSubscriptions, tightestSubscription } = await import(
  "../lib/subscriptions.ts"
);

const window = (usedPercent, label = "Weekly limit") => ({
  label,
  usedPercent,
  remainingPercent: 100 - usedPercent,
  resetsAt: "2026-10-07T18:00:00.000Z",
  cost: null,
});

function row(overrides) {
  return {
    machineId: "pc-1",
    machineName: "PC 1",
    providerId: "claude-code",
    status: "ok",
    accountEmail: "a@example.test",
    planLabel: "Max (20x)",
    message: null,
    windows: [window(10)],
    credits: null,
    resetCredits: null,
    checkedAt: "2026-10-01T03:00:00.000Z",
    ...overrides,
  };
}

test("one plan per identity, never merged across e-mails or providers", () => {
  const { subscriptions } = assembleSubscriptions({
    accounts: [
      row({ machineId: "pc-1", machineName: "PC 1", accountEmail: "a@example.test" }),
      row({ machineId: "srv", machineName: "srv", accountEmail: "A@example.test", windows: [window(12)], checkedAt: "2026-10-01T03:01:00.000Z" }),
      row({ machineId: "pc-2", machineName: "PC 2", accountEmail: "b@example.test", windows: [window(100)] }),
      row({ machineId: "pc-2", machineName: "PC 2", providerId: "codex", accountEmail: "b@example.test", planLabel: "Pro", windows: [window(99)] }),
    ],
    memory: {},
  });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.status, s.windows[0].remainingPercent, s.readFrom.machineId]),
    [
      ["claude-code:a@example.test", "ok", 88, "srv"],
      ["claude-code:b@example.test", "ok", 0, "pc-2"],
      ["codex:b@example.test", "ok", 1, "pc-2"],
    ],
  );
  const a = subscriptions[0];
  assert.deepEqual(a.machines.map((m) => [m.machineId, m.status]), [["pc-1", "ok"], ["srv", "ok"]]);
});

test("a machine without local auth neither hides the plan nor reads as exhausted", () => {
  const { subscriptions } = assembleSubscriptions({
    accounts: [
      row({ machineId: "pc-2", machineName: "PC 2", status: "unauthenticated", windows: [] }),
      row({ machineId: "srv", machineName: "srv", status: "ok", windows: [window(0)] }),
      row({ machineId: "home", machineName: "home", status: "expired", windows: [] }),
    ],
    memory: {},
  });
  assert.equal(subscriptions.length, 1);
  const [plan] = subscriptions;
  assert.equal(plan.status, "ok");
  assert.equal(plan.windows[0].remainingPercent, 100);
  assert.equal(plan.readFrom.machineId, "srv");
  assert.deepEqual(
    plan.machines.map((m) => [m.machineId, m.status]),
    [["pc-2", "unauthenticated"], ["home", "expired"], ["srv", "ok"]].sort((x, y) => x[0].localeCompare(y[0])),
  );
});

test("when no machine can read the plan, the last successful reading stays, marked stale", () => {
  const first = assembleSubscriptions({
    accounts: [row({ status: "ok", windows: [window(40)] })],
    memory: {},
  });
  const second = assembleSubscriptions({
    accounts: [row({ status: "expired", windows: [], checkedAt: "2026-10-01T04:00:00.000Z" })],
    memory: first.memory,
  });
  const [plan] = second.subscriptions;
  assert.equal(plan.status, "stale");
  assert.equal(plan.windows[0].remainingPercent, 60);
  assert.deepEqual(plan.readFrom, {
    machineId: "pc-1",
    machineName: "PC 1",
    checkedAt: "2026-10-01T03:00:00.000Z",
  });
  assert.deepEqual(plan.machines.map((m) => m.status), ["expired"]);
  // The memory still carries the reading for the next round.
  assert.equal(second.memory["claude-code:a@example.test"].lastReading.windows[0].usedPercent, 40);
});

test("a plan whose machines are all offline is still listed from memory", () => {
  const first = assembleSubscriptions({
    accounts: [row({ status: "ok", windows: [window(40)] })],
    memory: {},
  });
  const second = assembleSubscriptions({
    accounts: [
      // Disconnected machine: identity is unknown this round.
      row({ status: "unknown", accountEmail: null, planLabel: null, windows: [], message: "Machine is disconnected; no fresh account status was read." }),
    ],
    memory: first.memory,
  });
  assert.equal(second.subscriptions.length, 1);
  const [plan] = second.subscriptions;
  assert.equal(plan.status, "stale");
  assert.equal(plan.accountEmail, "a@example.test");
  assert.equal(plan.planLabel, "Max (20x)");
  assert.deepEqual(plan.machines.map((m) => [m.machineId, m.status]), [["pc-1", "unknown"]]);
});

test("rate-limit overlay is used only when nothing fresh exists, and never wins over ok", () => {
  const { subscriptions } = assembleSubscriptions({
    accounts: [
      row({ machineId: "pc-1", status: "stale", windows: [window(50)], checkedAt: "2026-10-01T05:00:00.000Z" }),
      row({ machineId: "srv", machineName: "srv", status: "ok", windows: [window(55)], checkedAt: "2026-10-01T03:00:00.000Z" }),
    ],
    memory: {},
  });
  assert.equal(subscriptions[0].status, "ok");
  assert.equal(subscriptions[0].readFrom.machineId, "srv");
});

test("not-installed rows with no identity are not plans", () => {
  const { subscriptions } = assembleSubscriptions({
    accounts: [row({ status: "not_installed", accountEmail: null, windows: [] })],
    memory: {},
  });
  assert.deepEqual(subscriptions, []);
});

test("primary-only enrichment is borrowed from a sibling reading of the same plan", () => {
  const credits = { hasCredits: true, unlimited: false, balance: "62495.96" };
  const { subscriptions } = assembleSubscriptions({
    accounts: [
      row({ machineId: "pc-2", providerId: "codex", windows: [window(99)], checkedAt: "2026-10-01T05:00:00.000Z" }),
      row({ machineId: "server", providerId: "codex", windows: [window(99)], credits, checkedAt: "2026-10-01T03:00:00.000Z" }),
    ],
    memory: {},
  });
  assert.equal(subscriptions[0].readFrom.machineId, "pc-2");
  assert.deepEqual(subscriptions[0].credits, credits);
});

test("tightest picks the smallest remaining window across known plans", () => {
  const { subscriptions } = assembleSubscriptions({
    accounts: [
      row({ accountEmail: "a@example.test", windows: [window(10), window(100, "Fable")] }),
      row({ accountEmail: "b@example.test", providerId: "codex", windows: [window(99)] }),
    ],
    memory: {},
  });
  const tightest = tightestSubscription(subscriptions);
  assert.equal(tightest.subscription.key, "claude-code:a@example.test");
  assert.equal(tightest.window.label, "Fable");
  assert.equal(tightestSubscription([]), null);
});
