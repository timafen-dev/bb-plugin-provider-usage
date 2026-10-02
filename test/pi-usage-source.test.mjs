// Behavioural cover for the confined read of the Firstmate Pi export location.
//
// These tests use real directories, real links and real file modes under a
// temporary home, because the behaviour under test is exactly what the
// filesystem does: a link is refused instead of followed, a directory wearing
// the artifact's name is refused, an oversized file never reaches the parser,
// and a failure note that cannot be read still means the export failed. No
// test inspects implementation source text.
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

const {
  PI_EXPORT_DIR_SEGMENTS,
  PI_SIDECAR_SUFFIX,
  PI_SNAPSHOT_FILE_NAME,
  piExportLocation,
  readPiExportFacts,
  readPiExportFiles,
} = await import("../lib/pi-usage-source.ts");

const { PI_GRACE_SECONDS, PI_MAX_SNAPSHOT_BYTES, piVerifiedIdleZero, readPiUsageFacts } =
  await import("../lib/pi-usage-contract.ts");

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi-usage-snapshot.json",
);
const fixtureText = await readFile(fixturePath, "utf8");
const FIXTURE_BYTES = 10836;
/** The instant the fixture says it was generated at. */
const generatedAtMs = Date.parse(JSON.parse(fixtureText).generated_at);

const homes = [];

/** A throwaway home with the conventional export directory already made. */
async function makeHome({ withDirectory = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), "pi-usage-home-"));
  homes.push(home);
  const location = piExportLocation(home);
  if (withDirectory) await mkdir(location.root, { recursive: true });
  return { home, location };
}

/** Somewhere a hostile link could point: another account, another tool. */
async function makeElsewhere() {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-elsewhere-"));
  homes.push(dir);
  return dir;
}

test.after(async () => {
  for (const dir of homes) await rm(dir, { recursive: true, force: true });
});

async function placeFixture() {
  const { home, location } = await makeHome();
  await writeFile(location.snapshot, fixtureText, "utf8");
  return { home, location };
}

test("the export location is the producer's own documented convention", () => {
  const location = piExportLocation("/home/someone");
  assert.deepEqual([...PI_EXPORT_DIR_SEGMENTS], [".local", "state", "pi-usage"]);
  assert.equal(location.snapshot, "/home/someone/.local/state/pi-usage/snapshot.json");
  assert.equal(location.sidecar, `${location.snapshot}${PI_SIDECAR_SUFFIX}`);
  assert.equal(PI_SNAPSHOT_FILE_NAME, "snapshot.json");
});

test("a placed snapshot reads as a valid artifact of exactly its own bytes", async () => {
  const { home } = await placeFixture();
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "valid");
  assert.equal(facts.bytes, FIXTURE_BYTES);
  assert.equal(facts.artifact.bytes, FIXTURE_BYTES);
  assert.equal(facts.artifact.snapshot.producer.alias, "firstmate-pi");
  assert.equal(facts.sidecar.state, "absent");
});

test("a confined read never carries the file's text or its location", async () => {
  const { home } = await placeFixture();
  const facts = await readPiExportFacts({ home });
  assert.deepEqual(Object.keys(facts).sort(), ["artifact", "bytes", "sidecar"]);
  assert.deepEqual(Object.keys(facts.artifact).sort(), ["bytes", "snapshot", "state"]);
  assert.ok(!JSON.stringify(facts).includes(home));
});

test("an export location that was never created is missing, not a zero", async () => {
  const { home } = await makeHome({ withDirectory: false });
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "absent");
  assert.equal(facts.sidecar.state, "absent");
  assert.equal(facts.bytes, null);

  const reading = readPiUsageFacts({ ...facts, nowMs: Date.now() });
  assert.equal(reading.status, "missing");
  assert.equal(reading.data, null);
  assert.equal(piVerifiedIdleZero(reading), false);
});

test("an empty export directory is missing, not a zero", async () => {
  const { home } = await makeHome();
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "absent");
  assert.equal(readPiUsageFacts({ ...facts, nowMs: Date.now() }).status, "missing");
});

