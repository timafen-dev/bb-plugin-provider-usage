/**
 * Where the Firstmate Pi snapshot is read from, and how little it is trusted.
 *
 * The producer writes its bounded, sanitized export to a fixed conventional
 * private location on the machine that runs Pi — the same location its own
 * documented operation writes:
 *
 *   ~/.local/state/pi-usage/snapshot.json
 *   ~/.local/state/pi-usage/snapshot.json.status.json   (failure note)
 *
 * That location is compiled in here and nowhere else. No RPC input selects it,
 * so no caller can ask this plugin to read a path, a root, a command or a
 * machine of its choosing: the only question the transport can ask is "what
 * does the one approved export location hold right now".
 *
 * Everything in this module exists to make a read refusable:
 *
 *  - a symlink is refused rather than followed, so the one file name cannot be
 *    pointed at a session transcript, an auth store or anything else;
 *  - the export directory must really resolve inside the owning account's
 *    home, so a linked directory cannot move the location off the machine's
 *    own account;
 *  - anything that is not a regular file is refused;
 *  - the size is bounded before a byte is decoded, and the read itself stops
 *    one byte past the bound, so a file that grows between the check and the
 *    read still cannot be loaded;
 *  - a refusal carries a stable code and fixed wording only. No path, no home
 *    directory, no exception text travels with it.
 *
 * Judging the content is not this module's business — `pi-usage-contract.ts`
 * owns that. This module turns a confined read into the facts that module
 * reads, and installs no timer: nothing here polls anything.
 */
import { constants as fsConstants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  PI_MAX_SNAPSHOT_BYTES,
  piArtifactFactFromText,
  piSidecarFactFromText,
  type PiArtifactFact,
  type PiSidecarFact,
} from "./pi-usage-contract";

/** The export directory, relative to the owning account's home. */
export const PI_EXPORT_DIR_SEGMENTS = [".local", "state", "pi-usage"] as const;
/** The one artifact this consumer reads. */
export const PI_SNAPSHOT_FILE_NAME = "snapshot.json";
/** The producer's failure note sits beside its artifact under this suffix. */
export const PI_SIDECAR_SUFFIX = ".status.json";

/**
 * The documented location, for README and release notes. Deliberately not part
 * of any RPC output: a panel never needs to show a filesystem path.
 */
export const PI_EXPORT_LOCATION_DOC = `~/${PI_EXPORT_DIR_SEGMENTS.join("/")}/${PI_SNAPSHOT_FILE_NAME}`;

export interface PiExportLocation {
  root: string;
  snapshot: string;
  sidecar: string;
}

/** The fixed location under one home. Nothing else may be read. */
export function piExportLocation(home: string): PiExportLocation {
  const root = join(home, ...PI_EXPORT_DIR_SEGMENTS);
  const snapshot = join(root, PI_SNAPSHOT_FILE_NAME);
  return { root, snapshot, sidecar: `${snapshot}${PI_SIDECAR_SUFFIX}` };
}

export type PiFileRefusal =
  /** The name is a link, not the exported file. */
  | "symlink"
  /** A directory, device or socket wearing the file's name. */
  | "not_a_regular_file"
  /** The export directory does not resolve inside the owning home. */
  | "outside_export_directory"
  /** Bigger than the agreed bound, refused before being decoded. */
  | "too_large"
  /** Present, and the read itself failed. */
  | "unreadable";

export type PiFileRead =
  | { state: "absent" }
  | { state: "text"; text: string; bytes: number }
  | { state: "refused"; refusal: PiFileRefusal }
  /**
   * Whether the name is there at all could not be established — the directory
   * refused to be looked into, or the stat itself failed. Deliberately not
   * folded into "absent": for the producer's failure note, "there is no note"
   * and "I could not look" mean opposite things, and only the first of them
   * may clear a failure the last poll saw.
   */
  | { state: "unknown"; refusal: PiFileRefusal };

export interface PiConfinedRead {
  snapshot: PiFileRead;
  sidecar: PiFileRead;
}

export interface PiReadOptions {
  /** The owning account's home. Taken from the host, never from a caller. */
  home?: string;
  /** The byte bound. Overridden only by tests. */
  maxBytes?: number;
}

function missing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isLinkError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // Linux reports O_NOFOLLOW on a link as ELOOP; some platforms use EMLINK.
  return code === "ELOOP" || code === "EMLINK";
}

/**
 * Reads one confined file.
 *
 * `lstat` first so a link is refused instead of resolved, then `O_NOFOLLOW` on
 * the open so a name swapped for a link after the check still cannot be
 * followed, then `fstat` on the open handle so the bound is enforced against
 * the file actually opened rather than the one that was there a moment ago.
 */
