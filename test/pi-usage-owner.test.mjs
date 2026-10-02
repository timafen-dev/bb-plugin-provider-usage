// Behavioural cover for choosing the one machine the Pi snapshot may come from.
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
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
      }
      throw error;
    }
  },
});

const { PI_HOST_CALL_FAILED, PI_OWNING_HOST_NAME, piOwningHost } = await import(
  "../lib/pi-usage-owner.ts"
);
const { piVerifiedIdleZero, readPiUsageFacts } = await import("../lib/pi-usage-contract.ts");

const connected = (id, name) => ({ id, name, status: "connected" });

test("the approved machine is the one that is read", () => {
  const picked = piOwningHost([
    connected("h1", "laptop"),
    connected("h2", "homeserver"),
    connected("h3", "mac-mini"),
  ]);
  assert.deepEqual(picked, { state: "ready", hostId: "h2" });
});

test("only the exact approved name selects an owner", () => {
  for (const host of [connected("homeserver", "Pi box"), connected("h9", " HomeServer "), connected("h3", "HOMESERVER")]) {
    assert.equal(piOwningHost([host]).reason, "owning_host_unknown");
  }
});

test("no approved machine means unavailable, not another machine", () => {
  const picked = piOwningHost([connected("h1", "laptop"), connected("h2", "mac-mini")]);
  assert.equal(picked.state, "unavailable");
  assert.equal(picked.reason, "owning_host_unknown");
  // Nothing about the machines that were not chosen travels with the answer.
  for (const word of ["laptop", "mac-mini", "h1", "h2"]) {
    assert.ok(!picked.detail.includes(word));
  }
});

test("an empty machine list is unavailable, not the server's own disk", () => {
  assert.equal(piOwningHost([]).reason, "owning_host_unknown");
});

test("two machines answering to the name are an ambiguity, never a sum", () => {
  const picked = piOwningHost([connected("h1", "homeserver"), connected("h2", "homeserver")]);
  assert.equal(picked.state, "unavailable");
  assert.equal(picked.reason, "owning_host_ambiguous");
  assert.ok(!("hostId" in picked));
});

test("an offline approved machine is unavailable, not a zero", () => {
  const picked = piOwningHost([{ id: "h2", name: "homeserver", status: "disconnected" }]);
  assert.equal(picked.state, "unavailable");
  assert.equal(picked.reason, "owning_host_offline");
});

test("an unavailable machine reads as unavailable, with no figures invented", () => {
  const picked = piOwningHost([connected("h1", "laptop")]);
  const reading = readPiUsageFacts({ unavailable: picked, nowMs: Date.now() });
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "owning_host_unknown");
  assert.equal(reading.data, null);
  assert.equal(piVerifiedIdleZero(reading), false);
});

test("a machine that does not answer is summarised, never quoted", () => {
  const reading = readPiUsageFacts({ unavailable: PI_HOST_CALL_FAILED, nowMs: Date.now() });
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "owning_host_did_not_answer");
  assert.equal(reading.data, null);
});

test("the approved machine is compiled in, not configurable", () => {
  assert.equal(PI_OWNING_HOST_NAME, "homeserver");
});
