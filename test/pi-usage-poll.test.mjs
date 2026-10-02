// Behavioural cover for one poll of the Firstmate Pi export: which machine is
// asked, what happens when it cannot be asked or answers something else, what
// survives between polls, and whether the result survives the server→page hop.
//
// The machine list and the host read are supplied as plain functions here, so
// every branch is exercised for real — including the ones a working machine
// never produces. No test inspects implementation source text.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const { PI_HOST_LIST_FAILED, createPiUsageReader, piEmptyMemory, pollPiUsage } =
  await import("../lib/pi-usage-poll.ts");
const { PI_OWNING_HOST_NAME } = await import("../lib/pi-usage-owner.ts");
const { PI_HOST_READ_VERSION } = await import("../host-contract.ts");
const {
  PI_GRACE_SECONDS,
  piArtifactFactFromText,
  piReadingSchema,
  piVerifiedIdleZero,
} = await import("../lib/pi-usage-contract.ts");

const fixtureText = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-usage-snapshot.json"),
  "utf8",
);
const fixture = JSON.parse(fixtureText);
const generatedAtMs = Date.parse(fixture.generated_at);
const validArtifact = piArtifactFactFromText(fixtureText);

const OWNER = { id: "host-owning-1", name: PI_OWNING_HOST_NAME, status: "connected" };
const OTHER = { id: "host-other-1", name: "laptop", status: "connected" };
const ALSO = { id: "host-other-2", name: "desktop", status: "connected" };

/** A host answer carrying the facts a machine would report. */
function answer({ artifact = validArtifact, sidecar = { state: "absent" } } = {}) {
  return {
    version: PI_HOST_READ_VERSION,
    artifact,
    sidecar,
    bytes: artifact.state === "valid" ? artifact.bytes : null,
  };
}

/**
 * A poll whose machine list and host read are recorded, so a test can assert
 * which machine was asked and how many times.
 */
function harness({
  hosts = [OWNER],
  reply = () => answer(),
  nowMs = generatedAtMs + 1000,
} = {}) {
  const asked = [];
  return {
    asked,
    deps: {
      hosts: async () => {
        if (typeof hosts === "function") return hosts();
        return hosts;
      },
      read: async (hostId) => {
        asked.push(hostId);
        return reply(hostId);
      },
      nowMs: () => (typeof nowMs === "function" ? nowMs() : nowMs),
    },
  };
}

/** Everything the page is shown has to survive the RPC's own output schema. */
function onTheWire(reading) {
  const parsed = piReadingSchema.safeParse(reading);
  assert.ok(parsed.success, `reading rejected by the RPC schema: ${parsed.error}`);
  return parsed.data;
}

test("the one approved machine is asked, exactly once, and no other", async () => {
  const { asked, deps } = harness({ hosts: [OTHER, OWNER, ALSO] });
  const { reading } = await pollPiUsage(deps);
  assert.deepEqual(asked, [OWNER.id]);
  assert.equal(reading.status, "ok");
  onTheWire(reading);
});

test("a machine list without the approved machine is unavailable, not a zero", async () => {
  const { asked, deps } = harness({ hosts: [OTHER, ALSO] });
  const { reading, memory } = await pollPiUsage(deps);
  assert.deepEqual(asked, []);
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "owning_host_unknown");
  assert.equal(reading.data, null);
  assert.equal(piVerifiedIdleZero(reading), false);
  assert.deepEqual(memory, piEmptyMemory());
  onTheWire(reading);
});

test("two machines answering to the approved name are an ambiguity, not a sum", async () => {
  const twins = [
    { ...OWNER },
    { id: "host-owning-2", name: PI_OWNING_HOST_NAME.toUpperCase(), status: "connected" },
  ];
  const { asked, deps } = harness({ hosts: twins });
  const { reading } = await pollPiUsage(deps);
  assert.deepEqual(asked, []);
  assert.equal(reading.reason, "owning_host_ambiguous");
  assert.equal(reading.data, null);
});

test("an offline approved machine is unavailable and nothing else is read", async () => {
  const { asked, deps } = harness({ hosts: [{ ...OWNER, status: "disconnected" }, OTHER] });
  const { reading } = await pollPiUsage(deps);
  assert.deepEqual(asked, []);
  assert.equal(reading.reason, "owning_host_offline");
});

