// @effect-diagnostics globalFetch:off globalTimers:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers/promises";
import * as NodeURL from "node:url";

const TMP_ROOT = "/Volumes/tmp";
const DEBUG_PORT_MIN = 42_000;
const DEBUG_PORT_MAX = 42_999;
const MAX_CAPTURE_BYTES = 128 * 1024;
const MAX_CDP_MESSAGE_BYTES = 1024 * 1024;
const MAX_TARGETS = 32;
const REQUIRED_COLLECTIONS = [
  "business_module_catalog",
  "ctox_runtime_settings",
  "business_commands",
  "ctox_queue_tasks",
] as const;

export interface SmokeArguments {
  readonly workjetExecutable: string;
  readonly ctoxCli: string;
  readonly ctoxInstanceDir: string;
  readonly smokeRoot: string;
}
export interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly webSocketDebuggerUrl?: string;
}
export interface TargetProbe {
  readonly target: CdpTarget;
  readonly capable: boolean;
}
export interface ProcessRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}
export interface ProfileCheck {
  readonly applicablePids: readonly number[];
  readonly violations: readonly { readonly pid: number; readonly reason: "missing" | "mismatch" }[];
}
export interface ClassifiedStatus {
  readonly healthy: boolean;
  readonly peerRevoked: boolean;
  readonly browserDeviceId?: string;
  readonly diagnostics?: readonly string[];
}
export interface RectSnapshot {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}
export interface CtoxShellGeometry {
  readonly viewport: { readonly height: number; readonly width: number };
  readonly sidebar: RectSnapshot;
  readonly main: RectSnapshot;
  readonly chrome: RectSnapshot;
  readonly host: RectSnapshot;
}
const SAFE_DATA_PLANE_STATUSES = new Set(["idle", "pending", "ready", "failed", "unknown"]);
const SAFE_DATA_PLANE_REASONS = new Set([
  "none",
  "bootstrap",
  "open-business-data-plane",
  "repair-business-data-plane",
  "login-required",
  "redacted",
]);
export type LifecycleEvent =
  | "paired"
  | "revoked"
  | "unrevoked"
  | "recovered"
  | "pairingRemoved"
  | "workjetStopped"
  | "temporaryFilesDeleted";
export interface LifecycleState {
  readonly paired: boolean;
  readonly revoked: boolean;
  readonly unrevoked: boolean;
  readonly recovered: boolean;
  readonly workjetStopped: boolean;
  readonly temporaryFilesDeleted: boolean;
}
export const INITIAL_LIFECYCLE_STATE: LifecycleState = {
  paired: false,
  revoked: false,
  unrevoked: false,
  recovered: false,
  workjetStopped: false,
  temporaryFilesDeleted: false,
};

function usage(): string {
  return [
    "Usage: node scripts/ctox-packaged-smoke.ts",
    "  --workjet-executable <absolute-path>",
    "  --ctox-cli <absolute-path>",
    "  --ctox-instance-dir <absolute-path>",
    "  --smoke-root <absolute-path-under-/Volumes/tmp>",
  ].join("\n");
}

export function parseSmokeArguments(
  argv: readonly string[],
  platform = process.platform,
): SmokeArguments {
  if (platform !== "darwin")
    throw new Error("unsupported host: packaged CTOX smoke requires macOS");
  const names = new Map<string, keyof SmokeArguments>([
    ["--workjet-executable", "workjetExecutable"],
    ["--ctox-cli", "ctoxCli"],
    ["--ctox-instance-dir", "ctoxInstanceDir"],
    ["--smoke-root", "smokeRoot"],
  ]);
  const values: Partial<Record<keyof SmokeArguments, string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag === undefined ? undefined : names.get(flag);
    if (key === undefined || value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error("invalid arguments\n" + usage());
    }
    if (values[key] !== undefined) throw new Error(`duplicate argument: ${flag}`);
    values[key] = value;
  }
  for (const key of names.values()) {
    const value = values[key];
    if (value === undefined) throw new Error("missing required arguments\n" + usage());
    if (!NodePath.isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
    if ([...value].some((character) => character.charCodeAt(0) === 0))
      throw new Error(`${key} contains an invalid character`);
  }
  const smokeRoot = NodePath.resolve(values.smokeRoot!);
  const relative = NodePath.relative(TMP_ROOT, smokeRoot);
  if (
    relative === "" ||
    relative.startsWith(".." + NodePath.sep) ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error("smokeRoot must be a child of /Volumes/tmp");
  }
  return {
    workjetExecutable: NodePath.resolve(values.workjetExecutable!),
    ctoxCli: NodePath.resolve(values.ctoxCli!),
    ctoxInstanceDir: NodePath.resolve(values.ctoxInstanceDir!),
    smokeRoot,
  };
}

export function selectTargetByCapability(probes: readonly TargetProbe[], label: string): CdpTarget {
  const matches = probes.filter(({ capable }) => capable).map(({ target }) => target);
  if (matches.length !== 1)
    throw new Error(`${label} target selection found ${matches.length} matches`);
  return matches[0]!;
}

export function cdpCommandError(method: string, value: unknown): Error {
  const code =
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === "number" &&
    Number.isSafeInteger((value as Record<string, unknown>).code)
      ? ((value as Record<string, unknown>).code as number)
      : undefined;
  return new Error(
    code === undefined ? `CDP ${method} failed` : `CDP ${method} failed (code ${code})`,
  );
}

