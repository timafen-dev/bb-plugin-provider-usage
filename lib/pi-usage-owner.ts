/**
 * Which machine may be asked for the Firstmate Pi snapshot.
 *
 * Exactly one. The producer runs on one approved owning machine and writes one
 * artifact there, so a consumer that asked every connected machine would, at
 * best, read the same figures twice — and summing them would double the work
 * Pi actually did. There is also nothing to fall back to: the server's own
 * disk holds no Pi export, and another machine's would be another dataset.
 *
 * So the rules here are deliberately unhelpful:
 *
 *  - the owning machine is named in code, not chosen by a caller, a setting or
 *    an RPC input;
 *  - if it is not in the machine list, the answer is "unavailable" — never the
 *    nearest other machine, never the server itself, and never a zero;
 *  - if two machines answer to the name, that is an ambiguity to report, not a
 *    pair to add up;
 *  - if it is offline, its last-known figures may be shown as degraded, but
 *    the reading is still not current.
 *
 * Nothing here enables a poll: resolving the owning machine is what the server
 * does when something asks it, and this task installs no timer.
 */

/**
 * The approved owning machine for the Pi export, as the holding's own machine
 * list names it. Changing this is changing which machine is trusted, which
 * needs the same approval as placing the snapshot does.
 */
export const PI_OWNING_HOST_NAME = "homeserver";

export interface PiHostRow {
  id: string;
  name: string;
  status: "connected" | "disconnected" | string;
}

export type PiOwningHost =
  /** The one approved machine, connected and askable. */
  | { state: "ready"; hostId: string }
  /**
   * No reading is possible. The reason is a stable code and the detail is
   * fixed wording: neither names a machine, an account or a path, because
   * another machine's identity is not this panel's to disclose.
   */
  | { state: "unavailable"; reason: string; detail: string };

function unavailable(reason: string, detail: string): PiOwningHost {
  return { state: "unavailable", reason, detail };
}

/**
 * Picks the approved owning machine out of a machine list, or says why there
 * is none to ask.
 */
export function piOwningHost(hosts: readonly PiHostRow[]): PiOwningHost {
  const found = hosts.filter((host) => host.name === PI_OWNING_HOST_NAME);
  if (found.length === 0) {
    return unavailable(
      "owning_host_unknown",
      "the approved machine for Firstmate Pi is not in this machine list",
    );
  }
  if (found.length > 1) {
    return unavailable(
      "owning_host_ambiguous",
      "more than one machine answers to the approved Firstmate Pi name, so none is read",
    );
  }
  const [host] = found;
  if (host.status !== "connected") {
    return unavailable(
      "owning_host_offline",
      "the approved machine for Firstmate Pi is offline",
    );
  }
  return { state: "ready", hostId: host.id };
}

/**
 * The fixed wording for a machine that was asked and did not answer.
 *
 * Call failures are summarised, never quoted: a transport error can carry a
 * host name, a socket path or a stack, and none of that belongs in a panel.
 */
export const PI_HOST_CALL_FAILED = {
  reason: "owning_host_did_not_answer",
  detail: "the approved machine for Firstmate Pi did not answer this read",
} as const;

/** The fixed wording for a machine answering a read this plugin cannot read. */
export const PI_HOST_READ_INCOMPATIBLE = {
  reason: "owning_host_read_incompatible",
  detail:
    "the approved machine answered with a Firstmate Pi read this panel does not understand",
} as const;