test("a machine list that cannot be read asks nobody and says so", async () => {
  const secret = "/home/someone/.bb/daemon.sock";
  const { asked, deps } = harness({
    hosts: () => {
      throw new Error(`list failed at ${secret}`);
    },
  });
  const { reading } = await pollPiUsage(deps);
  assert.deepEqual(asked, []);
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, PI_HOST_LIST_FAILED.reason);
  assert.equal(reading.detail, PI_HOST_LIST_FAILED.detail);
  assert.ok(!reading.detail.includes(secret));
  onTheWire(reading);
});

test("a machine that does not answer is summarised, never quoted", async () => {
  const secret = "ECONNREFUSED /run/user/4242/bb/host-owning-1.sock";
  const { deps } = harness({
    reply: () => {
      throw new Error(secret);
    },
  });
  const { reading } = await pollPiUsage(deps);
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "owning_host_did_not_answer");
  assert.ok(!reading.detail.includes(secret));
  assert.ok(!reading.detail.includes(OWNER.id));
  assert.ok(!reading.detail.includes("4242"));
  onTheWire(reading);
});

test("a machine running a different read version is incompatible, not half-understood", async () => {
  for (const reply of [
    () => ({ ...answer(), version: PI_HOST_READ_VERSION + 1 }),
    () => ({ ...answer(), extra: "field nobody agreed on" }),
    () => ({ version: PI_HOST_READ_VERSION, artifact: { state: "valid" }, bytes: 1 }),
    () => ({ artifact: validArtifact, sidecar: { state: "absent" }, bytes: null }),
    () => "a snapshot, as text",
    () => null,
  ]) {
    const { deps } = harness({ reply });
    const { reading, memory } = await pollPiUsage(deps);
    assert.equal(reading.status, "unavailable");
    assert.equal(reading.reason, "owning_host_read_incompatible");
    assert.equal(reading.data, null);
    assert.deepEqual(memory, piEmptyMemory());
    onTheWire(reading);
  }
});

test("an answer carrying a snapshot the contract refuses never reaches the page", async () => {
  const foreign = { ...fixture, producer: { ...fixture.producer, alias: "not-firstmate-pi" } };
  const { deps } = harness({ reply: () => ({ ...answer(), artifact: { state: "valid", snapshot: foreign, bytes: 10 } }) });
  const { reading } = await pollPiUsage(deps);
  // The artifact fails the host read's own schema, so the hop is incompatible
  // rather than a rendered foreign dataset.
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "owning_host_read_incompatible");
});

test("polling the same artifact twice yields exactly the same totals", async () => {
  const { asked, deps } = harness();
  const first = await pollPiUsage(deps, piEmptyMemory());
  const second = await pollPiUsage(deps, first.memory);
  const third = await pollPiUsage(deps, second.memory);
  assert.deepEqual(asked, [OWNER.id, OWNER.id, OWNER.id]);
  for (const result of [second, third]) {
    assert.equal(result.reading.status, "ok");
    assert.deepEqual(result.reading.data.snapshot, first.reading.data.snapshot);
    assert.deepEqual(result.reading.data.snapshot.cost, fixture.cost);
    assert.deepEqual(result.reading.data.snapshot.tokens, fixture.tokens);
    assert.equal(result.reading.data.retained, false);
    assert.equal(result.reading.data.degraded, false);
  }
});

test("last-good figures from an unreachable poll are shown, but never as fresh", async () => {
  const good = await pollPiUsage(harness().deps, piEmptyMemory());
  assert.deepEqual(good.memory.retained, good.reading.data.snapshot);

  const offline = harness({ hosts: [{ ...OWNER, status: "disconnected" }] });
  const after = await pollPiUsage(offline.deps, good.memory);
  assert.equal(after.reading.status, "unavailable");
  assert.deepEqual(after.reading.data.snapshot.cost, fixture.cost);
  assert.equal(after.reading.data.retained, true);
  assert.equal(after.reading.data.degraded, true);
  assert.equal(piVerifiedIdleZero(after.reading), false);
  // Nothing was observed, so the memory is unchanged rather than cleared.
  assert.deepEqual(after.memory, good.memory);
  onTheWire(after.reading);
});

test("a missing snapshot is missing even when last-good figures are held", async () => {
  const good = await pollPiUsage(harness().deps, piEmptyMemory());
  const gone = harness({ reply: () => answer({ artifact: { state: "absent" } }) });
  const after = await pollPiUsage(gone.deps, good.memory);
  assert.equal(after.reading.status, "missing");
  assert.equal(after.reading.reason, "snapshot_not_placed");
  assert.equal(after.reading.data.retained, true);
  assert.equal(after.reading.data.degraded, true);
  assert.deepEqual(after.memory.retained, good.memory.retained);
});