export function parseProcessTable(stdout: string): readonly ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid))
      records.push({ pid, ppid, command: match[3] ?? "" });
  }
  return records;
}

export function recursiveDescendants(
  records: readonly ProcessRecord[],
  rootPid: number,
): readonly ProcessRecord[] {
  const children = new Map<number, ProcessRecord[]>();
  for (const record of records) {
    const bucket = children.get(record.ppid) ?? [];
    bucket.push(record);
    children.set(record.ppid, bucket);
  }
  const descendants: ProcessRecord[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const record = pending.shift()!;
    if (seen.has(record.pid)) continue;
    seen.add(record.pid);
    descendants.push(record);
    pending.push(...(children.get(record.pid) ?? []));
  }
  return descendants;
}

function hasExactProfileArgument(command: string, expected: string): boolean {
  return [
    `--user-data-dir=${expected}`,
    `--user-data-dir="${expected}"`,
    `--user-data-dir='${expected}'`,
  ].some((candidate) => {
    const at = command.indexOf(candidate);
    if (at < 0) return false;
    const next = command[at + candidate.length];
    return next === undefined || /\s/.test(next);
  });
}

export function checkChildProcessProfiles(
  records: readonly ProcessRecord[],
  rootPid: number,
  expectedUserDataDir: string,
): ProfileCheck {
  const applicable = recursiveDescendants(records, rootPid).filter(({ command }) =>
    /(?:^|\s)--type=(?:renderer|gpu-process|utility)(?:\s|$)/.test(command),
  );
  const violations = applicable.flatMap(({ pid, command }) => {
    if (hasExactProfileArgument(command, expectedUserDataDir)) return [];
    return [
      { pid, reason: command.includes("--user-data-dir=") ? "mismatch" : "missing" } as const,
    ];
  });
  return { applicablePids: applicable.map(({ pid }) => pid), violations };
}

