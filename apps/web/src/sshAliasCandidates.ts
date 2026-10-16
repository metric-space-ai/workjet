import type { DesktopDiscoveredSshHost } from "@workjet/contracts";

/** Git hosting: SSH gives no shell there. */
const GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "ssh.dev.azure.com"] as const;

function isGitHost(name: string): boolean {
  const value = name.trim().toLowerCase();
  return GIT_HOSTS.some((host) => value === host || value.endsWith(`.${host}`));
}

/** CTOX-Fleet-Infrastruktur (ctox-fleet-*) ist kein Arbeitsrechner. */
function isFleetHost(alias: string): boolean {
  return /^ctox-fleet(?:-|$)/i.test(alias.trim());
}

/**
 * Vorschläge für „Rechner hinzufügen › SSH“: nur ~/.ssh/config-Einträge mit
 * Shell, ohne Git-Hosts, Fleet-Hosts und bereits eingerichtete Rechner
 * (Alias, Ziel oder Adresse). Bekannte Rechner (in known_hosts) zuerst,
 * sonst alphabetisch.
 */
export function sshAliasCandidates(
  discovered: readonly DesktopDiscoveredSshHost[],
  saved: {
    readonly keys: ReadonlySet<string>;
    readonly hostnames: ReadonlySet<string>;
  },
  formatTarget: (target: DesktopDiscoveredSshHost) => string,
): DesktopDiscoveredSshHost[] {
  const known = new Set(
    discovered
      .filter((target) => target.source === "known-hosts")
      .map((target) => target.hostname.toLowerCase()),
  );
  const isKnown = (target: DesktopDiscoveredSshHost) =>
    known.has(target.hostname.toLowerCase()) || known.has(target.alias.toLowerCase());
  return discovered
    .filter(
      (target) =>
        target.source === "ssh-config" &&
        !isGitHost(target.alias) &&
        !isGitHost(target.hostname) &&
        !isFleetHost(target.alias) &&
        !saved.keys.has(target.alias) &&
        !saved.keys.has(formatTarget(target)) &&
        !saved.hostnames.has(target.hostname.toLowerCase()),
    )
    .toSorted(
      (left, right) =>
        Number(isKnown(right)) - Number(isKnown(left)) || left.alias.localeCompare(right.alias),
    );
}
