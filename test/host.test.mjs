import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import Database from "better-sqlite3";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { default: hostEntry } = await import("../host.ts");
const { default: plugin } = await import("../server.ts");

function codexRecord(tokens, timestamp = new Date().toISOString()) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: tokens,
          input_tokens: tokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
}

function bucket(tokens) {
  return {
    tokens,
    input: tokens,
    output: 0,
    cached: 0,
    reasoning: 0,
    turns: 1,
  };
}

function createServerHarness(hostCall) {
  const database = new Database(":memory:");
  const rpcHandlers = {};
  let cli = null;
  const bb = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    storage: {
      database: () => database,
      migrate(db, statements) {
        db.transaction(() => {
          for (const statement of statements) db.exec(statement);
        })();
      },
    },
    hosts: {
      experimental_client: () => ({
        call: (method, input, options) =>
          hostCall({ method, input, hostId: options.hostId }),
      }),
    },
    sdk: {
      hosts: {
        list: async () => [
          { id: "host-one", name: "Machine One", status: "connected" },
          { id: "host-two", name: "Machine Two", status: "connected" },
        ],
      },
      threads: {
        list: async () => [],
        events: { list: async () => [] },
      },
      providers: { list: async () => [] },
    },
    settings: {
      define(descriptors) {
        return {
          get: async () =>
            Object.fromEntries(
              Object.entries(descriptors).map(([key, descriptor]) => [
                key,
                descriptor.default,
              ]),
            ),
        };
      },
    },
    rpc: {
      register(_contract, handlers) {
        Object.assign(rpcHandlers, handlers);
      },
    },
    realtime: { publish() {} },
    background: { service() {} },
    cli: {
      register(registration) {
        cli = registration;
      },
    },
    onDispose() {},
  };
  return {
    bb,
    rpcHandlers,
    runCli: (argv) => cli.run(argv),
    close: () => database.close(),
  };
}

test("host token RPC scans its machine and never returns transcript paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-usage-host-"));
  const sessions = join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "synthetic.jsonl"), `${codexRecord(123)}\n`);
  const prior = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  const harness = experimental_createHostEntryHarness(hostEntry);

  try {
    const result = await harness.experimental_call("tokenScan", { force: true });
    assert.equal(result.fileCount, 1);
    assert.equal(Object.values(result.daily)[0]?.codex.tokens, 123);
    assert.equal(JSON.stringify(result).includes("synthetic.jsonl"), false);
  } finally {
    await harness.experimental_dispose();
    if (prior.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = prior.HOME;
    if (prior.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior.CODEX_HOME;
    if (prior.CLAUDE_CONFIG_DIR === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prior.CLAUDE_CONFIG_DIR;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("server forwards the selected machine to the host token scan", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const calls = [];
  const harness = createServerHarness(async ({ method, hostId }) => {
      calls.push({ method, hostId });
      assert.equal(method, "tokenScan");
      const tokens = hostId === "host-one" ? 111 : 222;
      return {
        scannedAt: new Date().toISOString(),
        fileCount: 1,
        changedFiles: 1,
        sources: ["codex"],
        daily: { [today]: { codex: bucket(tokens) } },
      };
  });
  await plugin(harness.bb);

  try {
    const first = await harness.rpcHandlers.getTokens({
      days: 7,
      hostId: "host-one",
      force: true,
    });
    const second = await harness.runCli([
      "tokens",
      "--machine",
      "Machine Two",
      "--json",
      "--force",
    ]);

    assert.equal(first.totals.tokens, 111);
    assert.equal(second.exitCode, 0);
    assert.equal(JSON.parse(second.stdout).totals.tokens, 222);
    assert.deepEqual(
      calls.map((call) => call.hostId),
      ["host-one", "host-two"],
    );
  } finally {
    harness.close();
  }
});
