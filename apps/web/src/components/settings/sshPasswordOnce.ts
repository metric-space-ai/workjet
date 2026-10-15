/**
 * Einmal-Passwort für „Rechner hinzufügen“ (Owner 15.10.: manuell IP,
 * Benutzer, Passwort).
 *
 * Der Desktop fragt Passwörter über SSH_ASKPASS beim Renderer an
 * (`onSshPasswordPrompt` → `resolveSshPasswordPrompt`); das Passwort geht
 * nur an den lokalen ssh-Prozess, nie in argv oder Umgebung. Während ein
 * Beitritt läuft, beantwortet dieser Anspruch die Anfragen für genau dieses
 * Ziel, statt die allgemeine Passwortzeile zu zeigen. Mit `release()` ist das
 * Passwort aus dem Speicher; es wird nirgends gespeichert oder geloggt.
 */

export interface SshPasswordClaimTarget {
  /** Adresse und Alias, unter denen ssh das Ziel nennt. */
  readonly hosts: ReadonlyArray<string>;
  readonly user: string | null;
}

interface Claim {
  readonly target: SshPasswordClaimTarget;
  password: string | null;
  answered: number;
}

/** ssh fragt je Verbindung höchstens dreimal; mehr deutet auf eine Schleife. */
const MAX_ANSWERS = 12;
const claims = new Set<Claim>();

function matches(claim: Claim, request: { destination: string; username: string | null }): boolean {
  const destination = request.destination.toLowerCase();
  const host = destination.includes("@")
    ? destination.slice(destination.indexOf("@") + 1)
    : destination;
  const bareHost = host.replace(/:\d+$/u, "");
  const hostMatches = claim.target.hosts.some((entry) => entry.toLowerCase() === bareHost);
  const user = request.username ?? (destination.includes("@") ? destination.split("@")[0] : null);
  return hostMatches && (claim.target.user === null || user === null || user === claim.target.user);
}

export function claimSshPassword(target: SshPasswordClaimTarget, password: string): () => void {
  const claim: Claim = { target, password, answered: 0 };
  claims.add(claim);
  return () => {
    claim.password = null;
    claims.delete(claim);
  };
}

/**
 * Liefert das Passwort für eine Desktop-Anfrage, wenn ein laufender Beitritt
 * sie beansprucht; sonst undefined (dann zeigt die allgemeine Passwortzeile).
 */
export function claimedSshPassword(request: {
  readonly destination: string;
  readonly username: string | null;
}): string | null | undefined {
  for (const claim of claims) {
    if (!matches(claim, request)) continue;
    if (claim.password === null || claim.answered >= MAX_ANSWERS) return null;
    claim.answered += 1;
    return claim.password;
  }
  return undefined;
}

/** Nur für Tests: ob noch ein Anspruch (und damit ein Passwort) lebt. */
export function activeSshPasswordClaims(): number {
  return claims.size;
}
