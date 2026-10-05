import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.replace(/\.js$/, ".ts"), context);
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { default: plugin } = await import("../server.ts");
const { default: hostEntry } = await import("../host.ts");
const { claudeMachineUsageSchema } = await import("../host-contract.ts");
const { readCodexUsageSupplement } = await import("../lib/codex-usage.ts");
const { assembleDashboard, formatDashboardText } = await import("../lib/dashboard.ts");

async function commandFixture(t, email, balance) {
  const dir = await mkdtemp(join(process.cwd(), ".test-codex-owner-"));
  const command = join(dir, "codex");
  await writeFile(command, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nfor await (const line of createInterface({ input: process.stdin })) {\n const request = JSON.parse(line);\n const result = request.method === 'initialize' ? {} : request.method === 'account/read' ? { account: { type: 'chatgpt', email: ${JSON.stringify(email)} } } : { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791000000 }, credits: { hasCredits: true, unlimited: false, balance: ${JSON.stringify(balance)} } } };\n console.log(JSON.stringify({ id: request.id, result }));\n}\n`);
  await chmod(command, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return command;
}

test("owning-host enrichment refuses a different account and preserves matching figures", async (t) => {
  const command = await commandFixture(t, "b@example.test", "42");
  const saved = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = command;
  t.after(() => { if (saved === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = saved; });
  assert.equal(await readCodexUsageSupplement({ command, expectedAccountEmail: "a@example.test", timeoutMs: 1000 }), null);
  const reading = claudeMachineUsageSchema.parse(await hostEntry.handlers.claudeUsage({ codexAccountEmail: "b@example.test" }, {}));
  assert.equal(reading.codexSupplement.credits.balance, "42");
  assert.equal(reading.codexSupplement.windows[0].usedPercent, 12);
});

test("implicit remote primary and explicit account readback never use local A supplements", async (t) => {
  const command = await commandFixture(t, "a@example.test", "99");
  const saved = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = command;
  t.after(() => { if (saved === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = saved; });
  const requests = [];
  const supplement = {
    windows: [{ label: "B extra", usedPercent: 23, resetsAt: "2026-10-03T00:00:00Z" }],
    credits: { hasCredits: true, unlimited: false, balance: "42" },
    resetCredits: { availableCount: 2, nextExpiresAt: null, title: null, description: null },
    spendControl: { used: "3", limit: "10", remainingPercent: 70, resetsAt: null, reached: false },
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      hosts: { list: async () => [{ id: "B", name: "Remote B", status: "connected" }] },
      providers: { list: async () => [{ id: "codex", displayName: "Codex", logoUrl: null }] },
      system: { config: async () => ({ primaryHostId: "B" }), usageLimits: async ({ hostId }) => {
        assert.equal(hostId, "B");
        return { codex: { status: "ok", accountEmail: "b@example.test", windows: [{ label: "Weekly", usedPercent: 10, resetsAt: null }] } };
      } },
    },
    experimental_callHostRpc: async ({ method, hostId, input }) => {
      assert.equal(method, "claudeUsage");
      assert.equal(hostId, "B");
      if (input !== null) {
        requests.push(input);
        assert.deepEqual(input, { codexAccountEmail: "b@example.test" });
      }
      return { status: "not_installed", accountEmail: null, planLabel: null, message: null, directory: "", windows: [], ...(input !== null ? { codexSupplement: supplement } : {}) };
    },
  });
  try {
    await plugin(bb);
    for (const hostId of [null, "B"]) {
      const dashboard = await harness.behavior.callRpc("getDashboard", { hostId, force: true });
      const codex = dashboard.providers.find((row) => row.key === "codex");
      assert.equal(codex.accountEmail, "b@example.test");
      assert.equal(codex.credits.balance, "42");
      assert.equal(codex.resetCredits.availableCount, 2);
      assert.equal(codex.spendControl.used, "3");
      assert.ok(codex.windows.some((row) => row.label === "B extra"));
    }
    const cli = await harness.behavior.runCli(["--json", "--force"]);
    assert.equal(JSON.parse(cli.stdout).providers.find((row) => row.key === "codex").credits.balance, "42");
    const accounts = await harness.behavior.runCli(["accounts", "--json", "--force"]);
    assert.equal(JSON.parse(accounts.stdout).accounts.find((row) => row.providerId === "codex").credits.balance, "42");
    assert.ok(requests.length >= 4);
  } finally { await harness.lifecycle.dispose(); }
});

test("stale quota CLI retains percentage and reset under Last known", () => {
  const dashboard = assembleDashboard({ hostId: null, hosts: [], catalog: [], limits: {
    codex: { status: "not_installed" }, cursor: { status: "not_installed" }, muse: { status: "not_installed" },
    claudeCode: { status: "stale", message: "rate limited", windows: [{ label: "Weekly limit", usedPercent: 62, resetsAt: "2026-10-03T00:00:00Z" }] },
  } });
  const text = formatDashboardText(dashboard);
  assert.match(text, /Last known.*rate limited/);
  assert.match(text, /Weekly limit\s+38% left · 62% used · resets/);
});