test("a snapshot that is a link is refused rather than followed", async () => {
  const { home, location } = await makeHome();
  const elsewhere = await makeElsewhere();
  // Stand in for the sort of file a link could aim at: not ours to read.
  const decoy = join(elsewhere, "session-transcript.jsonl");
  await writeFile(decoy, '{"private":"not for this panel"}\n', "utf8");
  await symlink(decoy, location.snapshot);

  const read = await readPiExportFiles({ home });
  assert.deepEqual(read.snapshot, { state: "refused", refusal: "symlink" });

  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "refused");
  assert.equal(facts.artifact.reason, "symlink");
  const reading = readPiUsageFacts({ ...facts, nowMs: Date.now() });
  assert.equal(reading.status, "invalid");
  assert.equal(reading.reason, "snapshot_rejected:symlink");
  assert.equal(reading.data, null);
  for (const text of [reading.detail, reading.reason]) {
    assert.ok(!text.includes(home));
    assert.ok(!text.includes(decoy));
    assert.ok(!text.includes("not for this panel"));
  }
});

test("a link to a legitimate snapshot elsewhere is refused all the same", async () => {
  const { home, location } = await makeHome();
  const elsewhere = await makeElsewhere();
  const real = join(elsewhere, "snapshot.json");
  await writeFile(real, fixtureText, "utf8");
  await symlink(real, location.snapshot);

  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "refused");
  assert.equal(facts.artifact.reason, "symlink");
});

test("a directory wearing the artifact's name is refused", async () => {
  const { home, location } = await makeHome();
  await mkdir(location.snapshot);
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "refused");
  assert.equal(facts.artifact.reason, "not_a_regular_file");
  assert.equal(
    readPiUsageFacts({ ...facts, nowMs: Date.now() }).reason,
    "snapshot_rejected:not_a_regular_file",
  );
});

test("an export directory linked outside the home is refused, both names", async () => {
  const { home, location } = await makeHome({ withDirectory: false });
  const elsewhere = await makeElsewhere();
  await mkdir(dirname(location.root), { recursive: true });
  await writeFile(join(elsewhere, PI_SNAPSHOT_FILE_NAME), fixtureText, "utf8");
  await symlink(elsewhere, location.root);

  const read = await readPiExportFiles({ home });
  assert.equal(read.snapshot.refusal, "outside_export_directory");
  assert.equal(read.sidecar.state, "unknown");
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "refused");
  assert.equal(facts.artifact.reason, "outside_export_directory");
  // No note was seen, so the producer is not reported as having failed.
  assert.deepEqual(facts.sidecar, { state: "unknown", reason: "outside_export_directory" });
  const reading = readPiUsageFacts({ ...facts, nowMs: Date.now() });
  assert.equal(reading.status, "invalid");
  assert.equal(reading.reason, "snapshot_rejected:outside_export_directory");
  assert.equal(reading.data, null);
  assert.ok(!reading.detail.includes(elsewhere));
  assert.ok(!reading.detail.includes(home));
});

test("a failure note that could not be looked for does not clear a failure", async () => {
  const { home, location } = await makeHome({ withDirectory: false });
  const elsewhere = await makeElsewhere();
  await mkdir(dirname(location.root), { recursive: true });
  await writeFile(join(elsewhere, PI_SNAPSHOT_FILE_NAME), fixtureText, "utf8");
  await symlink(elsewhere, location.root);
  const reading = readPiUsageFacts({
    ...(await readPiExportFacts({ home })),
    nowMs: Date.now(),
    failedBefore: true,
  });
  // "I could not look" is not "the retry succeeded".
  assert.equal(reading.recoveredFromFailure, false);
});

test("a directory that refuses to be looked into is unknown, not empty", async () => {
  const { home, location } = await placeFixture();
  await chmod(location.root, 0o000);
  try {
    const read = await readPiExportFiles({ home });
    assert.equal(read.snapshot.state, "unknown");
    assert.equal(read.sidecar.state, "unknown");
    const facts = await readPiExportFacts({ home });
    assert.equal(facts.artifact.state, "refused");
    assert.equal(facts.artifact.reason, "unreadable");
    assert.deepEqual(facts.sidecar, { state: "unknown", reason: "unreadable" });
    const reading = readPiUsageFacts({ ...facts, nowMs: generatedAtMs, failedBefore: true });
    assert.equal(reading.status, "invalid");
    assert.equal(reading.data, null);
    assert.equal(reading.recoveredFromFailure, false);
  } finally {
    await chmod(location.root, 0o700);
  }
});