async function readConfinedFile(path: string, maxBytes: number): Promise<PiFileRead> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (missing(error)) return { state: "absent" };
    // We never saw what is there, so we must not claim nothing is.
    return { state: "unknown", refusal: "unreadable" };
  }
  if (stats.isSymbolicLink()) return { state: "refused", refusal: "symlink" };
  if (!stats.isFile()) return { state: "refused", refusal: "not_a_regular_file" };
  if (stats.size > maxBytes) return { state: "refused", refusal: "too_large" };

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return { state: "absent" };
    if (isLinkError(error)) return { state: "refused", refusal: "symlink" };
    return { state: "refused", refusal: "unreadable" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { state: "refused", refusal: "not_a_regular_file" };
    if (opened.size > maxBytes) return { state: "refused", refusal: "too_large" };
    // One byte past the bound is enough to tell "at the bound" from "over it",
    // and is all that is ever held in memory.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytes = 0;
    while (bytes <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
    }
    if (bytes > maxBytes) return { state: "refused", refusal: "too_large" };
    return {
      state: "text",
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)),
      bytes,
    };
  } catch {
    return { state: "refused", refusal: "unreadable" };
  } finally {
    await handle.close().catch(() => {});
  }
}

function inside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
 * Reads the one approved export location.
 *
 * The directory is resolved once and must land inside the owning home; if it
 * does not, both names are refused together rather than read from wherever the
 * link pointed.
 */
export async function readPiExportFiles(
  options: PiReadOptions = {},
): Promise<PiConfinedRead> {
  const home = options.home ?? homedir();
  const maxBytes = options.maxBytes ?? PI_MAX_SNAPSHOT_BYTES;
  const location = piExportLocation(home);

  let realRoot: string;
  let realHome: string;
  try {
    realRoot = await realpath(location.root);
    realHome = await realpath(home);
  } catch (error) {
    if (missing(error)) return { snapshot: { state: "absent" }, sidecar: { state: "absent" } };
    return {
      snapshot: { state: "unknown", refusal: "unreadable" },
      sidecar: { state: "unknown", refusal: "unreadable" },
    };
  }
  if (!inside(realHome, realRoot)) {
    // The location itself is wrong, so the artifact is refused outright. The
    // note is reported as unknown rather than refused: no note was seen, and
    // claiming the producer failed would be as wrong as claiming it did not.
    return {
      snapshot: { state: "refused", refusal: "outside_export_directory" },
      sidecar: { state: "unknown", refusal: "outside_export_directory" },
    };
  }

  const [snapshot, sidecar] = await Promise.all([
    readConfinedFile(location.snapshot, maxBytes),
    readConfinedFile(location.sidecar, maxBytes),
  ]);
  return { snapshot, sidecar };
}

const REFUSAL_DETAIL: Record<PiFileRefusal, string> = {
  symlink: "the Firstmate Pi snapshot is a link rather than the exported file",
  not_a_regular_file: "the Firstmate Pi snapshot is not a regular file",
  outside_export_directory:
    "the Firstmate Pi export directory does not resolve inside the owning account's home",
  too_large: `the Firstmate Pi snapshot is larger than the agreed ${PI_MAX_SNAPSHOT_BYTES} bytes`,
  unreadable: "the Firstmate Pi snapshot could not be read on the owning machine",
};

/** A confined read of the artifact, as the contract's artifact fact. */
export function piArtifactFactFromRead(read: PiFileRead): PiArtifactFact {
  if (read.state === "absent") return { state: "absent" };
  // An artifact that cannot be established is refused: there is nothing to
  // show, and an unverifiable snapshot is never a zero.
  if (read.state === "refused" || read.state === "unknown") {
    return { state: "refused", reason: read.refusal, detail: REFUSAL_DETAIL[read.refusal] };
  }
  return piArtifactFactFromText(read.text);
}

/**
 * A confined read of the failure note, as the contract's sidecar fact.
 *
 * A note that exists and cannot be read stays a failure. Treating a refused
 * note as an absent one would turn a failed export into a fresh reading, and
 * would also make the producer's successful retry — which is what removes the
 * note — indistinguishable from a hazard.
 */
export function piSidecarFactFromRead(read: PiFileRead): PiSidecarFact {
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "unknown") return { state: "unknown", reason: read.refusal };
  if (read.state === "refused") return { state: "unreadable", reason: read.refusal };
  return piSidecarFactFromText(read.text);
}

export interface PiExportFacts {
  artifact: PiArtifactFact;
  sidecar: PiSidecarFact;
  /** Bytes actually read for the artifact, or `null` when there were none. */
  bytes: number | null;
}

/**
 * One confined read of the one approved location, as facts.
 *
 * This is the whole of what the owning machine contributes: no freshness
 * verdict, because the age of a snapshot is judged against the asking clock,
 * and no retained figures, because remembering the last good poll belongs to
 * the side that polls.
 */
export async function readPiExportFacts(options: PiReadOptions = {}): Promise<PiExportFacts> {
  let read: PiConfinedRead;
  try {
    read = await readPiExportFiles(options);
  } catch {
    // Nothing above throws by design; if the filesystem surprises us anyway,
    // the answer is a refusal with fixed wording, never an exception message
    // travelling to a caller and never an empty snapshot standing in for one.
    read = {
      snapshot: { state: "refused", refusal: "unreadable" },
      sidecar: { state: "absent" },
    };
  }
  return {
    artifact: piArtifactFactFromRead(read.snapshot),
    sidecar: piSidecarFactFromRead(read.sidecar),
    bytes: read.snapshot.state === "text" ? read.snapshot.bytes : null,
  };
}