function boundedContainsSignal(value: unknown, signal: string): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 512) {
    const current = pending.shift()!;
    visited += 1;
    if (current.value === signal) return true;
    if (current.depth >= 8 || typeof current.value !== "object" || current.value === null) continue;
    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, 64))
        pending.push({ value: item, depth: current.depth + 1 });
    } else {
      for (const [key, item] of Object.entries(current.value).slice(0, 64)) {
        if (key === signal && item === true) return true;
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

export function classifyAdvancedStatus(value: unknown): ClassifiedStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { healthy: false, peerRevoked: false };
  const status = value as Record<string, unknown>;
  const sync =
    typeof status.sync === "object" && status.sync !== null && !Array.isArray(status.sync)
      ? (status.sync as Record<string, unknown>)
      : undefined;
  const deviceId = sync?.browserDeviceId;
  const browserDeviceId =
    typeof deviceId === "string" &&
    deviceId.length >= 1 &&
    deviceId.length <= 256 &&
    [...deviceId].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
      ? deviceId
      : undefined;
  const diagnostics: string[] = [];
  const appendDiagnostic = (prefix: string, item: unknown): void => {
    if (
      typeof item === "string" &&
      /^[A-Za-z0-9_.:-]{1,80}$/u.test(item) &&
      diagnostics.length < 32
    )
      diagnostics.push(`${prefix}:${item}`);
  };
  appendDiagnostic("phase", sync?.phase);
  if (Array.isArray(status.failures))
    for (const failure of status.failures) appendDiagnostic("failure", failure);
  if (Array.isArray(sync?.collectionErrors)) {
    for (const value of sync.collectionErrors.slice(0, 16)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const error = value as Record<string, unknown>;
      appendDiagnostic("error", error.code ?? error.name);
    }
  }
  if (Array.isArray(sync?.missingRequiredCollections)) {
    for (const collection of sync.missingRequiredCollections.slice(0, 8))
      appendDiagnostic("missing-required", collection);
  }
  const initialSync =
    typeof sync?.initialSync === "object" &&
    sync.initialSync !== null &&
    !Array.isArray(sync.initialSync)
      ? (sync.initialSync as Record<string, unknown>)
      : undefined;
  for (const [field, prefix] of [
    ["missingInitialReplication", "missing-initial"],
    ["missingStreamingReady", "missing-streaming"],
    ["missingCheckpointEpoch", "missing-checkpoint"],
  ] as const) {
    const values = initialSync?.[field];
    if (Array.isArray(values))
      for (const collection of values.slice(0, 8)) appendDiagnostic(prefix, collection);
  }
  const frameTransport =
    typeof sync?.frameTransport === "object" &&
    sync.frameTransport !== null &&
    !Array.isArray(sync.frameTransport)
      ? (sync.frameTransport as Record<string, unknown>)
      : undefined;
  const totals =
    typeof frameTransport?.totals === "object" &&
    frameTransport.totals !== null &&
    !Array.isArray(frameTransport.totals)
      ? (frameTransport.totals as Record<string, unknown>)
      : undefined;
  if (Number.isSafeInteger(totals?.activePeerCount))
    appendDiagnostic("active-peers", String(totals?.activePeerCount));
  if (Array.isArray(frameTransport?.unhealthyCollections)) {
    for (const value of frameTransport.unhealthyCollections.slice(0, 8)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const unhealthy = value as Record<string, unknown>;
      if (!Array.isArray(unhealthy.reasons)) continue;
      for (const reason of unhealthy.reasons.slice(0, 4)) {
        if (typeof unhealthy.collection === "string" && typeof reason === "string")
          appendDiagnostic("transport", `${unhealthy.collection}:${reason}`);
      }
    }
  }
  const desktopRuntime =
    typeof status.desktopRuntime === "object" &&
    status.desktopRuntime !== null &&
    !Array.isArray(status.desktopRuntime)
      ? (status.desktopRuntime as Record<string, unknown>)
      : undefined;
  if (
    typeof desktopRuntime?.dataPlaneStatus === "string" &&
    SAFE_DATA_PLANE_STATUSES.has(desktopRuntime.dataPlaneStatus)
  )
    appendDiagnostic("data-plane", desktopRuntime.dataPlaneStatus);
  if (
    typeof desktopRuntime?.dataPlaneReason === "string" &&
    SAFE_DATA_PLANE_REASONS.has(desktopRuntime.dataPlaneReason)
  )
    appendDiagnostic("data-plane-reason", desktopRuntime.dataPlaneReason);
  for (const field of ["db", "syncConfig", "sync", "commandBus"] as const) {
    if (desktopRuntime?.[field] === true) appendDiagnostic("runtime", field);
    if (desktopRuntime?.[field] === false) appendDiagnostic("missing", field);
  }
  return {
    healthy: status.ok === true,
    peerRevoked: boundedContainsSignal(value, "peer_revoked"),
    ...(browserDeviceId === undefined ? {} : { browserDeviceId }),
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  };
}

export function transitionLifecycle(state: LifecycleState, event: LifecycleEvent): LifecycleState {
  if (
    state.revoked &&
    !state.unrevoked &&
    (event === "pairingRemoved" || event === "workjetStopped" || event === "temporaryFilesDeleted")
  ) {
    throw new Error("peer must be successfully unrevoked before destructive cleanup");
  }
  switch (event) {
    case "paired":
      return { ...state, paired: true };
    case "revoked":
      return { ...state, revoked: true, unrevoked: false, recovered: false };
    case "unrevoked":
      if (!state.revoked) throw new Error("cannot unrevoke before revoke");
      return { ...state, unrevoked: true };
    case "recovered":
      if (!state.unrevoked) throw new Error("cannot recover before successful unrevoke");
      return { ...state, recovered: true };
    case "pairingRemoved":
      return { ...state, paired: false };
    case "workjetStopped":
      return { ...state, workjetStopped: true };
    case "temporaryFilesDeleted":
      return { ...state, temporaryFilesDeleted: true };
  }
}

export function cleanupActionOrder(state: LifecycleState): readonly string[] {
  const actions: string[] = [];
  if (state.revoked && !state.unrevoked) actions.push("unrevoke", "recover");
  else if (state.revoked && state.unrevoked && !state.recovered) actions.push("recover");
  if (state.paired) actions.push("remove-pairing");
  if (!state.workjetStopped) actions.push("stop-workjet");
  if (!state.temporaryFilesDeleted) actions.push("delete-temporary-files");
  return actions;
}

export function redactSensitive(input: string, secrets: readonly string[] = []): string {
  let output = input;
  for (const secret of [...secrets]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length))
    output = output.split(secret).join("[REDACTED]");
  return output
    .replace(/ctox-business-os-desktop:\/\/\S+/giu, "[REDACTED_URL]")
    .replace(
      /\b(capability|room[_-]?password|registry[_-]?secret|peer[_-]?id)\s*[:=]\s*[^\s,}]+/giu,
      "$1=[REDACTED]",
    )
    .slice(0, 800);
}

function validRect(rect: RectSnapshot): boolean {
  return (
    [rect.bottom, rect.height, rect.left, rect.right, rect.top, rect.width].every(
      Number.isFinite,
    ) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > rect.left &&
    rect.bottom > rect.top
  );
}

export function isCtoxShellGeometryContained(geometry: CtoxShellGeometry): boolean {
  const { viewport, sidebar, main, chrome, host } = geometry;
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    ![sidebar, main, chrome, host].every(validRect)
  )
    return false;
  return (
    sidebar.left >= 0 &&
    sidebar.top >= 0 &&
    sidebar.right <= viewport.width &&
    sidebar.bottom <= viewport.height &&
    main.left >= sidebar.right &&
    main.top >= 0 &&
    main.right <= viewport.width &&
    main.bottom <= viewport.height &&
    chrome.left >= main.left &&
    chrome.top >= main.top &&
    chrome.right <= main.right &&
    chrome.bottom <= main.bottom &&
    host.left >= sidebar.right &&
    host.left >= main.left &&
    host.top >= chrome.bottom &&
    host.right <= main.right &&
    host.bottom <= main.bottom &&
    host.right <= viewport.width &&
    host.bottom <= viewport.height
  );
}

