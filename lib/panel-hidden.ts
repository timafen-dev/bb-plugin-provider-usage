/**
 * Which machines and provider rows the panel leaves out.
 *
 * A row that says "Not signed in" on a machine that will never sign in is not
 * news, it is noise, and it pushes the rows that matter off the screen. The
 * same goes for a machine that exists only to run bb itself: its limits are a
 * duplicate of another machine's, because several bb registrations can share
 * one physical computer.
 *
 * This is configuration rather than a rule in code: which machine is a service
 * machine, and which agent a machine is supposed to have, is knowledge about
 * the setup, not about usage. One rule per line:
 *
 *     Служебная машина                  — the machine is not shown at all
 *     codex-api: claude-code, cursor    — those providers are not shown on it
 *     *: muse                           — that provider is not shown anywhere
 *
 * A machine is named by its display name or by its id, so a rule survives a
 * rename if it was written with the id, and stays readable if it was not.
 * Provider names are the ids the panel uses: `codex`, `claude-code`, `cursor`,
 * `muse`. Matching ignores case and surrounding spaces.
 */

export interface PanelHidden {
  /** Machines left out entirely, by lowercased name or id. */
  machines: Set<string>;
  /** Providers left out, keyed by lowercased machine name or id; `*` is every machine. */
  providers: Map<string, Set<string>>;
}

const EVERY_MACHINE = "*";

function key(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePanelHidden(text: string): PanelHidden {
  const machines = new Set<string>();
  const providers = new Map<string, Set<string>>();
  for (const raw of text.split("\n")) {
    const line = raw.split("#", 1)[0]!.trim();
    if (line.length === 0) continue;
    // The separator is the LAST colon: a machine name may contain one.
    const cut = line.lastIndexOf(":");
    if (cut === -1) {
      machines.add(key(line));
      continue;
    }
    const machine = key(line.slice(0, cut));
    const named = line
      .slice(cut + 1)
      .split(",")
      .map(key)
      .filter((name) => name.length > 0);
    if (machine.length === 0 || named.length === 0) continue;
    const current = providers.get(machine) ?? new Set<string>();
    for (const name of named) current.add(name);
    providers.set(machine, current);
  }
  return { machines, providers };
}

/** Both handles of a machine: a rule may name either. */
function handles(host: { id: string; name: string }): string[] {
  return [key(host.id), key(host.name)];
}

export function isMachineHidden(
  hidden: PanelHidden,
  host: { id: string; name: string },
): boolean {
  return handles(host).some((handle) => hidden.machines.has(handle));
}

export function hiddenProvidersFor(
  hidden: PanelHidden,
  host: { id: string; name: string } | null,
): Set<string> {
  const names = new Set(hidden.providers.get(EVERY_MACHINE) ?? []);
  if (host) {
    for (const handle of handles(host)) {
      for (const name of hidden.providers.get(handle) ?? []) names.add(name);
    }
  }
  return names;
}