test("a refused snapshot does not replace the last-good figures", async () => {
  const good = await pollPiUsage(harness().deps, piEmptyMemory());
  const refused = harness({
    reply: () =>
      answer({
        artifact: { state: "refused", reason: "too_large", detail: "the export is larger than the contract allows" },
      }),
  });
  const after = await pollPiUsage(refused.deps, good.memory);
  assert.equal(after.reading.status, "invalid");
  assert.equal(after.reading.reason, "snapshot_rejected:too_large");
  assert.deepEqual(after.memory.retained, good.memory.retained);
  assert.equal(after.memory.failedBefore, false);
});

test("a producer failure note is remembered, and its clearing is observed as recovery", async () => {
  const failing = harness({
    reply: () => answer({ sidecar: { state: "failed", errorClass: "ParserError" } }),
  });
  const failed = await pollPiUsage(failing.deps, piEmptyMemory());
  assert.equal(failed.reading.status, "failed");
  assert.equal(failed.reading.reason, "producer_failed:ParserError");
  assert.equal(failed.reading.data.degraded, true);
  assert.equal(failed.reading.recoveredFromFailure, false);
  assert.equal(failed.memory.failedBefore, true);
  // The artifact beside the note was valid, so it is still the last-good read.
  assert.deepEqual(failed.memory.retained, failed.reading.data.snapshot);

  const recovered = await pollPiUsage(harness().deps, failed.memory);
  assert.equal(recovered.reading.status, "ok");
  assert.equal(recovered.reading.recoveredFromFailure, true);
  assert.equal(recovered.reading.data.degraded, false);
  assert.equal(recovered.memory.failedBefore, false);
  onTheWire(recovered.reading);
});

test("an unreadable failure note is a failure and keeps the verdict standing", async () => {
  const { deps } = harness({
    reply: () => answer({ sidecar: { state: "unreadable", reason: "not_json" } }),
  });
  const result = await pollPiUsage(deps, piEmptyMemory());
  assert.equal(result.reading.status, "failed");
  assert.equal(result.reading.reason, "producer_failed_note_unreadable:not_json");
  assert.equal(result.memory.failedBefore, true);
});

test("a failure note that could not be looked for neither accuses nor absolves", async () => {
  const failing = harness({
    reply: () => answer({ sidecar: { state: "failed", errorClass: null } }),
  });
  const failed = await pollPiUsage(failing.deps, piEmptyMemory());
  assert.equal(failed.reading.reason, "producer_failed:unknown");

  const unchecked = harness({
    reply: () => answer({ sidecar: { state: "unknown", reason: "unreadable" } }),
  });
  const after = await pollPiUsage(unchecked.deps, failed.memory);
  // Not reported as a producer failure, not reported as a recovery, and the
  // figures beside the unchecked note are not a verified observation.
  assert.equal(after.reading.status, "ok");
  assert.equal(after.reading.reason, "fresh_failure_note_unchecked:unreadable");
  assert.equal(after.reading.recoveredFromFailure, false);
  assert.equal(after.reading.data.degraded, true);
  assert.equal(piVerifiedIdleZero(after.reading), false);
  assert.equal(after.memory.failedBefore, true);

  // Once the note really is absent, the retry is observed.
  const recovered = await pollPiUsage(harness().deps, after.memory);
  assert.equal(recovered.reading.recoveredFromFailure, true);
});

test("an unreachable poll between a failure and a retry reports no recovery", async () => {
  const failing = harness({ reply: () => answer({ sidecar: { state: "failed", errorClass: "IOError" } }) });
  const failed = await pollPiUsage(failing.deps, piEmptyMemory());
  assert.equal(failed.memory.failedBefore, true);

  const unreachable = harness({ hosts: [] });
  const gap = await pollPiUsage(unreachable.deps, failed.memory);
  assert.equal(gap.reading.recoveredFromFailure, false);
  assert.equal(gap.memory.failedBefore, true);

  const recovered = await pollPiUsage(harness().deps, gap.memory);
  assert.equal(recovered.reading.recoveredFromFailure, true);
});

