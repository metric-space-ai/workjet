// @effect-diagnostics nodeBuiltinImport:off -- Bounded install transport process boundary (ssh, local installer).
// @effect-diagnostics globalDate:off -- Step timestamps for the enrollment document, not scheduling.
/**
 * Rechner-Beitritt, Installationsweg (ctox sync v4, Architektur §16.41).
 *
 * Der Desktop ist hier NUR Transport für die Erstinstallation: Ziel auflösen
 * (~/.ssh/config via `ssh -G`, tailnet-Gerät → passender Host-Eintrag, lokal),
 * Installer-Paket hinkopieren und `ctox machine join --token <t>` starten. Aus
 * der Ausgabe entstehen die Schritte transport_connected, package_copied und
 * installed. Ab service_started meldet sich der Rechner selbst über seinen
 * CTOX-Peer; nach `green` läuft nichts mehr über SSH.
 *
 * Bewusst NICHT der alte Weg DesktopSshEnvironment.ensureEnvironment
 * (Workjet-Server per SSH); der fällt mit V4 Phase 11.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type MachineEnrollTransportKind = "local" | "ssh" | "tailscale";
export type MachineEnrollTransportStepKey = "transport_connected" | "package_copied" | "installed";

export interface MachineEnrollTransportStep {
  readonly key: MachineEnrollTransportStepKey;
  readonly state: "running" | "done" | "failed";
  readonly at_ms: number;
  readonly detail?: string;
  readonly error_code?: string;
}

export interface MachineEnrollCandidate {
  readonly id: string;
  readonly transport: MachineEnrollTransportKind;
  readonly name: string;
  /** null = unbekannt. Nie stillschweigend der lokale Benutzer (tailnet). */
  readonly user: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly sshAlias: string | null;
}

export interface SshResolved {
  readonly hostname: string;
  readonly user: string | null;
  readonly port: number | null;
  readonly identityFiles: ReadonlyArray<string>;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly stdin?: Uint8Array | string; readonly timeoutMs?: number },
) => Promise<RunResult>;

/** `ssh -G <host>` → Ziel. Erste Nennung gewinnt (wie ssh selbst). */
export function parseSshG(stdout: string): SshResolved {
  const values = new Map<string, string>();
  const identityFiles: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const [key, ...rest] = line.trim().split(/\s+/u);
    if (!key || rest.length === 0) continue;
    const value = rest.join(" ");
    const lower = key.toLowerCase();
    if (lower === "identityfile") identityFiles.push(value);
    else if (!values.has(lower)) values.set(lower, value);
  }
  const port = Number.parseInt(values.get("port") ?? "", 10);
  return {
    hostname: values.get("hostname") ?? "",
    user: values.get("user") ?? null,
    port: Number.isInteger(port) ? port : null,
    identityFiles,
  };
}

/** Alle `Host`-Einträge ohne Wildcards/Negation. */
export function isConcreteSshAlias(alias: string): boolean {
  return alias.length > 0 && !/[*?!]/u.test(alias);
}

export interface ResolveCandidatesInput {
  readonly localName: string;
  readonly localUser: string;
  readonly sshAliases: ReadonlyArray<string>;
  readonly tailscalePeers: ReadonlyArray<{
    readonly name: string;
    readonly hostname: string;
    readonly online: boolean;
  }>;
  readonly resolve: (host: string) => Promise<SshResolved | null>;
}

/**
 * Quellenliste: dieser Rechner, SSH-Hosts, tailnet-Geräte. Ein tailnet-Gerät,
 * auf das schon ein Host-Eintrag zeigt (gleiche HostName-Adresse oder gleicher
 * Name), erscheint einmal: als Tailscale-Eintrag mit Benutzer und Alias aus
 * diesem Host-Eintrag. Sonst Benutzer aus `ssh -G <adresse>`, außer es ist
 * nur der lokale Mac-Benutzer (Vorgabe von ssh) → null, die UI fragt nach.
 */
export async function resolveMachineCandidates(
  input: ResolveCandidatesInput,
): Promise<ReadonlyArray<MachineEnrollCandidate>> {
  const ssh: MachineEnrollCandidate[] = [];
  for (const alias of input.sshAliases.filter(isConcreteSshAlias)) {
    const resolved = await input.resolve(alias).catch(() => null);
    ssh.push({
      id: `ssh:${alias}`,
      transport: "ssh",
      name: alias,
      user: resolved?.user ?? null,
      host: resolved?.hostname || alias,
      port: resolved?.port ?? null,
      sshAlias: alias,
    });
  }
  const tailnet: MachineEnrollCandidate[] = [];
  const claimed = new Set<string>();
  for (const peer of input.tailscalePeers.filter((entry) => entry.online)) {
    const shortName = peer.name.split(".")[0] ?? peer.name;
    const match = ssh.find(
      (entry) =>
        entry.host === peer.hostname ||
        entry.host === peer.name ||
        entry.host === shortName ||
        entry.name === shortName,
    );
    if (match) {
      claimed.add(match.id);
      tailnet.push({
        ...match,
        id: `tailscale:${shortName}`,
        transport: "tailscale",
        name: shortName,
      });
      continue;
    }
    const resolved = await input.resolve(peer.hostname).catch(() => null);
    const user = resolved?.user && resolved.user !== input.localUser ? resolved.user : null;
    tailnet.push({
      id: `tailscale:${shortName}`,
      transport: "tailscale",
      name: shortName,
      user,
      host: peer.hostname,
      port: resolved?.port ?? null,
      sshAlias: null,
    });
  }
  return [
    {
      id: "local",
      transport: "local",
      name: input.localName,
      user: null,
      host: null,
      port: null,
      sshAlias: null,
    },
    ...ssh.filter((entry) => !claimed.has(entry.id)),
    ...tailnet,
  ];
}

