import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { setRpcCall } from "./support/plugin-sdk-app-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": repo,
    "@get-bb/plugin-sdk/app": join(here, "support", "plugin-sdk-app-stub.mjs"),
  },
  jsx: { runtime: "automatic" },
  moduleCache: false,
});
const React = await jiti.import(require.resolve("react"), {});
const renderer = await jiti.import(require.resolve("react-test-renderer"), {});
const app = await jiti.import(join(repo, "app.tsx"), {});
const { assembleDashboard } = await jiti.import(join(repo, "lib", "dashboard.ts"), {});
const { normalizeProviderLimits } = await jiti.import(join(repo, "lib", "provider-limits.ts"), {});
const { overlayLastGoodLimits, rememberGoodLimits } = await jiti.import(join(repo, "lib", "limits-cache.ts"), {});
let HomepageUsage;
let DashboardPage;
app.default({ slots: {
  navPanel: (registration) => { DashboardPage = registration.component; },
  homepageSection: (registration) => { HomepageUsage = registration.component; },
} });

test("homepage retains rate-limited quota visibly marked Last known", async () => {
  const saved = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const prior = normalizeProviderLimits({
    codex: { status: "not_installed", windows: [] },
    "claude-code": { status: "ok", windows: [{ label: "Weekly limit", usedPercent: 40, resetsAt: null }] },
    "acp-cursor": { status: "not_installed", windows: [] },
    muse: { status: "not_installed", windows: [] },
  });
  let limits = prior;
  let tick;
  let tree;
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} };
    globalThis.document = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
    setRpcCall(async (method) => {
      assert.equal(method, "getDashboard");
      return assembleDashboard({ limits, hosts: [], catalog: [], hostId: "primary" });
    });
    await renderer.act(async () => { tree = renderer.create(React.createElement(HomepageUsage)); });
    const rendered = () => JSON.stringify(tree.toJSON());
    assert.match(rendered(), /60% left/);
    assert.doesNotMatch(rendered(), /Last known/);
    const refused = { ...prior, claudeCode: { status: "error", message: "Claude usage is rate limited right now.", windows: [] } };
    limits = overlayLastGoodLimits(refused, rememberGoodLimits(prior));
    assert.equal(limits.claudeCode.status, "stale");
    await renderer.act(async () => { tick(); });
    assert.match(rendered(), /Last known · Weekly limit · 60% left/);
    assert.ok(tree.root.findAllByType("svg").length > 0);
    limits = prior;
    await renderer.act(async () => { tick(); });
    assert.doesNotMatch(rendered(), /Last known/);
    assert.match(rendered(), /60% left/);
  } finally {
    if (tree) await renderer.act(async () => { tree.unmount(); });
    setRpcCall(null);
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
  }
});

test("native panel renders each source observation and visible unplaced raw amount", async () => {
  const saved = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { assembleTokenSnapshot } = await jiti.import(join(repo, "lib", "tokens.ts"), {});
  const observedAt = "2026-10-02T12:00:00.000Z";
  const snapshot = { ...assembleTokenSnapshot({ days: 7, fileCount: 1, changedFiles: 0, sources: ["cursor"], daily: {} }), observations: [{
    machineId: "host", machineName: "Host", provider: "cursor", sourceId: "/fixture/session/S",
    tokens: 0, rawTokens: 900, unknownWindow: 900, observedAt, status: "stale", birthMs: 1790982945000, mtimeMs: 1790983000000, message: "Source could not be read; last known amounts retained.",
  }] };
  let tree;
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = { setInterval: () => 1, clearInterval: () => {} };
    globalThis.document = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
    setRpcCall(async (method) => method === "getTokens" ? snapshot : method === "getDashboard" ? assembleDashboard({ limits: normalizeProviderLimits({}), hosts: [], catalog: [], hostId: null }) : null);
    await renderer.act(async () => { tree = renderer.create(React.createElement(DashboardPage)); });
    const text = tree.root.findAllByType("p").map((node) => node.children.filter((child) => typeof child === "string").join("")).join("\n");
    assert.match(text, /900 raw total/);
    assert.match(text, /observed 2026-10-02T12:00:00.000Z/);
    assert.match(text, /Last known 900 · unknown window/);
    assert.match(text, /Filesystem birth/);
    assert.match(text, /Filesystem mtime/);
    assert.match(text, /Source could not be read/);
  } finally {
    if (tree) await renderer.act(async () => tree.unmount());
    setRpcCall(null);
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
  }
});

test("native panel preserves overlapping historical150 separately from the current120 across window changes", async () => {
  const saved = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { assembleTokenSnapshot, dayKey } = await jiti.import(join(repo, "lib", "tokens.ts"), {});
  const { mergeMachineTokens } = await jiti.import(join(repo, "lib", "machine-tokens.ts"), {});
  const now = Date.now(), observedAt = new Date(now - 5000).toISOString();
  const bucket = (tokens) => ({ tokens, input: tokens, output: 0, cached: 0, reasoning: 0, turns: 1 });
  const sources = [
    { id: "host", name: "Historical host", error: "Machine is offline.", tokens: { computer: "pc", scannedAt: new Date(now).toISOString(), changedFiles: 0, slices: [
      { provider: "codex", location: "/scope", fileCount: 2, daily: { [dayKey(now)]: bucket(150) }, observedAt },
      { provider: "codex", location: "/scope", fileCount: 2, daily: { [dayKey(now)]: bucket(140) } },
    ] } },
    { id: "server", name: "Current source", error: null, tokens: { computer: "pc", scannedAt: new Date(now).toISOString(), changedFiles: 0, slices: [
      { provider: "codex", location: "/scope", sourceId: "/scope/A", fileCount: 1, daily: { [dayKey(now)]: bucket(120) }, observedAt: new Date(now).toISOString() },
    ] } },
  ];
  let tree;
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = { setInterval: () => 1, clearInterval: () => {} };
    globalThis.document = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
    setRpcCall(async (method, input) => {
      if (method === "getDashboard") return assembleDashboard({ limits: normalizeProviderLimits({}), hosts: [], catalog: [], hostId: null });
      if (method !== "getTokens") return null;
      const merged = mergeMachineTokens(sources, input.days, now);
      return { ...assembleTokenSnapshot({ days: input.days, fileCount: merged.fileCount, changedFiles: 0, sources: merged.providers, daily: merged.daily }), observations: merged.observations };
    });
    await renderer.act(async () => { tree = renderer.create(React.createElement(DashboardPage)); });
    for (const days of [7, 30, 90, 7]) {
      const button = tree.root.findAllByType("button").find((node) => node.children.join("") === `${days}d`);
      await renderer.act(async () => button.props.onClick());
      const paragraphs = tree.root.findAllByType("p");
      const text = paragraphs.map((node) => node.children.filter((child) => typeof child === "string").join("")).join("\n");
      assert.match(text, /Historical overlapping observation · Last known 150/);
      assert.match(text, /Historical overlapping observation · Last known 140/);
      assert.match(text, new RegExp(`observed ${observedAt}`));
      assert.match(text, /Last known 140 · observed unknown/);
      assert.match(text, /reporting-window membership unknown; not included in totals/);
      assert.doesNotMatch(text, /incomplete/);
      const total = paragraphs.find((node) => node.children.join("") === "Total");
      assert.equal(total.parent.findAllByType("p")[1].children.join(""), "120");
    }
  } finally {
    if (tree) await renderer.act(async () => tree.unmount());
    setRpcCall(null);
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
  }
});
