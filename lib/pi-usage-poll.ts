/**
 * One poll of the Firstmate Pi export, as the server performs it.
 *
 * This is the piece between the two halves that already exist: the owning
 * machine reads its own fixed location and reports facts
 * (`lib/pi-usage-source.ts`, surfaced by the `externalPiUsage` host read), and
 * `readPiUsageFacts` turns facts into a reading against *this* machine's clock.
 * What is left — and what lives here — is the asking:
 *
 *  - pick the one approved owning machine out of the server's own machine list,
 *    never a nearest match, never the server's own disk, never a sweep of
 *    everything connected and never a sum of two answers;
 *  - validate the answer against the host read's own wire schema, so a machine
 *    running a different plugin version is incompatible rather than
 *    half-understood;
 *  - summarise every failure of the hop into a stable code and fixed wording,
 *    because a transport error can carry a machine name, a socket path or a
 *    stack, and none of that belongs in a panel;
 *  - carry exactly two facts across polls — the last figures actually read and
 *    whether the last poll saw a producer failure note — so a successful retry
 *    can be *observed* as recovery.
 *
 * Two things this deliberately does not do. It never accumulates: each poll's
 * snapshot replaces the last one entirely, so polling the same artifact twice
 * yields the same totals and no recorded call is ever counted again. And it
 * starts nothing: a poll happens when something asks the server, and this task
 * installs no timer and enables no live wiring.
 */
import {
  externalPiUsageSchema,
  type ExternalPiUsageRead,
} from "../host-contract";
import {
  readPiUsageFacts,
  type PiReading,
  type PiSidecarFact,
  type PiUsageSnapshot,
} from "./pi-usage-contract";
import {
  PI_HOST_CALL_FAILED,
  PI_HOST_READ_INCOMPATIBLE,
  piOwningHost,
  type PiHostRow,
} from "./pi-usage-owner";

/** The fixed wording for a machine list that could not be obtained at all. */
export const PI_HOST_LIST_FAILED = {
  reason: "machine_list_unavailable",
  detail: "the list of machines could not be read, so no Firstmate Pi machine was asked",
} as const;

/**
 * What one poll remembers from the one before it. Nothing else crosses polls:
 * no running totals, no counters, no merged snapshots.
 */
export interface PiPollMemory {
  /** The last snapshot actually read and validated, or `null`. */
  retained: PiUsageSnapshot | null;
  /** Whether the last poll that reached the location saw a failure note. */
  failedBefore: boolean;
}

export function piEmptyMemory(): PiPollMemory {
  return { retained: null, failedBefore: false };
}

export interface PiPollDeps {
  /** The server's own machine list. */
  hosts: () => Promise<readonly PiHostRow[]>;
  /**
   * The `externalPiUsage` host read, for one named machine. The answer is
   * validated here, so this may return anything and be wrong about it.
   */
  read: (hostId: string) => Promise<unknown>;
  /** This machine's clock. Freshness is judged here, never on the producer. */
  nowMs: () => number;
  graceSeconds?: number;
}

export interface PiPollResult {
  reading: PiReading;
  /** What the next poll should remember. Callers hold this; nothing global. */
  memory: PiPollMemory;
}

/**
 * The sidecar state to assume when the location was never reached.
 *
 * Not `absent`: "no note was found" would clear a failure the last poll saw
 * and announce a producer recovery that was never observed.
 */
function unreachedSidecar(reason: string): PiSidecarFact {
  return { state: "unknown", reason };
}

function unavailable(
  input: { reason: string; detail: string },
  memory: PiPollMemory,
  nowMs: number,
  graceSeconds: number | undefined,
): PiPollResult {
  return {
    reading: readPiUsageFacts({
      unavailable: input,
      sidecar: unreachedSidecar(input.reason),
      retained: memory.retained,
      failedBefore: memory.failedBefore,
      nowMs,
      graceSeconds,
    }),
    // Nothing was observed, so nothing is updated: the retained figures and the
    // producer's last known failure both survive an unreachable poll.
    memory,
  };
}

/**
 * Whether the next poll should treat the producer as having failed.
 *
 * `absent` is the only state that clears it, because only the absence of a note
 * is evidence of a successful export. `unknown` — the note could not even be
 * looked for — leaves the previous verdict standing.
 */
function failedNext(sidecar: PiSidecarFact, memory: PiPollMemory): boolean {
  if (sidecar.state === "absent") return false;
  if (sidecar.state === "unknown") return memory.failedBefore;
  return true;
}

/** Does one poll. Returns a reading and the memory the next poll needs. */
export async function pollPiUsage(
  deps: PiPollDeps,
  memory: PiPollMemory = piEmptyMemory(),
): Promise<PiPollResult> {
  const grace = deps.graceSeconds;

  let hosts: readonly PiHostRow[];
  try {
    hosts = await deps.hosts();
  } catch {
    return unavailable(PI_HOST_LIST_FAILED, memory, deps.nowMs(), grace);
  }

  const owner = piOwningHost(hosts);
  if (owner.state !== "ready") {
    return unavailable(owner, memory, deps.nowMs(), grace);
  }

  let answer: unknown;
  try {
    answer = await deps.read(owner.hostId);
  } catch {
    // Never the error's own text: it can name the machine or quote a stack.
    return unavailable(PI_HOST_CALL_FAILED, memory, deps.nowMs(), grace);
  }

  const parsed = externalPiUsageSchema.safeParse(answer);
  if (!parsed.success) {
    return unavailable(PI_HOST_READ_INCOMPATIBLE, memory, deps.nowMs(), grace);
  }
  const read: ExternalPiUsageRead = parsed.data;

  const reading = readPiUsageFacts({
    artifact: read.artifact,
    sidecar: read.sidecar,
    retained: memory.retained,
    failedBefore: memory.failedBefore,
    nowMs: deps.nowMs(),
    graceSeconds: grace,
  });

  return {
    reading,
    memory: {
      // Last-good means the last snapshot this panel really read. A refused or
      // absent artifact does not replace it, and a retained snapshot is only
      // ever displayed as degraded, never as a fresh observation.
      retained:
        read.artifact.state === "valid" ? read.artifact.snapshot : memory.retained,
      failedBefore: failedNext(read.sidecar, memory),
    },
  };
}

/**
 * A reader that keeps one poll's memory and never runs two polls at once.
 *
 * Both halves matter for honesty rather than for speed. Two polls racing would
 * each read the memory the other was about to replace, and the loser's
 * observation — in particular "the producer's failure note is gone" — would be
 * dropped or reported twice. And since a snapshot is a replacement dataset,
 * two askers arriving together want the same figures, not two reads of the same
 * file. So an in-flight poll is shared, and the next one starts after it.
 *
 * This is still not a poller: nothing here schedules anything, and a read
 * happens only when something asks.
 */
export interface PiUsageReader {
  read: () => Promise<PiReading>;
  /** What the next poll will remember. Exposed for tests and diagnostics. */
  memory: () => PiPollMemory;
}

export function createPiUsageReader(deps: PiPollDeps): PiUsageReader {
  let memory = piEmptyMemory();
  let inflight: Promise<PiReading> | null = null;

  const read = (): Promise<PiReading> => {
    if (inflight) return inflight;
    const run = pollPiUsage(deps, memory)
      .then((result) => {
        memory = result.memory;
        return result.reading;
      })
      .finally(() => {
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  };

  return { read, memory: () => memory };
}