function assertRuntimePaths(args: SmokeArguments): void {
  if (!NodeFS.statSync(args.workjetExecutable).isFile())
    throw new Error("Workjet executable is not a file");
  NodeFS.accessSync(args.workjetExecutable, NodeFS.constants.X_OK);
  if (!NodeFS.statSync(args.ctoxCli).isFile()) throw new Error("CTOX CLI is not a file");
  NodeFS.accessSync(args.ctoxCli, NodeFS.constants.X_OK);
  if (!NodeFS.statSync(args.ctoxInstanceDir).isDirectory())
    throw new Error("CTOX instance cwd is not a directory");
  if (NodeFS.existsSync(args.smokeRoot)) throw new Error("smoke root must not already exist");
  let ancestor = NodePath.dirname(args.smokeRoot);
  while (!NodeFS.existsSync(ancestor)) {
    const parent = NodePath.dirname(ancestor);
    if (parent === ancestor) throw new Error("smoke root has no existing parent");
    ancestor = parent;
  }
  const realTmp = NodeFS.realpathSync(TMP_ROOT);
  const realAncestor = NodeFS.realpathSync(ancestor);
  const relative = NodePath.relative(realTmp, realAncestor);
  if (relative.startsWith(".." + NodePath.sep) || NodePath.isAbsolute(relative))
    throw new Error("smoke root resolves outside /Volumes/tmp");
}

function phase(message: string): void {
  process.stdout.write(`${message}\n`);
}

function runCtox(args: SmokeArguments, command: readonly string[], returnStdout = false): string {
  const result = NodeChildProcess.spawnSync(args.ctoxCli, command, {
    cwd: args.ctoxInstanceDir,
    env: process.env,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null)
    throw new Error("CTOX command failed");
  const stdout = result.stdout;
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES)
    throw new Error("CTOX command returned invalid output");
  return returnStdout ? stdout.trim() : "";
}

async function chooseDebugPort(): Promise<number> {
  const span = DEBUG_PORT_MAX - DEBUG_PORT_MIN + 1;
  const start = NodeCrypto.randomInt(0, span);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = DEBUG_PORT_MIN + ((start + attempt) % span);
    const available = await new Promise<boolean>((resolve) => {
      const server = NodeNet.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
        server.close(() => resolve(true)),
      );
    });
    if (available) return port;
  }
  throw new Error("no bounded remote-debugging port is available");
}

async function fetchTargets(port: number): Promise<readonly CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  if (response === undefined || !response.ok)
    throw new Error("remote debugging target list is unavailable");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_CDP_MESSAGE_BYTES)
    throw new Error("remote debugging target list is too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_CDP_MESSAGE_BYTES)
    throw new Error("remote debugging target list is too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("remote debugging target list is invalid");
  }
  if (!Array.isArray(raw) || raw.length > MAX_TARGETS)
    throw new Error("remote debugging target count is invalid");
  return raw.flatMap((item): CdpTarget[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.type !== "string") return [];
    return [
      {
        id: record.id,
        type: record.type,
        ...(typeof record.webSocketDebuggerUrl === "string"
          ? { webSocketDebuggerUrl: record.webSocketDebuggerUrl }
          : {}),
      },
    ];
  });
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (Buffer.byteLength(data) > MAX_CDP_MESSAGE_BYTES) {
        this.rejectAll(new Error("CDP message is too large"));
        this.close();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const response = value as Record<string, unknown>;
      if (typeof response.id !== "number") return;
      const waiter = this.pending.get(response.id);
      if (waiter === undefined) return;
      this.pending.delete(response.id);
      if (response.error !== undefined)
        waiter.reject(cdpCommandError("Runtime.evaluate", response.error));
      else waiter.resolve(response.result);
    });
    socket.addEventListener("close", () => this.rejectAll(new Error("CDP connection closed")));
    socket.addEventListener("error", () => this.rejectAll(new Error("CDP connection failed")));
  }
  static async connect(url: string): Promise<CdpClient> {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\//u.test(url))
      throw new Error("CDP target endpoint is not loopback");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("CDP connection timed out"));
      }, 2_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    return new CdpClient(socket);
  }
  async evaluate(expression: string, timeoutMs = 4_000): Promise<unknown> {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (typeof result !== "object" || result === null)
      throw new Error("CDP evaluation returned no result");
    const record = result as Record<string, unknown>;
    if (record.exceptionDetails !== undefined) throw new Error("CDP evaluation failed");
    const remote = record.result;
    if (typeof remote !== "object" || remote === null)
      throw new Error("CDP evaluation returned no value");
    return (remote as Record<string, unknown>).value;
  }
  private send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP command timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  close(): void {
    this.socket.close();
  }
}

async function evaluateTarget(
  target: CdpTarget,
  expression: string,
  timeoutMs?: number,
): Promise<unknown> {
  if (target.webSocketDebuggerUrl === undefined) throw new Error("target has no debugger endpoint");
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    return await client.evaluate(expression, timeoutMs);
  } finally {
    client.close();
  }
}

async function selectCurrentTarget(
  port: number,
  capability: string,
  label: string,
): Promise<CdpTarget> {
  const targets = (await fetchTargets(port)).filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl !== undefined,
  );
  const probes: TargetProbe[] = [];
  for (const target of targets) {
    let capable = false;
    try {
      capable = (await evaluateTarget(target, capability)) === true;
    } catch {
      capable = false;
    }
    probes.push({ target, capable });
  }
  return selectTargetByCapability(probes, label);
}

let interruptedSignal: string | undefined;
async function pause(milliseconds: number): Promise<void> {
  if (interruptedSignal !== undefined) throw new Error(`interrupted by ${interruptedSignal}`);
  await NodeTimers.setTimeout(milliseconds);
  if (interruptedSignal !== undefined) throw new Error(`interrupted by ${interruptedSignal}`);
}
async function waitForTarget(
  port: number,
  capability: string,
  label: string,
  timeoutMs: number,
): Promise<CdpTarget> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      return await selectCurrentTarget(port, capability, label);
    } catch {
      await pause(250);
    }
  }
  throw new Error(`${label} target did not appear`);
}

