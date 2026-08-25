// @effect-diagnostics nodeBuiltinImport:off -- Electron main owns this explicit OS process/filesystem boundary.
// @effect-diagnostics globalTimers:off -- the child-process timeout is local cancellation glue outside the Effect scheduler.
// @effect-diagnostics globalDate:off globalDateInEffect:off -- timestamps are renderer-safe snapshots, not scheduling decisions.
// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectFailure:off -- heterogeneous OS/SSH failures are sanitized at this boundary.
// @effect-diagnostics preferSchemaOverJson:off tryCatchInEffectGen:off -- only bounded installer NDJSON events are parsed and normalized.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  DesktopSshEnvironmentTarget,
  WorkjetProvisioningEvent,
  WorkjetProvisioningGetResult,
  WorkjetProvisioningPreflight,
  WorkjetProvisioningPreflightInput,
  WorkjetProvisioningPreflightResult,
  WorkjetProvisioningSnapshot,
  WorkjetProvisioningStartInput,
  WorkjetProvisioningStartResult,
  WorkjetProvisioningTarget,
  WorkjetSshHostKeyInspectResult,
} from "@t3tools/contracts";
import { isSshAuthFailure } from "@t3tools/ssh/auth";
import { runSshCommand, targetConnectionKey } from "@t3tools/ssh/command";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as CtoxInstanceRegistry from "../ctox/CtoxInstanceRegistry.ts";

const PREFLIGHT_TTL_MS = 10 * 60 * 1_000;
const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CTOX_MANIFEST_URL =
  "https://github.com/metric-space-ai/ctox/releases/latest/download/ctox-install-manifest-v1.json";
const WORKJET_MANIFEST_URL =
  "https://github.com/metric-space-ai/workjet/releases/latest/download/workjet-desktop-install-manifest-v1.json";

interface HostKeyRecord {
  readonly targetKey: string;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly knownHostsLine: string;
  readonly expiresAtMs: number;
}

interface PreflightRecord {
  readonly public: WorkjetProvisioningPreflight;
  readonly knownHostsLine: string | null;
  readonly createdAtMs: number;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface MutableOperation {
  snapshot: WorkjetProvisioningSnapshot;
  updatedAtMs: number;
}

function runLocalCommand(
  command: string,
  args: readonly string[],
  input?: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function normalizePlatform(value: string): "macos" | "linux" | "windows" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "darwin" || normalized === "macos") return "macos";
  if (normalized === "linux") return "linux";
  if (normalized === "win32" || normalized === "windows") return "windows";
  return null;
}

function normalizeArchitecture(value: string): "arm64" | "x64" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  if (normalized === "x64" || normalized === "x86_64" || normalized === "amd64") return "x64";
  return null;
}

function parseKeyValueOutput(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return result;
}

function booleanValue(values: Map<string, string>, key: string): boolean {
  return values.get(key) === "true";
}

function versionValue(values: Map<string, string>, key: string): string | null {
  const value = values.get(key)?.trim() ?? "";
  return value === "" || value === "none" ? null : value.slice(0, 2_048);
}

function administratorCapability(
  values: Map<string, string>,
  platform: "macos" | "linux" | "windows",
  localTarget: boolean,
): { readonly capable: boolean; readonly elevationRequired: boolean } {
  if (booleanValue(values, "admin")) return { capable: true, elevationRequired: false };
  if (platform === "windows" && localTarget && booleanValue(values, "admin_member"))
    return { capable: true, elevationRequired: true };
  return { capable: false, elevationRequired: false };
}

const LINUX_DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=Workjet
Comment=Workjet Coding and Business OS
Exec=/opt/workjet/Workjet.AppImage %U
TryExec=/opt/workjet/Workjet.AppImage
Icon=applications-development
Terminal=false
Categories=Development;Utility;
StartupWMClass=t3code
MimeType=x-scheme-handler/workjet;x-scheme-handler/workjet-dev;x-scheme-handler/workjet-preview;
`;

const LINUX_DESKTOP_REGISTRATION_SCRIPT = `if [ "$(uname -s)" = Linux ]; then
  cat > "$tmp/workjet.desktop" <<'WORKJET_DESKTOP_ENTRY'
${LINUX_DESKTOP_ENTRY}WORKJET_DESKTOP_ENTRY
  run_admin mkdir -p /usr/local/share/applications
  run_admin install -m 0644 "$tmp/workjet.desktop" /usr/local/share/applications/workjet.desktop