test("freshness is judged by this machine's clock against generated_at", async () => {
  const stale = await pollPiUsage(
    harness({ nowMs: generatedAtMs + (PI_GRACE_SECONDS + 1) * 1000 }).deps,
  );
  assert.equal(stale.reading.status, "stale");
  assert.equal(stale.reading.data.degraded, true);
  assert.equal(stale.reading.data.retained, false);
  assert.equal(piVerifiedIdleZero(stale.reading), false);
  onTheWire(stale.reading);

  const future = await pollPiUsage(harness({ nowMs: generatedAtMs - 60_000 }).deps);
  assert.equal(future.reading.status, "future");
  assert.equal(future.reading.data.degraded, true);
  assert.equal(piVerifiedIdleZero(future.reading), false);
  onTheWire(future.reading);

  // A stale or future read is still the last snapshot this panel really saw.
  assert.deepEqual(stale.memory.retained, stale.reading.data.snapshot);
  assert.deepEqual(future.memory.retained, future.reading.data.snapshot);
});

test("the RPC schema refuses a reading the page could misread as no usage", async () => {
  const { reading } = await pollPiUsage(harness().deps);
  assert.equal(piReadingSchema.safeParse({ ...reading, status: "empty" }).success, false);
  assert.equal(piReadingSchema.safeParse({ ...reading, data: {} }).success, false);
  assert.equal(
    piReadingSchema.safeParse({ ...reading, totals: { usd: 0 } }).success,
    false,
  );
  assert.equal(
    piReadingSchema.safeParse({ ...reading, data: { ...reading.data, snapshot: { kind: "pi_usage_snapshot" } } })
      .success,
    false,
  );
});

test("no refusal wording from any reachable state names a machine or a path", async () => {
  const states = [
    harness({ hosts: [] }),
    harness({ hosts: [{ ...OWNER, status: "disconnected" }] }),
    harness({ hosts: [OWNER, { ...OWNER, id: "host-owning-2" }] }),
    harness({
      hosts: () => {
        throw new Error("boom");
      },
    }),
    harness({
      reply: () => {
        throw new Error("boom");
      },
    }),
    harness({ reply: () => ({ nonsense: true }) }),
    harness({ reply: () => answer({ artifact: { state: "absent" } }) }),
    harness({
      reply: () =>
        answer({ artifact: { state: "refused", reason: "symlink", detail: "the export location is a link" } }),
    }),
  ];
  for (const { deps } of states) {
    const { reading } = await pollPiUsage(deps, piEmptyMemory());
    const wording = `${reading.reason} ${reading.detail}`;
    assert.ok(!wording.includes(OWNER.id));
    assert.ok(!wording.includes(PI_OWNING_HOST_NAME));
    assert.ok(!wording.includes("/"), wording);
    assert.ok(!wording.includes("~"), wording);
    onTheWire(reading);
  }
});

/* ------------------------------------------------- the reader the server holds */

test("the reader carries its memory across reads without being handed it", async () => {
  const notes = [{ state: "failed", errorClass: "OSError" }, { state: "absent" }];
  const { deps } = harness({ reply: () => answer({ sidecar: notes.shift() }) });
  const reader = createPiUsageReader(deps);

  const failed = await reader.read();
  assert.equal(failed.status, "failed");
  assert.equal(reader.memory().failedBefore, true);

  const recovered = await reader.read();
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.recoveredFromFailure, true);
  assert.equal(reader.memory().failedBefore, false);
});

test("two askers arriving together share one read of the same file", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { asked, deps } = harness({
    reply: async () => {
      await gate;
      return answer();
    },
  });
  const reader = createPiUsageReader(deps);

  const both = Promise.all([reader.read(), reader.read()]);
  release();
  const [first, second] = await both;
  // One read, one dataset: a replacement snapshot is not read twice, and the
  // two polls cannot each overwrite what the other observed.
  assert.deepEqual(asked, [OWNER.id]);
  assert.equal(first, second);
  assert.equal(first.status, "ok");

  // Once it has settled, the next ask really does read again.
  await reader.read();
  assert.deepEqual(asked, [OWNER.id, OWNER.id]);
});

test("a read whose machine threw still lets the next read happen", async () => {
  let fail = true;
  const { asked, deps } = harness({
    reply: () => {
      if (fail) throw new Error("boom");
      return answer();
    },
  });
  const reader = createPiUsageReader(deps);
  assert.equal((await reader.read()).reason, "owning_host_did_not_answer");
  fail = false;
  assert.equal((await reader.read()).status, "ok");
  assert.deepEqual(asked, [OWNER.id, OWNER.id]);
});

test("the reader's figures never accumulate across reads", async () => {
  const { deps } = harness();
  const reader = createPiUsageReader(deps);
  const readings = [await reader.read(), await reader.read(), await reader.read()];
  for (const reading of readings) {
    assert.deepEqual(reading.data.snapshot, readings[0].data.snapshot);
    assert.deepEqual(reading.data.snapshot.cost, fixture.cost);
    onTheWire(reading);
  }
});