const MAIN_CAPABILITY = `(() => { const c = globalThis.desktopBridge?.ctox; return !!c && ["importInvite", "removePairedInstance"].every((name) => typeof c[name] === "function"); })()`;
const GUEST_CAPABILITY = `typeof globalThis.CTOX_BUSINESS_OS_STATUS?.snapshot === "function"`;
function bridgeCallExpression(method: string, args: readonly unknown[]): string {
  return `(async () => { const c = globalThis.desktopBridge?.ctox; if (!c || typeof c[${JSON.stringify(method)}] !== "function") throw new Error("bridge unavailable"); return await c[${JSON.stringify(method)}](...${JSON.stringify(args)}); })()`;
}
async function evaluateMain(port: number, expression: string): Promise<unknown> {
  const target = await waitForTarget(port, MAIN_CAPABILITY, "main renderer", 15_000);
  return evaluateTarget(target, expression);
}
async function callBridge(
  port: number,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  return evaluateMain(port, bridgeCallExpression(method, args));
}

async function waitForMainCondition(
  port: number,
  expression: string,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      if ((await evaluateMain(port, expression)) === true) return;
    } catch {
      // The main renderer may be committing the product-mode replacement.
    }
    await pause(250);
  }
  throw new Error(`${label} did not appear`);
}

function productModeExpression(mode: "code" | "ctox"): string {
  const selector = JSON.stringify(`[data-product-mode="${mode}"]`);
  return `(() => {
    const control = document.querySelector(${selector});
    if (!(control instanceof HTMLButtonElement)) return false;
    control.click();
    return true;
  })()`;
}

function productModeReadyExpression(mode: "code" | "ctox"): string {
  const selector = JSON.stringify(`[data-product-mode="${mode}"]`);
  if (mode === "ctox") {
    return `(() => {
      const control = document.querySelector(${selector});
      return control instanceof HTMLButtonElement && control.getAttribute("aria-checked") === "true" &&
        document.querySelector('[data-product-mode-shell="ctox"]') !== null &&
        document.querySelector('[data-ctox-sidebar-shell]') !== null &&
        document.querySelector('[data-ctox-main-shell]') !== null;
    })()`;
  }
  return `(() => {
    const control = document.querySelector(${selector});
    return control instanceof HTMLButtonElement && control.getAttribute("aria-checked") === "true" &&
      document.querySelector('[data-product-mode-shell="code"]') !== null &&
      document.querySelector('[data-ctox-sidebar-shell]') === null &&
      document.querySelector('[data-ctox-main-shell]') === null &&
      document.querySelector('[data-ctox-native-guest-host]') === null;
  })()`;
}

async function switchProductMode(port: number, mode: "code" | "ctox"): Promise<void> {
  await waitForMainCondition(port, productModeExpression(mode), `${mode} product-mode control`);
  await waitForMainCondition(port, productModeReadyExpression(mode), `${mode} product shell`);
}

const SELECT_IMPORTED_PAIRING_EXPRESSION = `(() => {
  const rows = [...document.querySelectorAll('button[data-ctox-instance-source="pairing_invite"][data-ctox-instance-status="paired"]')]
    .filter((row) => row instanceof HTMLButtonElement && !row.disabled);
  if (rows.length !== 1) return false;
  rows[0].click();
  return true;
})()`;

async function selectImportedPairing(port: number): Promise<void> {
  await waitForMainCondition(
    port,
    SELECT_IMPORTED_PAIRING_EXPRESSION,
    "imported paired instance control",
  );
}

const CTOX_SHELL_GEOMETRY_EXPRESSION = `(() => {
  const sidebar = document.querySelector('[data-app-sidebar]');
  const main = document.querySelector('[data-ctox-main-shell]');
  const chrome = document.querySelector('[data-ctox-main-chrome]');
  const host = document.querySelector('[data-ctox-native-guest-host]');
  if (![sidebar, main, chrome, host].every((element) => element instanceof HTMLElement)) return null;
  const sidebarStyle = getComputedStyle(sidebar);
  if (sidebarStyle.display === "none" || sidebarStyle.visibility === "hidden") return null;
  const snapshot = (element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
  };
  return {
    viewport: { height: innerHeight, width: innerWidth },
    sidebar: snapshot(sidebar), main: snapshot(main), chrome: snapshot(chrome), host: snapshot(host),
  };
})()`;

function parseRectSnapshot(value: unknown): RectSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = ["bottom", "height", "left", "right", "top", "width"] as const;
  if (!fields.every((field) => typeof record[field] === "number")) return undefined;
  return {
    bottom: record.bottom as number,
    height: record.height as number,
    left: record.left as number,
    right: record.right as number,
    top: record.top as number,
    width: record.width as number,
  };
}

function parseCtoxShellGeometry(value: unknown): CtoxShellGeometry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const viewport = record.viewport;
  if (typeof viewport !== "object" || viewport === null || Array.isArray(viewport))
    return undefined;
  const viewportRecord = viewport as Record<string, unknown>;
  if (typeof viewportRecord.width !== "number" || typeof viewportRecord.height !== "number")
    return undefined;
  const sidebar = parseRectSnapshot(record.sidebar);
  const main = parseRectSnapshot(record.main);
  const chrome = parseRectSnapshot(record.chrome);
  const host = parseRectSnapshot(record.host);
  if (sidebar === undefined || main === undefined || chrome === undefined || host === undefined)
    return undefined;
  return {
    viewport: { width: viewportRecord.width, height: viewportRecord.height },
    sidebar,
    main,
    chrome,
    host,
  };
}