fi`;

const POSIX_PREFLIGHT_SCRIPT = `set -eu
platform="$(uname -s 2>/dev/null || true)"
arch="$(uname -m 2>/dev/null || true)"
tools=true
missing_tools=""
for tool in curl python3 bash mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then tools=false; missing_tools="\${missing_tools}\${missing_tools:+, }\${tool}"; fi
done
if [ "$platform" = Linux ] && ! command -v install >/dev/null 2>&1; then tools=false; missing_tools="\${missing_tools}\${missing_tools:+, }install"; fi
internet=false
if command -v curl >/dev/null 2>&1 && curl -fsSI --max-time 8 '${CTOX_MANIFEST_URL}' >/dev/null 2>&1; then internet=true; fi
admin=false
admin_password=false
if [ "$(id -u)" = "0" ]; then admin=true
elif command -v sudo >/dev/null 2>&1; then
  if sudo -n true >/dev/null 2>&1; then admin=true
  elif id -Gn 2>/dev/null | tr ' ' '\n' | grep -Eq '^(sudo|wheel|admin)$'; then admin=true; admin_password=true
  fi
fi
gui=false
case "$platform" in
  Darwin) if who 2>/dev/null | grep -q 'console'; then gui=true; fi ;;
  Linux) if [ -n "\${DISPLAY:-}\${WAYLAND_DISPLAY:-}" ] || pgrep -f 'Xorg|Xwayland|wayland|gnome-shell|plasmashell' >/dev/null 2>&1; then gui=true; fi ;;
esac
ctox_version=none
if command -v ctox >/dev/null 2>&1; then ctox_version="$(ctox --version 2>/dev/null | head -n 1 || true)"; fi
workjet_version=none
if [ -f /Applications/Workjet.app/Contents/Info.plist ]; then
  workjet_version="$(defaults read /Applications/Workjet.app/Contents/Info CFBundleShortVersionString 2>/dev/null || true)"
elif command -v workjet >/dev/null 2>&1; then workjet_version="$(workjet --version 2>/dev/null | head -n 1 || true)"; fi
printf 'platform=%s\narch=%s\ntools=%s\nmissing_tools=%s\ninternet=%s\nadmin=%s\nadmin_member=%s\nadmin_password=%s\ngui=%s\nctox_version=%s\nworkjet_version=%s\n' "$platform" "$arch" "$tools" "$missing_tools" "$internet" "$admin" "$admin" "$admin_password" "$gui" "$ctox_version" "$workjet_version"
`;

const WINDOWS_PREFLIGHT_SCRIPT = `$ErrorActionPreference='Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$isAdminMember = $isAdmin
if (-not $isAdminMember) { try { $isAdminMember = ((& (Join-Path $env:SystemRoot 'System32\\whoami.exe') /groups /fo csv /nh | Out-String) -match 'S-1-5-32-544') } catch {} }
$internet = $false
try { Invoke-WebRequest -UseBasicParsing -Method Head -TimeoutSec 8 -Uri '${CTOX_MANIFEST_URL}' | Out-Null; $internet = $true } catch {}
$ctox = 'none'; $ctoxPath = Join-Path $env:ProgramFiles 'CTOX\\current\\bin\\ctox.exe'; if (Test-Path $ctoxPath) { try { $ctox = (& $ctoxPath --version | Select-Object -First 1) } catch {} }
$workjet = 'none'; $workjetPath = Join-Path $env:ProgramFiles 'Workjet\\Workjet.exe'; if (Test-Path $workjetPath) { $workjet = (Get-Item $workjetPath).VersionInfo.ProductVersion }
$gui = @(Get-Process explorer -ErrorAction SilentlyContinue).Count -gt 0
Write-Output 'platform=windows'; Write-Output ('arch=' + [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()); Write-Output 'tools=true'; Write-Output 'missing_tools='; Write-Output ('internet=' + $internet.ToString().ToLowerInvariant()); Write-Output ('admin=' + $isAdmin.ToString().ToLowerInvariant()); Write-Output ('admin_member=' + $isAdminMember.ToString().ToLowerInvariant()); Write-Output 'admin_password=false'; Write-Output ('gui=' + $gui.ToString().ToLowerInvariant()); Write-Output ('ctox_version=' + $ctox); Write-Output ('workjet_version=' + $workjet)
`;

function remoteTargetKey(target: WorkjetProvisioningTarget): string {
  return target._tag === "local" ? "local" : targetConnectionKey(target.ssh);
}

function safeMessage(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : fallback;
  return value.replace(/[\r\n\t]+/gu, " ").slice(0, 2_048) || fallback;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function runLocalElevatedPowerShell(script: string, timeoutMs: number): Promise<CommandResult> {
  const encodedScript = Buffer.from(
    `$ErrorActionPreference='Stop'\ntry {\n${script}\n} catch { exit 1 }`,
    "utf16le",
  ).toString("base64");
  const launcher = `$ErrorActionPreference='Stop'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedScript}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw ('Elevated provisioning process failed with exit code ' + $process.ExitCode) }