test("a snapshot whose failure note could not be checked is never fresh-verified", async () => {
  const { home } = await placeFixture();
  const facts = await readPiExportFacts({ home });
  const reading = readPiUsageFacts({
    ...facts,
    sidecar: { state: "unknown", reason: "unreadable" },
    nowMs: generatedAtMs,
  });
  assert.equal(reading.status, "ok");
  assert.equal(reading.data.degraded, true);
  assert.equal(reading.reason, "fresh_failure_note_unchecked:unreadable");
  assert.equal(piVerifiedIdleZero(reading), false);
  // Without the doubt, the very same snapshot reads as a current observation.
  const certain = readPiUsageFacts({ ...facts, nowMs: generatedAtMs });
  assert.equal(certain.data.degraded, false);
  assert.equal(certain.reason, "fresh");
});

test("an export directory linked within the same home is still read", async () => {
  const { home, location } = await makeHome({ withDirectory: false });
  const real = join(home, "pi-usage-state");
  await mkdir(real);
  await mkdir(dirname(location.root), { recursive: true });
  await writeFile(join(real, PI_SNAPSHOT_FILE_NAME), fixtureText, "utf8");
  await symlink(real, location.root);
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "valid");
});

test("a file at the byte bound is read and one byte over it is refused", async () => {
  const { home, location } = await makeHome();
  await writeFile(location.snapshot, "a".repeat(64), "utf8");
  const atBound = await readPiExportFiles({ home, maxBytes: 64 });
  assert.equal(atBound.snapshot.state, "text");
  assert.equal(atBound.snapshot.bytes, 64);

  await writeFile(location.snapshot, "a".repeat(65), "utf8");
  const overBound = await readPiExportFiles({ home, maxBytes: 64 });
  assert.deepEqual(overBound.snapshot, { state: "refused", refusal: "too_large" });
});

test("the default bound is the agreed snapshot size, enforced before parsing", async () => {
  const { home, location } = await makeHome();
  await writeFile(location.snapshot, Buffer.alloc(PI_MAX_SNAPSHOT_BYTES + 1, 0x61));
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "refused");
  assert.equal(facts.artifact.reason, "too_large");
  assert.ok(facts.artifact.detail.includes(String(PI_MAX_SNAPSHOT_BYTES)));
  assert.equal(facts.bytes, null);
});

test("multi-byte characters count as their bytes, not their length", async () => {
  const { home, location } = await makeHome();
  // Thirty-three characters, sixty-six bytes.
  await writeFile(location.snapshot, "é".repeat(33), "utf8");
  assert.equal((await readPiExportFiles({ home, maxBytes: 64 })).snapshot.refusal, "too_large");
  const smaller = await readPiExportFiles({ home, maxBytes: 66 });
  assert.equal(smaller.snapshot.bytes, 66);
});

test("a placed file that is not the agreed artifact is invalid, not a zero", async () => {
  const { home, location } = await makeHome();
  await writeFile(location.snapshot, "{not json", "utf8");
  const facts = await readPiExportFacts({ home });
  assert.equal(facts.artifact.state, "refused");
  assert.equal(facts.artifact.reason, "not_json");
  const reading = readPiUsageFacts({ ...facts, nowMs: Date.now() });
  assert.equal(reading.status, "invalid");
  assert.equal(reading.data, null);
  assert.equal(piVerifiedIdleZero(reading), false);
});

