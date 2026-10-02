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
app.default({ slots: {
  navPanel: () => {},
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