async function waitForContainedGuestHost(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const geometry = parseCtoxShellGeometry(
        await evaluateMain(port, CTOX_SHELL_GEOMETRY_EXPRESSION),
      );
      if (geometry !== undefined && isCtoxShellGeometryContained(geometry)) return;
    } catch {
      // Layout and selection can settle between target enumeration and evaluation.
    }
    await pause(250);
  }
  throw new Error("CTOX guest host was not contained by the visible product shell");
}

async function waitForGuestHostReady(port: number, timeoutMs = 15_000): Promise<void> {
  try {
    await waitForMainCondition(
      port,
      `document.querySelector('[data-ctox-native-guest-host][data-ctox-connection="ready"]') !== null`,
      "ready CTOX guest host",
      timeoutMs,
    );
  } catch {
    let observed = "unavailable";
    try {
      const value = await evaluateMain(
        port,
        `document.querySelector('[data-ctox-native-guest-host]')?.getAttribute('data-ctox-connection') ?? "missing"`,
      );
      if (
        typeof value === "string" &&
        ["connecting", "error", "idle", "missing", "ready", "revoked"].includes(value)
      ) {
        observed = value;
      }
    } catch {
      // The renderer may have exited while the timeout was being diagnosed.
    }
    throw new Error(`ready CTOX guest host did not appear (observed: ${observed})`);
  }
}

async function countCapableTargets(port: number, capability: string): Promise<number> {
  const targets = (await fetchTargets(port)).filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl !== undefined,
  );
  let matches = 0;
  for (const target of targets) {
    try {
      if ((await evaluateTarget(target, capability)) === true) matches += 1;
    } catch {
      // A destroyed guest target is equivalent to no active guest.
    }
  }
  return matches;
}

async function waitForNoGuestTarget(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let consecutive = 0;
  while (performance.now() < deadline) {
    try {
      consecutive = (await countCapableTargets(port, GUEST_CAPABILITY)) === 0 ? consecutive + 1 : 0;
      if (consecutive >= 2) return;
    } catch {
      consecutive = 0;
    }
    await pause(250);
  }
  throw new Error("native CTOX guest target remained active in Code mode");
}

async function leaveCtoxMode(port: number): Promise<void> {
  await switchProductMode(port, "code");
  await waitForNoGuestTarget(port);
}

async function enterCtoxAndSelectImportedPairing(port: number): Promise<void> {
  await switchProductMode(port, "ctox");
  await selectImportedPairing(port);
  await waitForContainedGuestHost(port);
}

function resultTag(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)._tag === "string"
    ? ((value as Record<string, unknown>)._tag as string)
    : undefined;
}
function completedInstanceId(value: unknown): string {
  if (resultTag(value) !== "completed") throw new Error("pairing import did not complete");
  const instance = (value as Record<string, unknown>).instance;
  if (typeof instance !== "object" || instance === null)
    throw new Error("pairing import returned no instance");
  const id = (instance as Record<string, unknown>).id;
  if (typeof id !== "string" || !/^paired:pairing_invite:[A-Za-z0-9_-]{22}$/u.test(id))
    throw new Error("pairing import returned an invalid instance");
  return id;
}
function assertCompleted(value: unknown, operation: string): void {
  if (resultTag(value) !== "completed") throw new Error(`${operation} did not complete`);
}

const STATUS_EXPRESSION = `(async () => {
  const statusApi = globalThis.CTOX_BUSINESS_OS_STATUS;
  const statusOptions = { includeCounts: false, requiredCollections: ${JSON.stringify(REQUIRED_COLLECTIONS)} };
  let snapshot;
  try {
    snapshot = await statusApi.waitForHealthy({ ...statusOptions, timeoutMs: 15000, intervalMs: 500 });
  } catch (error) {
    snapshot = error && typeof error === "object" && error.status
      ? error.status
      : await statusApi.snapshot(statusOptions);
  }
  const app = globalThis.CTOX_BUSINESS_OS_APP;
  const status = String(app?.dataPlaneReadyStatus || "unknown");
  const allowedStatuses = ["idle", "pending", "ready", "failed"];
  const reason = String(app?.dataPlaneReadyReason || "");
  const allowedReasons = ["bootstrap", "open-business-data-plane", "repair-business-data-plane", "login-required"];
  return {
    ...snapshot,
    desktopRuntime: {
      dataPlaneStatus: allowedStatuses.includes(status) ? status : "unknown",
      dataPlaneReason: allowedReasons.includes(reason) ? reason : (reason ? "redacted" : "none"),
      db: Boolean(app?.db),
      syncConfig: Boolean(app?.syncConfig),
      sync: Boolean(app?.sync),
      commandBus: Boolean(app?.commandBus),
    },
  };
})()`;
async function readStatus(port: number): Promise<ClassifiedStatus> {
  const target = await waitForTarget(port, GUEST_CAPABILITY, "navigated guest", 15_000);
  return classifyAdvancedStatus(await evaluateTarget(target, STATUS_EXPRESSION, 20_000));
}
async function waitForHealthyStatus(port: number, timeoutMs = 45_000): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  let diagnostics: readonly string[] = [];
  while (performance.now() < deadline) {
    try {
      const status = await readStatus(port);
      diagnostics = status.diagnostics ?? [];
      if (status.healthy && status.browserDeviceId !== undefined) return status.browserDeviceId;
    } catch (error) {
      /* Navigation can replace the target between enumeration and evaluation. */
      const message = error instanceof Error ? error.message : "unknown";
      diagnostics = [
        /^CDP [A-Za-z.]+ (?:failed|timed out)(?: \(code -?\d+\))?$/u.test(message)
          ? `runtime:${message.replaceAll(" ", "_")}`
          : "runtime:target-race",
      ];
    }
    await pause(500);
  }
  throw new Error(
    `guest did not report healthy advanced status with a browser device (${diagnostics.join(",") || "no-safe-diagnostics"})`,
  );
}
async function waitForPersistentRevocation(port: number): Promise<void> {
  const deadline = performance.now() + 45_000;
  let consecutive = 0;
  while (performance.now() < deadline) {
    try {
      const status = await readStatus(port);
      consecutive = !status.healthy && status.peerRevoked ? consecutive + 1 : 0;
      if (consecutive >= 2) return;
    } catch {
      consecutive = 0;
    }
    await pause(750);
  }
  throw new Error("guest did not remain unhealthy with peer_revoked status");
}