test("the failure note is read from the artifact's name plus the agreed suffix", async () => {
  const { home, location } = await placeFixture();
  await writeFile(
    join(location.root, "status.json"),
    JSON.stringify({ status: "failed" }),
    "utf8",
  );
  // A note under any other name is not this artifact's note.
  assert.equal((await readPiExportFacts({ home })).sidecar.state, "absent");

  await writeFile(
    location.sidecar,
    JSON.stringify({ status: "failed", error_class: "disk_full", artifact: "json" }),
    "utf8",
  );
  const facts = await readPiExportFacts({ home });
  assert.deepEqual(facts.sidecar, { state: "failed", errorClass: "disk_full" });

  const reading = readPiUsageFacts({ ...facts, nowMs: generatedAtMs });
  assert.equal(reading.status, "failed");
  assert.equal(reading.reason, "producer_failed:disk_full");
  // The artifact may still be shown, but never as a current observation.
  assert.equal(reading.data.degraded, true);
  assert.equal(reading.data.retained, false);
});

test("a failure note that cannot be read is a failure, not an absent note", async () => {
  const { home, location } = await placeFixture();
  await writeFile(location.sidecar, "truncated{", "utf8");
  const facts = await readPiExportFacts({ home });
  assert.deepEqual(facts.sidecar, { state: "unreadable", reason: "not_json" });
  const reading = readPiUsageFacts({ ...facts, nowMs: generatedAtMs });
  assert.equal(reading.status, "failed");
  assert.equal(reading.reason, "producer_failed_note_unreadable:not_json");
});

test("a failure note that is a link is a failure too", async () => {
  const { home, location } = await placeFixture();
  const elsewhere = await makeElsewhere();
  const target = join(elsewhere, "note.json");
  await writeFile(target, JSON.stringify({ status: "failed" }), "utf8");
  await symlink(target, location.sidecar);
  const facts = await readPiExportFacts({ home });
  assert.deepEqual(facts.sidecar, { state: "unreadable", reason: "symlink" });
  const reading = readPiUsageFacts({ ...facts, nowMs: generatedAtMs });
  assert.equal(reading.status, "failed");
  assert.equal(reading.reason, "producer_failed_note_unreadable:symlink");
});

test("an oversized failure note is a failure, not an absent note", async () => {
  const { home, location } = await placeFixture();
  await writeFile(location.sidecar, "a".repeat(200), "utf8");
  const facts = await readPiExportFacts({ home, maxBytes: 100 });
  assert.deepEqual(facts.sidecar, { state: "unreadable", reason: "too_large" });
  // The artifact is over the same bound here, so both are refused together.
  assert.equal(facts.artifact.state, "refused");
});

test("the producer's successful retry is observed as recovery", async () => {
  const { home, location } = await placeFixture();
  await writeFile(location.sidecar, JSON.stringify({ status: "failed" }), "utf8");
  const failed = readPiUsageFacts({
    ...(await readPiExportFacts({ home })),
    nowMs: generatedAtMs,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.recoveredFromFailure, false);

  await rm(location.sidecar);
  const recovered = readPiUsageFacts({
    ...(await readPiExportFacts({ home })),
    nowMs: generatedAtMs,
    failedBefore: true,
  });
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.recoveredFromFailure, true);
  assert.equal(recovered.data.degraded, false);
});