/** Rohtext → maschinenlesbarer error_code (Vertrag §16.41). */
export function classifyTransportFailure(
  step: MachineEnrollTransportStepKey,
  stderr: string,
): string {
  if (/permission denied|authentication failed|too many authentication failures/iu.test(stderr))
    return "auth_rejected";
  if (/host key verification failed|remote host identification has changed/iu.test(stderr))
    return "host_key_changed";
  if (
    /could not resolve hostname|connection timed out|operation timed out|no route to host|connection refused|network is unreachable|connection closed by/iu.test(
      stderr,
    )
  )
    return "unreachable";
  if (/no space left on device|disk quota exceeded/iu.test(stderr)) return "disk_full";
  if (/token[_ ]expired|token.*(abgelaufen|expired)/iu.test(stderr)) return "token_expired";
  if (step === "transport_connected") return "unreachable";
  return step === "package_copied" ? "copy_failed" : "install_failed";
}

const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  // Neuer Rechner: Host-Schlüssel beim ersten Mal übernehmen; ein geänderter scheitert.
  "-o",
  "StrictHostKeyChecking=accept-new",
] as const;

/** ssh-Ziel: der Alias trägt Adresse, Port und Schlüssel; nur ein abweichender Benutzer kommt dazu. */
export function sshTargetArgs(candidate: MachineEnrollCandidate): string[] {
  const args: string[] = [...SSH_OPTIONS];
  if (candidate.sshAlias) {
    if (candidate.user) args.push("-l", candidate.user);
    args.push(candidate.sshAlias);
    return args;
  }
  if (!candidate.host || !candidate.user) throw new Error("user_missing");
  if (candidate.port && candidate.port !== 22) args.push("-p", String(candidate.port));
  args.push("-l", candidate.user, candidate.host);
  return args;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const REMOTE_DIR = ".ctox-enroll";

export interface MachineInstallInput {
  readonly candidate: MachineEnrollCandidate;
  readonly joinToken: string;
  /** Lokaler Pfad zum Installer-Paket (ausführbar), aus `installer_ref`. */
  readonly installerPath: string;
  readonly run?: RunCommand;
  /** Nur lokal: Arbeitsverzeichnis für die Kopie. */
  readonly localDir?: string;
  readonly now?: () => number;
}

/**
 * Fährt den Installationsweg und meldet je Schritt running → done | failed.
 * Gibt true bei Erfolg zurück; ein Fehler endet mit genau einem failed-Schritt.
 */
export async function runMachineInstall(
  input: MachineInstallInput,
  onStep: (step: MachineEnrollTransportStep) => void,
): Promise<boolean> {
  const run = input.run ?? runCommand;
  const now = input.now ?? (() => Date.now());
  const fail = (key: MachineEnrollTransportStepKey, errorCode: string, detail: string) => {
    onStep({ key, state: "failed", at_ms: now(), error_code: errorCode, detail: detail.trim() });
    return false;
  };
  const step = async (
    key: MachineEnrollTransportStepKey,
    action: () => Promise<RunResult>,
  ): Promise<boolean> => {
    onStep({ key, state: "running", at_ms: now() });
    let result: RunResult;
    try {
      result = await action();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return fail(
        key,
        message === "user_missing" ? "user_missing" : classifyTransportFailure(key, message),
        message,
      );
    }
    if (result.code !== 0)
      return fail(
        key,
        classifyTransportFailure(key, result.stderr),
        result.stderr || result.stdout,
      );
    onStep({ key, state: "done", at_ms: now() });
    return true;
  };

  const { candidate, joinToken } = input;
  const installerName = NodePath.basename(input.installerPath);
  if (candidate.transport === "local") {
    const dir = input.localDir ?? NodePath.join(NodePath.dirname(input.installerPath), REMOTE_DIR);
    const target = NodePath.join(dir, installerName);
    return (
      (await step("transport_connected", async () => ({ code: 0, stdout: "", stderr: "" }))) &&
      (await step("package_copied", async () => {
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.copyFile(input.installerPath, target);
        await NodeFSP.chmod(target, 0o755);
        return { code: 0, stdout: "", stderr: "" };
      })) &&
      (await step("installed", () =>
        run(target, ["machine", "join", "--token", joinToken], { timeoutMs: 10 * 60_000 }),
      ))
    );
  }

  const target = () => sshTargetArgs(candidate);
  const remotePath = `${REMOTE_DIR}/${installerName}`;
  return (
    (await step("transport_connected", () =>
      run("ssh", [...target(), "true"], { timeoutMs: 20_000 }),
    )) &&
    (await step("package_copied", async () =>
      run(
        "ssh",
        [
          ...target(),
          `mkdir -p ${REMOTE_DIR} && cat > ${shellQuote(remotePath)}.part && chmod 755 ${shellQuote(remotePath)}.part && mv ${shellQuote(remotePath)}.part ${shellQuote(remotePath)}`,
        ],
        { stdin: await NodeFSP.readFile(input.installerPath), timeoutMs: 5 * 60_000 },
      ),
    )) &&
    (await step("installed", () =>
      run("ssh", [...target(), `./${remotePath} machine join --token ${shellQuote(joinToken)}`], {
        timeoutMs: 10 * 60_000,
      }),
    ))
  );
}

/** Begrenzter Kindprozess ohne Shell; stdin optional. */
export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(() => {
          stderr += "\nConnection timed out";
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? undefined);
  });

/** `ssh -G <host>` über den echten ssh-Client. */
export async function resolveSshHost(host: string, run: RunCommand = runCommand) {
  const result = await run("ssh", ["-G", host], { timeoutMs: 5_000 });
  return result.code === 0 ? parseSshG(result.stdout) : null;
}
