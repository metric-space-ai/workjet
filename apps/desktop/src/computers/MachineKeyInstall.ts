// @effect-diagnostics nodeBuiltinImport:off -- Reads/creates the desktop's own SSH key in ~/.ssh (ssh-keygen boundary).
/**
 * „Rechner hinzufügen“ mit Passwort (Owner 15.10.): das Passwort dient genau
 * einmal dazu, den eigenen SSH-Schlüssel des Desktops in
 * `~/.ssh/authorized_keys` des Zielrechners einzutragen (wie ssh-copy-id,
 * idempotent). Danach läuft alles über den Schlüssel.
 *
 * Das Passwort berührt dieses Modul nie: ssh fragt es über SSH_ASKPASS beim
 * Renderer an (DesktopSshPasswordPrompts), nicht über argv oder Umgebung.
 * Der öffentliche Schlüssel geht über stdin, nicht in die Kommandozeile.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Remote-Skript (POSIX sh): Schlüssel von stdin lesen, ~/.ssh anlegen, Rechte
 * setzen, Zeile nur anhängen, wenn sie fehlt.
 */
export const AUTHORIZED_KEY_SCRIPT = [
  "umask 077",
  'key="$(cat)"',
  '[ -n "$key" ] || exit 64',
  'mkdir -p "$HOME/.ssh"',
  'touch "$HOME/.ssh/authorized_keys"',
  'chmod 700 "$HOME/.ssh"',
  'chmod 600 "$HOME/.ssh/authorized_keys"',
  'grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf "%s\\n" "$key" >> "$HOME/.ssh/authorized_keys"',
].join("; ");

/** Bevorzugte Standard-Schlüssel: ssh benutzt sie ohne Host-Eintrag von selbst. */
const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"] as const;

export async function findDesktopPublicKey(homeDir: string): Promise<string | null> {
  for (const name of DEFAULT_KEYS) {
    const path = NodePath.join(homeDir, ".ssh", `${name}.pub`);
    try {
      const value = (await NodeFSP.readFile(path, "utf8")).trim();
      if (/^(ssh-|ecdsa-)\S+ \S+/u.test(value)) return value;
    } catch {
      /* Nächsten Standard-Schlüssel versuchen. */
    }
  }
  return null;
}

/**
 * Öffentlicher Schlüssel des Desktops; fehlt jeder Standard-Schlüssel, wird
 * `~/.ssh/id_ed25519` ohne Passphrase erzeugt (wie es ssh-copy-id voraussetzt).
 */
export async function ensureDesktopPublicKey(homeDir: string = NodeOS.homedir()): Promise<string> {
  const existing = await findDesktopPublicKey(homeDir);
  if (existing) return existing;
  const sshDir = NodePath.join(homeDir, ".ssh");
  await NodeFSP.mkdir(sshDir, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "workjet", "-f", NodePath.join(sshDir, "id_ed25519")],
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const created = await findDesktopPublicKey(homeDir);
  if (!created) throw new Error("SSH-Schlüssel nicht erzeugt.");
  return created;
}