test("freshness comes from the snapshot, not from the file's modification time", async () => {
  const { home } = await placeFixture();
  const facts = await readPiExportFacts({ home });
  // The file was written a moment ago; the snapshot was generated long before.
  const fresh = readPiUsageFacts({ ...facts, nowMs: generatedAtMs + 1000 });
  assert.equal(fresh.status, "ok");
  const stale = readPiUsageFacts({
    ...facts,
    nowMs: generatedAtMs + (PI_GRACE_SECONDS + 1) * 1000,
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.data.degraded, true);
  assert.equal(stale.data.retained, false);
  assert.equal(piVerifiedIdleZero(stale), false);

  const nowIsBefore = readPiUsageFacts({ ...facts, nowMs: generatedAtMs - 60_000 });
  assert.equal(nowIsBefore.status, "future");
  assert.equal(nowIsBefore.data.degraded, true);
});

test("reading the same placed snapshot twice yields exactly the same figures", async () => {
  const { home } = await placeFixture();
  const first = await readPiExportFacts({ home });
  const second = await readPiExportFacts({ home });
  assert.deepEqual(second, first);
  const a = readPiUsageFacts({ ...first, nowMs: generatedAtMs });
  const b = readPiUsageFacts({ ...second, nowMs: generatedAtMs });
  assert.deepEqual(b.data.snapshot.cost, a.data.snapshot.cost);
  assert.deepEqual(b.data.snapshot.tokens, a.data.snapshot.tokens);
  assert.deepEqual(b.data.snapshot.tasks, a.data.snapshot.tasks);
});

test("no refusal names the machine, the home or the file", async () => {
  const { home, location } = await makeHome();
  const cases = [];

  await mkdir(location.snapshot);
  cases.push(await readPiExportFacts({ home }));
  await rm(location.snapshot, { recursive: true });

  await writeFile(location.snapshot, "a".repeat(200), "utf8");
  cases.push(await readPiExportFacts({ home, maxBytes: 100 }));

  await writeFile(location.snapshot, "{oops", "utf8");
  cases.push(await readPiExportFacts({ home }));

  for (const facts of cases) {
    const reading = readPiUsageFacts({ ...facts, nowMs: Date.now() });
    for (const text of [reading.reason, reading.detail, JSON.stringify(facts)]) {
      assert.ok(!text.includes(home), text);
      assert.ok(!text.includes("snapshot.json"), text);
      assert.ok(!text.includes(tmpdir()), text);
    }
  }
});

/* ------------------------------------------------- the host read's own wire */

const { PI_HOST_READ_VERSION, externalPiUsageSchema, hostContract } = await import(
  "../host-contract.ts"
);

test("the host read asks for nothing: no path, no root, no machine", () => {
  const input = hostContract.externalPiUsage.input;
  assert.equal(input.safeParse(null).success, true);
  for (const attempt of [
    { path: "/home/someone/.local/state/pi-usage/snapshot.json" },
    { root: "/" },
    { hostId: "homeserver" },
    { command: "cat" },
    "/etc/passwd",
    {},
  ]) {
    assert.equal(input.safeParse(attempt).success, false);
  }
});

test("the host read's wire carries a real confined read and nothing more", async () => {
  const { home } = await placeFixture();
  const facts = await readPiExportFacts({ home });
  const wire = { version: PI_HOST_READ_VERSION, ...facts };
  const parsed = externalPiUsageSchema.safeParse(wire);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 4)));
  assert.equal(parsed.data.artifact.snapshot.producer.alias, "firstmate-pi");
  assert.equal(parsed.data.bytes, FIXTURE_BYTES);

  // A machine running a different version of this read must not be guessed at.
  assert.equal(externalPiUsageSchema.safeParse({ ...wire, version: 2 }).success, false);
  // And nothing may ride along beside the agreed fields.
  assert.equal(
    externalPiUsageSchema.safeParse({ ...wire, snapshotPath: "/tmp/x" }).success,
    false,
  );
  assert.equal(
    externalPiUsageSchema.safeParse({
      ...wire,
      artifact: { ...facts.artifact, text: fixtureText },
    }).success,
    false,
  );
});

test("every state a confined read can reach travels on the wire", async () => {
  const { home, location } = await makeHome();
  const states = [];
  const push = async (options) => {
    const facts = await readPiExportFacts({ home, ...options });
    const parsed = externalPiUsageSchema.safeParse({ version: PI_HOST_READ_VERSION, ...facts });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 4)));
    states.push(`${facts.artifact.state}:${facts.sidecar.state}`);
  };

  await push({});
  await writeFile(location.snapshot, fixtureText, "utf8");
  await push({});
  await writeFile(location.sidecar, JSON.stringify({ status: "failed" }), "utf8");
  await push({});
  await writeFile(location.sidecar, "{broken", "utf8");
  await push({});
  await rm(location.sidecar);
  await writeFile(location.snapshot, "{broken", "utf8");
  await push({});
  await chmod(location.root, 0o000);
  try {
    await push({});
  } finally {
    await chmod(location.root, 0o700);
  }

  assert.deepEqual(states, [
    "absent:absent",
    "valid:absent",
    "valid:failed",
    "valid:unreadable",
    "refused:absent",
    "refused:unknown",
  ]);
});