interface Markers {
  readonly cookie: string;
  readonly localStorage: string;
  readonly database: string;
  readonly cache: string;
  readonly value: string;
}
function createMarkers(): Markers {
  const token = NodeCrypto.randomBytes(16).toString("hex");
  return {
    cookie: `workjet_ctox_smoke_cookie_${token}`,
    localStorage: `workjet_ctox_smoke_local_${token}`,
    database: `workjet_ctox_smoke_idb_${token}`,
    cache: `workjet_ctox_smoke_cache_${token}`,
    value: token,
  };
}
function markerExpression(markers: Markers, mode: "seed" | "absent"): string {
  const encoded = JSON.stringify(markers);
  if (mode === "seed")
    return `(async () => {
    const m = ${encoded}; document.cookie = m.cookie + "=" + m.value + "; Path=/; SameSite=Lax"; localStorage.setItem(m.localStorage, m.value);
    await new Promise((resolve, reject) => { const request = indexedDB.open(m.database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("markers");
      request.onsuccess = () => { request.result.close(); resolve(undefined); }; request.onerror = () => reject(new Error("indexeddb seed failed")); });
    const cache = await caches.open(m.cache); await cache.put(new Request(location.origin + "/__workjet_ctox_smoke__/" + m.value), new Response(m.value));
    const databases = await indexedDB.databases(); return {
      cookie: document.cookie.split("; ").some((part) => part === m.cookie + "=" + m.value), localStorage: localStorage.getItem(m.localStorage) === m.value,
      database: databases.some((database) => database.name === m.database), cache: await caches.has(m.cache) }; })()`;
  return `(async () => { const m = ${encoded}; const databases = await indexedDB.databases(); return {
    cookie: !document.cookie.split("; ").some((part) => part.startsWith(m.cookie + "=")), localStorage: localStorage.getItem(m.localStorage) === null,
    database: !databases.some((database) => database.name === m.database), cache: !(await caches.has(m.cache)) }; })()`;
}
function allMarkerChecksPassed(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const checks = value as Record<string, unknown>;
  return (
    checks.cookie === true &&
    checks.localStorage === true &&
    checks.database === true &&
    checks.cache === true
  );
}
async function checkMarkers(
  port: number,
  markers: Markers,
  mode: "seed" | "absent",
): Promise<void> {
  const target = await waitForTarget(port, GUEST_CAPABILITY, "navigated guest", 15_000);
  if (!allMarkerChecksPassed(await evaluateTarget(target, markerExpression(markers, mode)))) {
    throw new Error(
      mode === "seed"
        ? "partition markers were not all seeded"
        : "partition markers survived pairing removal",
    );
  }
}

async function assertChildProfiles(pid: number, expectedUserDataDir: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const result = NodeChildProcess.spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: MAX_CDP_MESSAGE_BYTES,
      timeout: 3_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const check = checkChildProcessProfiles(
        parseProcessTable(result.stdout),
        pid,
        expectedUserDataDir,
      );
      if (check.violations.length > 0)
        throw new Error("packaged Electron child uses a non-disposable profile");
      if (check.applicablePids.length > 0) return;
    }
    await pause(250);
  }
  throw new Error("no packaged Electron child profile could be verified");
}
async function stopProcess(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    NodeTimers.setTimeout(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      NodeTimers.setTimeout(3_000),
    ]);
  }
}