`;
  return runLocalCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "-"],
    launcher,
    timeoutMs,
  ).then(() => ({
    stdout:
      '{"phase":"complete","status":"completed","percent":100,"message":"Requested components are ready"}\n',
    stderr: "",
  }));
}

function initialSnapshot(
  input: WorkjetProvisioningStartInput,
  operationId: string,
): WorkjetProvisioningSnapshot {
  const timestamp = new Date().toISOString();
  return {
    operationId,
    state: "queued",
    action: input.action,
    components: [...new Set(input.components)],
    events: [
      {
        sequence: 0,
        phase: "queued",
        status: "pending",
        percent: 0,
        message: "Operation queued",
        timestamp,
      },
    ],
    installedVersion: null,
    serviceState: "unknown",
    backendHealthy: false,
    activeConnection: false,
    errorCode: null,
  };
}

export class DesktopComputerProvisioner extends Context.Service<
  DesktopComputerProvisioner,
  {
    readonly inspectHostKey: (
      target: WorkjetProvisioningTarget,
    ) => Effect.Effect<WorkjetSshHostKeyInspectResult>;
    readonly preflight: (
      input: WorkjetProvisioningPreflightInput,
    ) => Effect.Effect<WorkjetProvisioningPreflightResult>;
    readonly start: (
      input: WorkjetProvisioningStartInput,
    ) => Effect.Effect<WorkjetProvisioningStartResult>;
    readonly get: (operationId: string) => Effect.Effect<WorkjetProvisioningGetResult>;
  }
>()("@t3tools/desktop/provisioning/DesktopComputerProvisioner") {}

export const make = Effect.gen(function* () {
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
  const hostProcessPlatform = yield* HostProcessPlatform;
  const runtimeContext = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const hostKeys = new Map<string, HostKeyRecord>();
  const preflights = new Map<string, PreflightRecord>();
  const operations = new Map<string, MutableOperation>();

  const scanHostKey = (target: DesktopSshEnvironmentTarget) =>
    Effect.tryPromise(async () => {
      const port = target.port ?? 22;
      const scan = await runLocalCommand(
        "ssh-keyscan",
        ["-T", "10", "-p", String(port), target.hostname],
        undefined,
        15_000,
      );
      const knownHostsLine = scan.stdout
        .split(/\r?\n/u)
        .find((line) => line.trim() !== "" && !line.startsWith("#"));
      if (!knownHostsLine) throw new Error("The target did not publish an SSH host key.");
      const fields = knownHostsLine.trim().split(/\s+/u);
      if (fields.length < 3) throw new Error("The SSH host key response was invalid.");
      const fingerprintOutput = await runLocalCommand(
        "ssh-keygen",
        ["-lf", "-", "-E", "sha256"],
        `${knownHostsLine}\n`,
      );
      const fingerprint = fingerprintOutput.stdout.trim().split(/\s+/u)[1];
      if (!fingerprint?.startsWith("SHA256:"))
        throw new Error("The SSH fingerprint could not be calculated.");
      return {
        targetKey: targetConnectionKey(target),
        algorithm: fields[1]!,
        fingerprint,
        knownHostsLine,
        expiresAtMs: Date.now() + PREFLIGHT_TTL_MS,
      } satisfies HostKeyRecord;
    });

  const inspectHostKey = (target: WorkjetProvisioningTarget) =>
    target._tag === "local"
      ? Effect.succeed<WorkjetSshHostKeyInspectResult>({ _tag: "not_required" })
      : scanHostKey(target.ssh).pipe(
          Effect.tap((record) => Effect.sync(() => hostKeys.set(record.targetKey, record))),
          Effect.map(
            (record): WorkjetSshHostKeyInspectResult => ({
              _tag: "ready",
              algorithm: record.algorithm,
              fingerprint: record.fingerprint,
            }),
          ),
          Effect.catch((error) =>
            Effect.succeed<WorkjetSshHostKeyInspectResult>({
              _tag: "failed",
              code: "host_key_unavailable",
              message: safeMessage(error, "SSH host key unavailable"),
            }),
          ),
        );

  const withKnownHostFile = <A>(
    knownHostsLine: string,
    use: (path: string) => Effect.Effect<A, unknown>,
  ) =>
    Effect.acquireUseRelease(
      Effect.tryPromise(async () => {
        const directory = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "workjet-known-host-"),
        );
        const path = NodePath.join(directory, "known_hosts");
        await NodeFSP.writeFile(path, `${knownHostsLine}\n`, { encoding: "utf8", mode: 0o600 });
        return { directory, path };
      }),
      ({ path }) => use(path),
      ({ directory }) =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );

  const runRemoteAuthenticated = <A>(
    target: DesktopSshEnvironmentTarget,
    knownHostsLine: string,
    operation: (knownHostsPath: string, authSecret: string | null) => Effect.Effect<A, unknown>,
  ) =>
    withKnownHostFile(knownHostsLine, (knownHostsPath) =>
      operation(knownHostsPath, null).pipe(
        Effect.catch((error) => {
          if (!isSshAuthFailure(error)) return Effect.fail(error);
          return prompts
            .request({
              attempt: 1,
              destination: target.alias.trim() || target.hostname.trim(),
              username: target.username,
              prompt: `Enter the SSH password for ${target.username ? `${target.username}@` : ""}${target.hostname}.`,
            })
            .pipe(Effect.flatMap((password) => operation(knownHostsPath, password)));
        }),
      ),
    );

  const sshCommand = (
    target: DesktopSshEnvironmentTarget,
    knownHostsPath: string,
    authSecret: string | null,
    remoteCommandArgs: readonly string[],
    stdin?: string,
    timeoutMs = 30_000,
  ) =>
    runSshCommand(target, {
      preHostArgs: [
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "-o",
        "StrictHostKeyChecking=yes",
      ],
      remoteCommandArgs,
      ...(stdin === undefined ? {} : { stdin }),
      ...(authSecret === null
        ? { batchMode: "yes" as const }
        : { batchMode: "no" as const, interactiveAuth: true, authSecret }),
      timeoutMs,
    }).pipe(Effect.provide(runtimeContext));

  const inspectRemote = (target: DesktopSshEnvironmentTarget, knownHostsLine: string) =>
    runRemoteAuthenticated(target, knownHostsLine, (knownHostsPath, authSecret) =>
      sshCommand(target, knownHostsPath, authSecret, ["sh", "-s"], POSIX_PREFLIGHT_SCRIPT).pipe(
        Effect.catch(() =>
          sshCommand(
            target,
            knownHostsPath,
            authSecret,
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", "-"],
            WINDOWS_PREFLIGHT_SCRIPT,
          ),
        ),
      ),
    );

  const inspectLocal = () => {
    const platform = normalizePlatform(hostProcessPlatform);
    const script = platform === "windows" ? WINDOWS_PREFLIGHT_SCRIPT : POSIX_PREFLIGHT_SCRIPT;
    return Effect.tryPromise(() =>
      platform === "windows"
        ? runLocalCommand(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "-"],
            script,
          )
        : runLocalCommand("sh", ["-s"], script),
    );
  };

  const preflight = (input: WorkjetProvisioningPreflightInput) =>
    Effect.gen(function* () {
      let knownHostsLine: string | null = null;
      let command: CommandResult;
      if (input.target._tag === "ssh") {
        const key = remoteTargetKey(input.target);
        const cached = hostKeys.get(key);
        if (!cached || cached.expiresAtMs <= Date.now() || !input.confirmedHostKeyFingerprint) {
          return {
            _tag: "failed",
            code: "host_key_confirmation_required",
            message: "Confirm the current SSH host-key fingerprint before connecting.",
          } satisfies WorkjetProvisioningPreflightResult;
        }
        const current = yield* scanHostKey(input.target.ssh).pipe(Effect.option);
        if (
          current._tag === "None" ||
          current.value.fingerprint !== cached.fingerprint ||
          input.confirmedHostKeyFingerprint !== cached.fingerprint
        ) {
          return {
            _tag: "failed",
            code: "host_key_changed",
            message: "The SSH host key changed or does not match the confirmed fingerprint.",
          } satisfies WorkjetProvisioningPreflightResult;
        }
        knownHostsLine = current.value.knownHostsLine;
        command = yield* inspectRemote(input.target.ssh, knownHostsLine);
      } else {
        command = yield* inspectLocal();
      }
      const values = parseKeyValueOutput(command.stdout);
      const platform = normalizePlatform(values.get("platform") ?? "");
      if (platform === null)
        return {
          _tag: "failed",
          code: "unsupported_platform",
          message: "The target operating system is not supported.",
        } satisfies WorkjetProvisioningPreflightResult;
      const architecture = normalizeArchitecture(values.get("arch") ?? "");
      if (architecture === null || (platform === "windows" && architecture !== "x64"))
        return {
          _tag: "failed",
          code: "unsupported_architecture",
          message: "The target architecture is not supported.",
        } satisfies WorkjetProvisioningPreflightResult;
      if (!booleanValue(values, "tools"))
        return {
          _tag: "failed",
          code: "required_tool_unavailable",
          message: `The target is missing required provisioning tools: ${values.get("missing_tools") || "unknown"}.`,
        } satisfies WorkjetProvisioningPreflightResult;
      if (!booleanValue(values, "internet"))
        return {
          _tag: "failed",
          code: "internet_unavailable",
          message: "The target cannot reach the official CTOX release channel.",
        } satisfies WorkjetProvisioningPreflightResult;
      const administrator = administratorCapability(
        values,
        platform,
        input.target._tag === "local",
      );
      if (!administrator.capable)
        return {
          _tag: "failed",
          code: "administrator_unavailable",
          message:
            platform === "windows" && input.target._tag === "ssh"
              ? "A Windows SSH session that is already elevated as an administrator is required."
              : "An administrator-capable target account is required.",
        } satisfies WorkjetProvisioningPreflightResult;
      const warnings: string[] = [];
      const graphicalSession = booleanValue(values, "gui");
      if (administrator.elevationRequired)
        warnings.push(
          "Windows will show a User Account Control confirmation when installation starts.",
        );
      if (!graphicalSession)
        warnings.push(
          "No active graphical session was detected; only the CTOX backend can be installed.",
        );
      const preflightId = NodeCrypto.randomUUID();
      const publicValue: WorkjetProvisioningPreflight = {
        preflightId,
        expiresAt: new Date(Date.now() + PREFLIGHT_TTL_MS).toISOString(),
        target: input.target,
        platform,
        architecture,
        internetAvailable: true,
        administratorCapable: true,
        administratorPasswordRequired: booleanValue(values, "admin_password"),
        administratorElevationRequired: administrator.elevationRequired,
        graphicalSession,
        ctoxInstalledVersion: versionValue(values, "ctox_version"),
        workjetInstalledVersion: versionValue(values, "workjet_version"),
        warnings,
      };
      preflights.set(preflightId, { public: publicValue, knownHostsLine, createdAtMs: Date.now() });
      return { _tag: "ready", preflight: publicValue } satisfies WorkjetProvisioningPreflightResult;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<WorkjetProvisioningPreflightResult>({
          _tag: "failed",
          code: isSshAuthFailure(error) ? "authentication_failed" : "preflight_failed",
          message: safeMessage(error, "Target preflight failed"),
        }),
      ),
    );

  const appendEvent = (
    entry: MutableOperation,
    event: Omit<WorkjetProvisioningEvent, "sequence" | "timestamp">,
  ) => {
    entry.snapshot = {
      ...entry.snapshot,
      events: [
        ...entry.snapshot.events,
        { ...event, sequence: entry.snapshot.events.length, timestamp: new Date().toISOString() },
      ],
    };
    entry.updatedAtMs = Date.now();
  };

  const runOperation = (entry: MutableOperation, record: PreflightRecord) =>
    Effect.gen(function* () {
      entry.snapshot = { ...entry.snapshot, state: "running" };
      appendEvent(entry, {
        phase: "preflight",
        status: "completed",
        percent: 5,
        message: "Verified the approved target and release channel",
      });
      const components = entry.snapshot.components;
      if (components.includes("workjet") && !record.public.graphicalSession) {
        return yield* Effect.fail(
          new Error("Workjet cannot be installed without an active graphical session."),
        );
      }
      const action = entry.snapshot.action;
      if (
        components.includes("workjet") &&
        !["install", "repair", "update", "status"].includes(action)
      ) {
        return yield* Effect.fail(
          new Error(`Workjet does not support the ${action} lifecycle action.`),
        );
      }
      let administratorPassword: string | null = null;
      if (record.public.administratorPasswordRequired) {
        administratorPassword = yield* prompts.request({
          attempt: 1,
          destination:
            record.public.target._tag === "local"
              ? "this computer"
              : record.public.target.ssh.hostname,
          username:
            record.public.target._tag === "local"
              ? (process.env.USER ?? null)
              : record.public.target.ssh.username,
          prompt: "Enter the administrator password for this one provisioning operation.",
        });
      }
      const adminPrefix =
        administratorPassword === null
          ? `run_admin() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }`
          : `CTOX_SUDO_PASSWORD=${shellSingleQuote(administratorPassword)}; export CTOX_SUDO_PASSWORD\nrun_admin() { if [ "$(id -u)" = 0 ]; then "$@"; else printf '%s\\n' "$CTOX_SUDO_PASSWORD" | sudo -S -p '' "$@"; fi; }`;
      const ctoxPosix =
        action === "install" || action === "repair"
          ? `printf '{"phase":"download","status":"started","percent":15,"message":"Downloading verified CTOX bootstrap"}\\n'\ncurl -fsSL '${CTOX_MANIFEST_URL}' -o "$tmp/ctox-manifest.json"\npython3 - "$tmp/ctox-manifest.json" "$tmp/install.sh" <<'PY'\nimport hashlib,json,sys,urllib.request\nm=json.load(open(sys.argv[1],encoding='utf-8')); b=m['bootstrap']['unix']\nif m.get('schema')!='ctox.install-manifest.v1' or m.get('repository')!='metric-space-ai/ctox' or not b['url'].startswith('https://github.com/'): raise SystemExit('invalid CTOX manifest')\ndata=urllib.request.urlopen(b['url'],timeout=30).read()\nif hashlib.sha256(data).hexdigest()!=b['sha256'].lower(): raise SystemExit('CTOX bootstrap checksum mismatch')\nopen(sys.argv[2],'wb').write(data)\nPY\nprintf '{"phase":"verification","status":"completed","percent":30,"message":"CTOX bootstrap checksum verified"}\\n'\nCTOX_SKIP_DESKTOP_HOST_BUILD=1 bash "$tmp/install.sh"\nprintf '{"phase":"health","status":"running","percent":78,"message":"Checking CTOX service"}\\n'\n"$HOME/.local/bin/ctox" status >/dev/null`
          : `ctox_bin="$(command -v ctox || printf '%s' "$HOME/.local/bin/ctox")"\ncase '${action}' in status) "$ctox_bin" status ;; start) "$ctox_bin" start ;; stop) "$ctox_bin" stop ;; restart) "$ctox_bin" stop; "$ctox_bin" start ;; update) "$ctox_bin" update apply --latest ;; rollback) "$ctox_bin" update rollback ;; *) exit 64 ;; esac`;
      const workjetPosix =
        action === "status"
          ? `if [ "$(uname -s)" = Darwin ]; then test -d /Applications/Workjet.app; else test -x /opt/workjet/Workjet.AppImage; fi`
          : `printf '{"phase":"download","status":"started","percent":80,"message":"Downloading signed Workjet package"}\\n'\ncurl -fsSL '${WORKJET_MANIFEST_URL}' -o "$tmp/workjet-manifest.json"\npython3 - "$tmp/workjet-manifest.json" "$tmp/workjet-artifact" <<'PY'\nimport hashlib,json,platform,sys,urllib.request\nm=json.load(open(sys.argv[1],encoding='utf-8')); p='macos' if platform.system()=='Darwin' else 'linux'; a={'x86_64':'x64','amd64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine().lower())\nxs=[x for x in m.get('artifacts',[]) if x.get('platform')==p and x.get('arch')==a]\nif m.get('schema')!='workjet.desktop-install-manifest.v1' or m.get('repository')!='metric-space-ai/workjet' or len(xs)!=1: raise SystemExit('invalid Workjet manifest')\nx=xs[0]\nif not x['url'].startswith('https://github.com/'): raise SystemExit('invalid Workjet artifact URL')\ndata=urllib.request.urlopen(x['url'],timeout=60).read()\nif len(data)!=x['size'] or hashlib.sha256(data).hexdigest()!=x['sha256'].lower(): raise SystemExit('Workjet artifact verification failed')\nopen(sys.argv[2],'wb').write(data)\nPY\nprintf '{"phase":"verification","status":"completed","percent":90,"message":"Workjet package checksum verified"}\\n'\nif [ "$(uname -s)" = Darwin ]; then\n  mount_dir="$tmp/workjet-mount"; mkdir -p "$mount_dir"; hdiutil attach "$tmp/workjet-artifact" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null; app="$(find "$mount_dir" -maxdepth 1 -name 'Workjet.app' -print -quit)"; test -n "$app"; run_admin rm -rf /Applications/Workjet.app; run_admin cp -R "$app" /Applications/Workjet.app; hdiutil detach "$mount_dir" >/dev/null\nelse\n  run_admin mkdir -p /opt/workjet; run_admin install -m 0755 "$tmp/workjet-artifact" /opt/workjet/Workjet.AppImage; run_admin mkdir -p /usr/local/bin; run_admin ln -sfn /opt/workjet/Workjet.AppImage /usr/local/bin/workjet\nfi`;
      const posixAction = `set -eu\n${adminPrefix}\ntmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT\n${components.includes("ctox-backend") ? ctoxPosix : ""}\n${components.includes("workjet") ? `${workjetPosix}\n${action === "status" ? "" : LINUX_DESKTOP_REGISTRATION_SCRIPT}` : ""}\nprintf '{"phase":"complete","status":"completed","percent":100,"message":"Requested components are ready"}\\n'`;
      const ctoxWindows =
        action === "install" || action === "repair"
          ? `$m=Invoke-RestMethod '${CTOX_MANIFEST_URL}'; if($m.schema -ne 'ctox.install-manifest.v1' -or $m.repository -ne 'metric-space-ai/ctox'){throw 'invalid CTOX manifest'}; $b=$m.bootstrap.windows; $script=Join-Path $env:TEMP ('ctox-'+[guid]::NewGuid().ToString('N')+'.ps1'); Invoke-WebRequest -UseBasicParsing $b.url -OutFile $script; if((Get-FileHash $script -Algorithm SHA256).Hash.ToLowerInvariant() -ne $b.sha256.ToLowerInvariant()){throw 'CTOX bootstrap checksum mismatch'}; & $script`
          : `$ctox=Join-Path $env:ProgramFiles 'CTOX\\current\\bin\\ctox.exe'; switch ('${action}') { 'status' { & $ctox status } 'start' { & $ctox start } 'stop' { & $ctox stop } 'restart' { & $ctox stop; & $ctox start } 'update' { & $ctox update apply --latest } 'rollback' { & $ctox update rollback } default { exit 64 } }`;
      const workjetWindows =
        action === "status"
          ? `if(-not (Test-Path (Join-Path $env:ProgramFiles 'Workjet\\Workjet.exe'))){throw 'Workjet is not installed'}`
          : `$m=Invoke-RestMethod '${WORKJET_MANIFEST_URL}'; if($m.schema -ne 'workjet.desktop-install-manifest.v1' -or $m.repository -ne 'metric-space-ai/workjet'){throw 'invalid Workjet manifest'}; $x=@($m.artifacts|Where-Object {$_.platform -eq 'windows' -and $_.arch -eq 'x64'}); if($x.Count -ne 1){throw 'Workjet Windows artifact unavailable'}; $installer=Join-Path $env:TEMP ('workjet-'+[guid]::NewGuid().ToString('N')+'.exe'); Invoke-WebRequest -UseBasicParsing $x[0].url -OutFile $installer; if((Get-Item $installer).Length -ne $x[0].size -or (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $x[0].sha256.ToLowerInvariant()){throw 'Workjet installer verification failed'}; $p=Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru; if($p.ExitCode -ne 0){throw 'Workjet installer failed'}`;
      const windowsAction = `$ErrorActionPreference='Stop'; ${components.includes("ctox-backend") ? ctoxWindows : ""}; ${components.includes("workjet") ? workjetWindows : ""}; Write-Output '{"phase":"complete","status":"completed","percent":100,"message":"Requested components are ready"}'`;
      appendEvent(entry, {
        phase: "authorization",
        status: "running",
        percent: 10,
        message: "Requesting target authorization if required",
      });
      let result: CommandResult;
      if (record.public.target._tag === "local") {
        result = yield* Effect.tryPromise(() =>
          record.public.platform === "windows"
            ? record.public.administratorElevationRequired
              ? runLocalElevatedPowerShell(windowsAction, 60 * 60 * 1_000)
              : runLocalCommand(
                  "powershell.exe",
                  ["-NoProfile", "-NonInteractive", "-Command", "-"],
                  windowsAction,
                  60 * 60 * 1_000,
                )
            : runLocalCommand("sh", ["-s"], posixAction, 60 * 60 * 1_000),
        );
      } else if (record.knownHostsLine !== null) {
        const target = record.public.target.ssh;
        result = yield* runRemoteAuthenticated(
          target,
          record.knownHostsLine,
          (knownHostsPath, authSecret) =>
            record.public.platform === "windows"
              ? sshCommand(
                  target,
                  knownHostsPath,
                  authSecret,
                  ["powershell", "-NoProfile", "-NonInteractive", "-Command", "-"],
                  windowsAction,
                  60 * 60 * 1_000,
                )
              : sshCommand(
                  target,
                  knownHostsPath,
                  authSecret,
                  ["sh", "-s"],
                  posixAction,
                  60 * 60 * 1_000,
                ),
        );
      } else return yield* Effect.fail(new Error("Approved SSH host key is missing."));
      for (const line of result.stdout.split(/\r?\n/u)) {
        try {
          const value = JSON.parse(line) as {
            phase?: string;
            status?: string;
            percent?: number;
            message?: string;
          };
          if (typeof value.message === "string" && typeof value.percent === "number")
            appendEvent(entry, {
              phase:
                value.phase === "complete"
                  ? "complete"
                  : value.phase === "health"
                    ? "health"
                    : value.phase === "verification" || value.phase === "verify"
                      ? "verification"
                      : value.phase === "service"
                        ? "service"
                        : value.phase === "download"
                          ? "download"
                          : "installation",
              status:
                value.status === "failed"
                  ? "failed"
                  : value.status === "completed"
                    ? "completed"
                    : "running",
              percent: Math.max(0, Math.min(100, Math.round(value.percent))),
              message: value.message.slice(0, 2_048),
            });
        } catch {
          /* Installer diagnostics are intentionally not forwarded. */
        }
      }
      // Pairing persists the backend but does not imply an active guest; that
      // flag only becomes true after the normal Business OS attach path.
      const activeConnection = false;
      if (components.includes("ctox-backend") && (action === "install" || action === "repair")) {
        appendEvent(entry, {
          phase: "pairing",
          status: "running",
          percent: 96,
          message: "Creating a local-only Business OS pairing invite",
        });
        const posixInvite = `ctox_bin="$(command -v ctox || printf '%s' "$HOME/.local/bin/ctox")"\n"$ctox_bin" business-os desktop invite --format json --ttl-hours 168 --display-name Workjet`;
        const windowsInvite = `$ctox=Join-Path $env:ProgramFiles 'CTOX\\current\\bin\\ctox.exe'; & $ctox business-os desktop invite --format json --ttl-hours 168 --display-name Workjet`;
        let inviteResult: CommandResult;
        if (record.public.target._tag === "local") {
          inviteResult = yield* Effect.tryPromise(() =>
            record.public.platform === "windows"
              ? runLocalCommand(
                  "powershell.exe",
                  ["-NoProfile", "-NonInteractive", "-Command", "-"],
                  windowsInvite,
                )
              : runLocalCommand("sh", ["-s"], posixInvite),
          );
        } else if (record.knownHostsLine !== null) {
          const target = record.public.target.ssh;
          inviteResult = yield* runRemoteAuthenticated(
            target,
            record.knownHostsLine,
            (knownHostsPath, authSecret) =>
              record.public.platform === "windows"
                ? sshCommand(
                    target,
                    knownHostsPath,
                    authSecret,
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", "-"],
                    windowsInvite,
                  )
                : sshCommand(target, knownHostsPath, authSecret, ["sh", "-s"], posixInvite),
          );
        } else
          return yield* Effect.fail(new Error("Approved SSH host key is missing for pairing."));
        yield* registry.importInvite(inviteResult.stdout.trim());
        appendEvent(entry, {
          phase: "pairing",
          status: "completed",
          percent: 98,
          message: "CTOX backend paired with Workjet",
        });
      }
      if (
        !entry.snapshot.events.some(
          (event) => event.phase === "complete" && event.status === "completed",
        )
      )
        appendEvent(entry, {
          phase: "complete",
          status: "completed",
          percent: 100,
          message: `CTOX ${action} completed`,
        });
      entry.snapshot = {
        ...entry.snapshot,
        state: "completed",
        serviceState: action === "stop" ? "stopped" : "running",
        backendHealthy: action !== "stop",
        activeConnection,
        installedVersion: record.public.ctoxInstalledVersion,
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          appendEvent(entry, {
            phase: "failed",
            status: "failed",
            percent: 100,
            message: safeMessage(error, "Provisioning failed"),
          });
          entry.snapshot = {
            ...entry.snapshot,
            state: "failed",
            serviceState: "failed",
            backendHealthy: false,
            errorCode: "operation_failed",
          };
        }),
      ),
    );

  const start = (input: WorkjetProvisioningStartInput) =>
    Effect.gen(function* () {
      const record = preflights.get(input.preflightId);
      if (!record || Date.now() - record.createdAtMs > PREFLIGHT_TTL_MS)
        return {
          _tag: "failed",
          code: "preflight_expired",
          message: "Run the target preflight again before provisioning.",
        } satisfies WorkjetProvisioningStartResult;
      if (input.components.includes("workjet") && !record.public.graphicalSession)
        return {
          _tag: "failed",
          code: "component_unavailable",
          message: "Workjet is unavailable on a headless target.",
        } satisfies WorkjetProvisioningStartResult;
      const operationId = NodeCrypto.randomUUID();
      const entry: MutableOperation = {
        snapshot: initialSnapshot(input, operationId),
        updatedAtMs: Date.now(),
      };
      operations.set(operationId, entry);
      yield* runOperation(entry, record).pipe(Effect.forkDetach);
      return {
        _tag: "started",
        operation: entry.snapshot,
      } satisfies WorkjetProvisioningStartResult;
    });

  const get = (operationId: string) =>
    Effect.sync((): WorkjetProvisioningGetResult => {
      for (const [id, entry] of operations)
        if (Date.now() - entry.updatedAtMs > OPERATION_RETENTION_MS) operations.delete(id);
      const entry = operations.get(operationId);
      return entry ? { _tag: "found", operation: entry.snapshot } : { _tag: "not_found" };
    });

  return DesktopComputerProvisioner.of({ inspectHostKey, preflight, start, get });
});

export const layer = Layer.effect(DesktopComputerProvisioner, make);

export const testing = {
  normalizePlatform,
  normalizeArchitecture,
  parseKeyValueOutput,
  administratorCapability,
  posixPreflightScript: POSIX_PREFLIGHT_SCRIPT,
  windowsPreflightScript: WINDOWS_PREFLIGHT_SCRIPT,
  linuxDesktopEntry: LINUX_DESKTOP_ENTRY,
  linuxDesktopRegistrationScript: LINUX_DESKTOP_REGISTRATION_SCRIPT,
};
