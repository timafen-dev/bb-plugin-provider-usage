import assert from "node:assert/strict";
import { test } from "node:test";

const { parsePanelHidden, isMachineHidden, hiddenProvidersFor } = await import(
  "../lib/panel-hidden.ts"
);

const SERVICE = { id: "host_b52nre7gvn", name: "НЕ ВЫБИРАТЬ — служебная машина панели" };
const API = { id: "host_pakm3vnmpm", name: "codex-api (бесплатные токены)" };
const WORK = { id: "host_chqhn38bw8", name: "Машина 2 (рабочая подписка)" };

const RULES = [
  "НЕ ВЫБИРАТЬ — служебная машина панели",
  "codex-api (бесплатные токены): claude-code, cursor, muse",
].join("\n");

test("a machine named on its own line is not shown at all", () => {
  const hidden = parsePanelHidden(RULES);
  assert.equal(isMachineHidden(hidden, SERVICE), true);
  assert.equal(isMachineHidden(hidden, API), false);
  assert.equal(isMachineHidden(hidden, WORK), false);
});

test("without the rule the same machine is shown", () => {
  // The negative case: the rule is what hides it, not something else.
  const hidden = parsePanelHidden("");
  assert.equal(isMachineHidden(hidden, SERVICE), false);
  assert.equal(hiddenProvidersFor(hidden, API).size, 0);
});

test("providers are hidden only on the machine that named them", () => {
  const hidden = parsePanelHidden(RULES);
  assert.deepEqual(
    [...hiddenProvidersFor(hidden, API)].sort(),
    ["claude-code", "cursor", "muse"],
  );
  assert.equal(hiddenProvidersFor(hidden, WORK).size, 0);
});

test("a machine may be named by its id, so a rename does not break the rule", () => {
  const hidden = parsePanelHidden("host_b52nre7gvn\nhost_pakm3vnmpm: muse");
  assert.equal(isMachineHidden(hidden, { ...SERVICE, name: "Совсем другое имя" }), true);
  assert.deepEqual([...hiddenProvidersFor(hidden, { ...API, name: "Другое" })], ["muse"]);
});

test("a star hides a provider on every machine, including none", () => {
  const hidden = parsePanelHidden("*: muse");
  assert.deepEqual([...hiddenProvidersFor(hidden, WORK)], ["muse"]);
  assert.deepEqual([...hiddenProvidersFor(hidden, null)], ["muse"]);
});

test("a colon inside a machine name is not the separator", () => {
  // The last colon splits, so «Машина: рабочая: cursor» hides cursor there.
  const hidden = parsePanelHidden("Машина: рабочая: cursor");
  assert.deepEqual([...hiddenProvidersFor(hidden, { id: "h", name: "Машина: рабочая" })], [
    "cursor",
  ]);
});

test("case, spaces, comments and blank lines do not change a rule", () => {
  const hidden = parsePanelHidden(
    "\n  # так выглядит комментарий\n  CODEX-API (бесплатные токены) :  Claude-Code ,, MUSE  \n\n",
  );
  assert.deepEqual([...hiddenProvidersFor(hidden, API)].sort(), ["claude-code", "muse"]);
});

test("a rule with nothing after the colon is ignored, not read as a machine", () => {
  const hidden = parsePanelHidden("codex-api (бесплатные токены):");
  assert.equal(isMachineHidden(hidden, API), false);
  assert.equal(hiddenProvidersFor(hidden, API).size, 0);
});