async function run(): Promise<void> {
  const args = parseSmokeArguments(process.argv.slice(2));
  assertRuntimePaths(args);
  const sensitive: string[] = [];
  let state = INITIAL_LIFECYCLE_STATE;
  let child: NodeChildProcess.ChildProcess | undefined;
  let port: number | undefined;
  let invite: string | undefined;
  let instanceId: string | undefined;
  let browserDeviceId: string | undefined;
  let primaryError: unknown;

  const removePairing = async (): Promise<void> => {
    if (!state.paired || port === undefined || instanceId === undefined) return;
    await leaveCtoxMode(port);
    assertCompleted(
      await callBridge(port, "removePairedInstance", [instanceId]),
      "pairing removal",
    );
    state = transitionLifecycle(state, "pairingRemoved");
  };
  const recover = async (): Promise<void> => {
    if (
      !state.revoked ||
      !state.unrevoked ||
      state.recovered ||
      port === undefined ||
      instanceId === undefined
    )
      return;
    try {
      await enterCtoxAndSelectImportedPairing(port);
      await waitForGuestHostReady(port);
      await waitForHealthyStatus(port);
      state = transitionLifecycle(state, "recovered");
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }
  };

  try {
    NodeFS.mkdirSync(args.smokeRoot, { recursive: false, mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(args.smokeRoot, "app-data"), { mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(args.smokeRoot, "t3-home"), { mode: 0o700 });
    phase("invite: generating");
    invite = runCtox(
      args,
      ["business-os", "desktop", "invite", "--ttl-hours", "1", "--format", "json"],
      true,
    );
    if (invite.length === 0 || Buffer.byteLength(invite) > 64 * 1024)
      throw new Error("invite output is invalid");
    try {
      JSON.parse(invite);
    } catch {
      throw new Error("invite output is not JSON");
    }
    sensitive.push(invite);
    phase("invite: ready");

    port = await chooseDebugPort();
    const userDataDir = NodePath.join(args.smokeRoot, "app-data", "t3code");
    phase("workjet: launching isolated package");
    child = NodeChildProcess.spawn(
      args.workjetExecutable,
      [
        `--user-data-dir=${userDataDir}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
      ],
      {
        cwd: args.smokeRoot,
        env: {
          ...process.env,
          T3CODE_DESKTOP_APP_DATA_DIR: NodePath.join(args.smokeRoot, "app-data"),
          T3_HOME: NodePath.join(args.smokeRoot, "t3-home"),
        },
        stdio: "ignore",
      },
    );
    child.once("error", () => undefined);
    await waitForTarget(port, MAIN_CAPABILITY, "main renderer", 30_000);
    if (child.pid === undefined) throw new Error("packaged Workjet did not start");
    await assertChildProfiles(child.pid, userDataDir);
    phase("workjet: isolated profile verified");

    instanceId = completedInstanceId(await callBridge(port, "importInvite", [invite]));
    state = transitionLifecycle(state, "paired");
    await enterCtoxAndSelectImportedPairing(port);
    await waitForGuestHostReady(port);
    browserDeviceId = await waitForHealthyStatus(port);
    sensitive.push(browserDeviceId);
    phase("pairing: healthy");

    const markers = createMarkers();
    await checkMarkers(port, markers, "seed");
    phase("partition: markers seeded");
    await leaveCtoxMode(port);
    // Mark the revocation barrier before invoking the CLI. A non-zero/timeout
    // result is ambiguous: the native store may already have accepted the
    // write, so cleanup must still issue and verify an idempotent unrevoke.
    state = transitionLifecycle(state, "revoked");
    runCtox(args, ["business-os", "peer", "revoke", browserDeviceId]);
    phase("revocation: applied");

    await enterCtoxAndSelectImportedPairing(port);
    await waitForPersistentRevocation(port);
    phase("revocation: guest remained unhealthy");
    await leaveCtoxMode(port);
    runCtox(args, ["business-os", "peer", "unrevoke", browserDeviceId]);
    state = transitionLifecycle(state, "unrevoked");
    phase("revocation: removed");

    await recover();
    if (!state.recovered) throw new Error("guest did not recover after peer unrevoke");
    phase("recovery: healthy");
    await removePairing();
    instanceId = completedInstanceId(await callBridge(port, "importInvite", [invite]));
    state = transitionLifecycle(state, "paired");
    await enterCtoxAndSelectImportedPairing(port);
    await waitForGuestHostReady(port);
    await waitForHealthyStatus(port);
    await checkMarkers(port, markers, "absent");
    phase("partition: removal verified");
    await removePairing();
    phase("result: passed");
  } catch (error) {
    primaryError = error;
  } finally {
    // A successful revoke creates a strict barrier before pairing/profile cleanup.
    if (state.revoked && !state.unrevoked && browserDeviceId !== undefined) {
      try {
        runCtox(args, ["business-os", "peer", "unrevoke", browserDeviceId]);
        state = transitionLifecycle(state, "unrevoked");
        phase("cleanup: peer unrevoke verified");
      } catch {
        primaryError = new Error(
          "peer unrevoke cleanup failed; Workjet and smoke files were retained",
        );
      }
    }
    if (!state.revoked || state.unrevoked) {
      await recover();
      try {
        await removePairing();
      } catch (error) {
        if (primaryError === undefined) primaryError = error;
      }
      if (child !== undefined) {
        await stopProcess(child);
        state = transitionLifecycle(state, "workjetStopped");
      }
      try {
        NodeFS.rmSync(args.smokeRoot, { recursive: true, force: true });
        state = transitionLifecycle(state, "temporaryFilesDeleted");
      } catch (error) {
        if (primaryError === undefined) primaryError = error;
      }
    }
  }
  if (primaryError !== undefined) {
    const message = primaryError instanceof Error ? primaryError.message : "unknown failure";
    throw new Error(redactSensitive(message, sensitive));
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href;
if (isMain) {
  const onSignal = (signal: string): void => {
    interruptedSignal = signal;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`result: failed: ${redactSensitive(message)}\n`);
    process.exitCode = 1;
  });
}
