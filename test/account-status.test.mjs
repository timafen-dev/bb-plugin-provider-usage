import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

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

const { default: plugin } = await import("../server.ts");

const hosts = [
  { id: "host-1", name: "PC 1", status: "connected" },
  { id: "host-2", name: "PC 2", status: "connected" },
];

const window = (usedPercent) => ({
  label: "Weekly limit",
  usedPercent,
  resetsAt: "2026-09-30T00:00:00.000Z",
});

const emptyProvider = { status: "not_installed", windows: [] };

function usageLimits(hostId) {
  const first = hostId === "host-1";
  return {
    codex: {
      status: "ok",
      accountEmail: first ? "codex-one@example.test" : "codex-two@example.test",
      planLabel: "Pro",
      windows: [window(first ? 62 : 97)],
    },
    // Deliberately wrong for host-2. The machine-specific host RPC must win,
    // and an RPC failure must not expose this fallback as host-2's identity.
    "claude-code": {
      status: "ok",
      accountEmail: "wrong-home-login@example.test",
      planLabel: "Max",
      windows: [window(1)],
    },
    "acp-cursor": emptyProvider,
    muse: emptyProvider,
  };
}

function claudeResult(hostId) {
  if (hostId === "host-1") {
    return {
      status: "unauthenticated",
      accountEmail: "claude-one@example.test",
      planLabel: "Max (20x)",
      message: null,
      directory: "/accounts/one/claude",
      windows: [],
    };
  }
  return {
    status: "ok",
    accountEmail: "claude-two@example.test",
    planLabel: "Max (20x)",
    message: null,
    directory: "/accounts/two/claude",
    windows: [window(100)],
  };
}

async function setup({
  callHostRpc = ({ hostId }) => claudeResult(hostId),
  readUsageLimits = ({ hostId } = {}) => usageLimits(hostId),
} = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      hosts: { list: async () => hosts },
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", logoUrl: null },
          { id: "claude-code", displayName: "Claude Code", logoUrl: null },
        ],
      },
      system: {
        usageLimits: async (input) => readUsageLimits(input),
      },
    },
    experimental_callHostRpc: async (request) => callHostRpc(request),
  });
  await plugin(bb);
  return harness;
}

test("accounts CLI keeps four machine/provider identities and quota0 separate", async () => {
  const harness = await setup();
  try {
    const result = await harness.behavior.runCli(["accounts", "--json", "--force"]);
    assert.equal(result.exitCode, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.accounts.length, 4);

    const byKey = Object.fromEntries(body.accounts.map((row) => [row.key, row]));
    assert.equal(byKey["host-1:codex"].accountEmail, "codex-one@example.test");
    assert.equal(byKey["host-1:claude-code"].status, "unauthenticated");
    assert.equal(byKey["host-2:codex"].accountEmail, "codex-two@example.test");
    assert.equal(byKey["host-2:claude-code"].status, "ok");
    assert.equal(byKey["host-2:claude-code"].windows[0].remainingPercent, 0);
    assert.equal(byKey["host-2:claude-code"].status, "ok");
    assert.equal(byKey["host-2:codex"].credits, null);
    assert.equal(byKey["host-2:codex"].resetCredits, null);
    assert.equal(byKey["host-2:codex"].enrichmentScope, "primary-only");

    const reloaded = await harness.lifecycle.reload(plugin);
    const repeated = await reloaded.harness.behavior.runCli([
      "accounts",
      "--json",
      "--force",
    ]);
    const repeatedBody = JSON.parse(repeated.stdout);
    assert.deepEqual(
      repeatedBody.accounts.map(({ key, status, accountEmail, windows }) => ({
        key,
        status,
        accountEmail,
        remaining: windows[0]?.remainingPercent ?? null,
      })),
      body.accounts.map(({ key, status, accountEmail, windows }) => ({
        key,
        status,
        accountEmail,
        remaining: windows[0]?.remainingPercent ?? null,
      })),
    );
    await reloaded.harness.lifecycle.dispose();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a failed machine usage source yields two unknown rows without hiding peers", async () => {
  const harness = await setup({
    readUsageLimits: ({ hostId } = {}) => {
      if (hostId === "host-2") throw new Error("machine source offline");
      return usageLimits(hostId);
    },
  });
  try {
    const result = await harness.behavior.runCli(["accounts", "--json", "--force"]);
    assert.equal(result.exitCode, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.accounts.length, 4);
    assert.deepEqual(
      body.accounts
        .filter((row) => row.machineId === "host-2")
        .map((row) => [row.providerId, row.status, row.accountEmail]),
      [
        ["codex", "unknown", null],
        ["claude-code", "unknown", null],
      ],
    );
    assert.equal(
      body.accounts.find((row) => row.key === "host-1:codex").status,
      "ok",
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("host RPC failure is unknown and never replaced with another Claude login", async () => {
  const harness = await setup({
    callHostRpc: ({ hostId }) => {
      if (hostId === "host-2") throw new Error("worker unavailable");
      return claudeResult(hostId);
    },
  });
  try {
    const result = await harness.behavior.runCli([
      "accounts",
      "--machine",
      "host-2",
      "--json",
      "--force",
    ]);
    const body = JSON.parse(result.stdout);
    const claude = body.accounts.find((row) => row.providerId === "claude-code");
    assert.equal(claude.status, "unknown");
    assert.equal(claude.accountEmail, null);
    assert.deepEqual(claude.windows, []);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("last-good quota from one machine is never overlaid onto another", async () => {
  const harness = await setup({
    callHostRpc: ({ hostId }) =>
      hostId === "host-1"
        ? {
            ...claudeResult(hostId),
            status: "ok",
            windows: [window(40)],
          }
        : {
            ...claudeResult(hostId),
            status: "error",
            message: "Claude usage is rate limited right now.",
            windows: [],
          },
  });
  try {
    await harness.behavior.runCli([
      "accounts",
      "--machine",
      "host-1",
      "--json",
      "--force",
    ]);
    const result = await harness.behavior.runCli([
      "accounts",
      "--machine",
      "host-2",
      "--json",
      "--force",
    ]);
    const body = JSON.parse(result.stdout);
    const claude = body.accounts.find((row) => row.providerId === "claude-code");
    assert.equal(claude.status, "error");
    assert.deepEqual(claude.windows, []);
  } finally {
    await harness.lifecycle.dispose();
  }
});
