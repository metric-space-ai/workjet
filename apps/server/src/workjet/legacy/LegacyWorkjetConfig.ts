/**
 * Reader for the legacy Swift Workjet application's configuration document.
 *
 * ## Where the source format comes from
 *
 * The Swift app is not in this repository, so the model below was derived from
 * the shipped artefacts on a machine that runs it, not from a specification:
 *
 *  - `~/Library/Application Support/Workjet/config.v1.json` — the live document
 *    plus six dated `…backup-v1-*` siblings. Every one carries `"version": 1`
 *    and the same top-level key set, so the shape is stable within v1.
 *  - `/Applications/Workjet.app/Contents/MacOS/WorkjetApp` (bundle id
 *    `dev.workjet.menubar`, 0.1.0) — its `CodingKeys` string tables list the
 *    complete key universe for the root document, computers, workers,
 *    invocations, providers and the CLIProxy block, plus the raw values of every
 *    persisted enum. Two keys in that universe (`computers[].remoteSetupIssue`,
 *    `providers[].loginExecutable`) do not occur in the live document at all,
 *    which is why "whatever the sample happens to contain" was not good enough.
 *
 * The reader is therefore written against an OBSERVED format, and it is
 * deliberately strict about it.
 *
 * ## Fail closed vs. surface
 *
 * Two different kinds of surprise get two different answers:
 *
 *  - An unknown SHAPE fails the read: a non-object document, a missing or
 *    unsupported `version`, a value of the wrong type, or an enum value outside
 *    the raw values the Swift binary can emit. None of those can be mapped onto
 *    the Workjet contract without guessing, and the Swift app itself refuses an
 *    unsupported version rather than rewriting it.
 *  - An unknown FIELD does not fail the read, but it can never vanish either.
 *    Every key present in the document and absent from the model below is
 *    reported by path in `unknownFields`, and the mapping turns each one into a
 *    visible decision. A newer Swift build that adds a field must not make the
 *    import impossible; it must make the field impossible to overlook.
 *
 * Nothing here touches a file: the caller supplies the text. The legacy document
 * is only ever read, never modified.
 */

/** The only configuration version this reader accepts. */
export const LEGACY_WORKJET_CONFIG_VERSION = 1;

/** File name the Swift app writes inside its application-support directory. */
export const LEGACY_WORKJET_CONFIG_FILE_NAME = "config.v1.json";

/**
 * Directory the Swift app keeps its configuration in, relative to the user's
 * home directory. Taken from the binary's own path strings.
 */
export const LEGACY_WORKJET_CONFIG_RELATIVE_DIR = "Library/Application Support/Workjet";

export const LEGACY_TRANSPORTS = ["Lokal", "Tailscale", "SSH"] as const;
export type LegacyWorkjetTransport = (typeof LEGACY_TRANSPORTS)[number];

export const LEGACY_HARNESSES = [
  "Claude Code",
  "Pi Code",
  "Codex CLI",
  "Cursor Agent",
  "OpenCode",
  "Grok CLI",
] as const;
export type LegacyWorkjetHarness = (typeof LEGACY_HARNESSES)[number];

export const LEGACY_PROVIDER_KINDS = ["Direkte API", "CLIProxyAPI"] as const;
export type LegacyWorkjetProviderKind = (typeof LEGACY_PROVIDER_KINDS)[number];

/**
 * `""` is what the Swift app persists for "automatic"; the remaining values are
 * the raw values of its reasoning-effort enum, in binary order.
 */
export const LEGACY_REASONING_EFFORTS = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
  "ultrathink",
] as const;
export type LegacyWorkjetReasoningEffort = (typeof LEGACY_REASONING_EFFORTS)[number];

export const LEGACY_SKILL_ACTIVATIONS = ["Global", "Skill (/workjet)"] as const;
export type LegacyWorkjetSkillActivation = (typeof LEGACY_SKILL_ACTIVATIONS)[number];

/**
 * Probe state. The payload is intentionally not modelled: the whole field is
 * dropped by the mapping (the provider gateway owns health and capacity now),
 * so only the variant is read, and only so the drop can be named in the report.
 */
export interface LegacyWorkjetCapacity {
  readonly variant: "observed" | "unavailable";
}

export interface LegacyWorkjetComputer {
  readonly id: string;
  readonly name: string;
  readonly transport: LegacyWorkjetTransport;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly sandboxEnabled: boolean;
  readonly pinnedSidecarVersion: string;
  readonly telemetryEnabled: boolean;
  readonly sidecarBundlePath: string;
  readonly deploymentStatus: string;
  readonly deploymentDetail: string;
  readonly remoteSetupIssue?: string | undefined;
  readonly installedContentHash?: string | undefined;
  readonly installedSidecarVersion?: string | undefined;
  readonly knownHostsPath: string;
  readonly identityFilePath: string;
  readonly tailscaleSSHEnabled?: boolean | undefined;
  readonly tailscaleExecutablePath?: string | undefined;
  readonly bubblewrapExecutablePath?: string | undefined;
  readonly lastSuccessfulPreflightAt?: number | undefined;
  readonly lastSuccessfulDeploymentAt?: number | undefined;
}

export interface LegacyWorkjetInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly capabilities: readonly string[];
  readonly options: Readonly<Record<string, string>>;
}

export interface LegacyWorkjetWorker {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly instructions: string;
  readonly reasoningEffort: LegacyWorkjetReasoningEffort;
  readonly harness: LegacyWorkjetHarness;
  readonly computerID: string;
  /** At most one of `providerID` / `providerPool` is set. */
  readonly providerID?: string | undefined;
  readonly providerPool?: string | undefined;
  readonly skillOverrides: Readonly<Record<string, boolean>>;
  readonly invocation: LegacyWorkjetInvocation;
  readonly capacity?: LegacyWorkjetCapacity | undefined;
}

export interface LegacyWorkjetProvider {
  readonly id: string;
  readonly name: string;
  readonly credentialReference: string;
  readonly kind: LegacyWorkjetProviderKind;
  readonly endpoint: string;
  readonly authentication: string;
  readonly modelProvider: string;
  readonly accountLabel?: string | undefined;
  readonly externalCredentialID?: string | undefined;
  readonly modelIDs: readonly string[];
  readonly status: string;
  readonly statusDetail: string;
  readonly loginExecutable?: string | undefined;
  readonly loginArguments: readonly string[];
  readonly routingPriority: number;
  readonly capacity?: LegacyWorkjetCapacity | undefined;
}

export interface LegacyWorkjetCliProxy {
  readonly endpoint: string;
  readonly inferenceCredentialReference?: string | undefined;
  readonly managementCredentialReference?: string | undefined;
  readonly usageStatisticsEnabled: boolean;
}

export interface LegacyWorkjetConfig {
  readonly version: typeof LEGACY_WORKJET_CONFIG_VERSION;
  readonly workers: readonly LegacyWorkjetWorker[];
  readonly computers: readonly LegacyWorkjetComputer[];
  readonly providers: readonly LegacyWorkjetProvider[];
  readonly selectedComputerID: string;
  readonly skillRules: string;
  readonly skillLoaderInstructions: string;
  readonly modelPrompts: Readonly<Record<string, string>>;
  readonly progressBoardRules: string;
  readonly adHocLearnings: string;
  readonly technicalRules: string;
  readonly transparentWorkerPromptsMigrated: boolean;
  readonly skillActivation: LegacyWorkjetSkillActivation;
  readonly injectWorkerDeclarations: boolean;
  readonly telemetryClaudeCodeEvents: boolean;
  readonly telemetrySidecarEvents: boolean;
  readonly telemetryRetentionDays: number;
  readonly providerSlots: number;
  readonly probeTimeoutSeconds: number;
  readonly turnTimeoutSeconds: number;
  readonly degradationAllowed: boolean;
  readonly cliProxy: LegacyWorkjetCliProxy;
}

export type LegacyWorkjetReadFailureReason =
  /** The text is not JSON at all. */
  | "not-json"
  /** The document is not a JSON object. */
  | "not-an-object"
  /** No `version` key. The Swift app reports "Versionsfeld fehlt" for this. */
  | "missing-version"
  /** A `version` this reader was not written against. Never rewritten. */
  | "unsupported-version"
  /** A declared key holds a value of the wrong type. */
  | "invalid-type"
  /** A declared enum key holds a raw value the Swift app cannot emit. */
  | "invalid-enum";

export interface LegacyWorkjetReadFailure {
  readonly reason: LegacyWorkjetReadFailureReason;
  /** Dotted/indexed path of the offending value, `"<document>"` for the root. */
  readonly path: string;
  /** Human-readable detail. Never contains a field value. */
  readonly detail: string;
}

export type LegacyWorkjetReadResult =
  | { readonly _tag: "unreadable"; readonly failure: LegacyWorkjetReadFailure }
  | {
      readonly _tag: "read";
      readonly config: LegacyWorkjetConfig;
      /**
       * Paths of keys present in the document that this reader does not model,
       * sorted so a report never depends on JSON key order.
       */
      readonly unknownFields: readonly string[];
    };

const ROOT_PATH = "<document>";

const ROOT_KEYS = [
  "version",
  "workers",
  "computers",
  "providers",
  "selectedComputerID",
  "skillRules",
  "skillLoaderInstructions",
  "modelPrompts",
  "progressBoardRules",
  "adHocLearnings",
  "technicalRules",
  "transparentWorkerPromptsMigrated",
  "skillActivation",
  "injectWorkerDeclarations",
  "telemetryClaudeCodeEvents",
  "telemetrySidecarEvents",
  "telemetryRetentionDays",
  "providerSlots",
  "probeTimeoutSeconds",
  "turnTimeoutSeconds",
  "degradationAllowed",
  "cliProxy",
] as const;

const COMPUTER_KEYS = [
  "id",
  "name",
  "transport",
  "host",
  "user",
  "port",
  "sandboxEnabled",
  "pinnedSidecarVersion",
  "telemetryEnabled",
  "sidecarBundlePath",
  "deploymentStatus",
  "deploymentDetail",
  "remoteSetupIssue",
  "installedContentHash",
  "installedSidecarVersion",
  "knownHostsPath",
  "identityFilePath",
  "tailscaleSSHEnabled",
  "tailscaleExecutablePath",
  "bubblewrapExecutablePath",
  "lastSuccessfulPreflightAt",
  "lastSuccessfulDeploymentAt",
] as const;

const WORKER_KEYS = [
  "id",
  "name",
  "model",
  "instructions",
  "reasoningEffort",
  "harness",
  "computerID",
  "providerID",
  "providerPool",
  "skillOverrides",
  "invocation",
  "capacity",
] as const;

const INVOCATION_KEYS = ["executable", "arguments", "capabilities", "options"] as const;

const PROVIDER_KEYS = [
  "id",
  "name",
  "credentialReference",
  "kind",
  "endpoint",
  "authentication",
  "modelProvider",
  "accountLabel",
  "externalCredentialID",
  "modelIDs",
  "status",
  "statusDetail",
  "loginExecutable",
  "loginArguments",
  "routingPriority",
  "capacity",
] as const;

const CLI_PROXY_KEYS = [
  "endpoint",
  "inferenceCredentialReference",
  "managementCredentialReference",
  "usageStatisticsEnabled",
] as const;

const CAPACITY_KEYS = ["observed", "unavailable"] as const;

const CONTAINER_ROOT_KEYS: readonly string[] = ["workers", "computers", "providers", "cliProxy"];

/**
 * Every leaf field this reader models, in a stable, sorted, collection-agnostic
 * notation (`computers[].host`). The mapping table is asserted against this list
 * so a field added here without a mapping decision fails a test rather than
 * disappearing from an import.
 */
export const LEGACY_WORKJET_FIELD_PATHS: readonly string[] = [
  ...ROOT_KEYS.filter((key) => !CONTAINER_ROOT_KEYS.includes(key)),
  ...COMPUTER_KEYS.map((key) => `computers[].${key}`),
  ...WORKER_KEYS.filter((key) => key !== "invocation").map((key) => `workers[].${key}`),
  ...INVOCATION_KEYS.map((key) => `workers[].invocation.${key}`),
  ...PROVIDER_KEYS.map((key) => `providers[].${key}`),
  ...CLI_PROXY_KEYS.map((key) => `cliProxy.${key}`),
].sort();

/**
 * Mutable accumulator threaded through the readers. The first failure wins and
 * short-circuits every later read, so the caller gets one precise cause instead
 * of a cascade. While a failure is pending the scalar readers hand back inert
 * placeholders; those never escape, because a pending failure always turns the
 * whole read into `unreadable`.
 */
interface ReadState {
  failure: LegacyWorkjetReadFailure | undefined;
  readonly unknownFields: string[];
}

const record = (
  state: ReadState,
  reason: LegacyWorkjetReadFailureReason,
  path: string,
  detail: string,
): void => {
  state.failure ??= { reason, path, detail };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const child = (path: string, key: string): string => (path === ROOT_PATH ? key : `${path}.${key}`);

/**
 * Validate object-ness and record every key outside `declaredKeys`. Returns
 * `undefined` once a failure has been recorded, so callers can stop.
 */
const readObject = (
  state: ReadState,
  value: unknown,
  path: string,
  declaredKeys: readonly string[],
): Record<string, unknown> | undefined => {
  if (state.failure !== undefined) return undefined;
  if (!isPlainObject(value)) {
    record(state, "not-an-object", path, "expected an object");
    return undefined;
  }
  const declared = new Set<string>(declaredKeys);
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) state.unknownFields.push(child(path, key));
  }
  return value;
};

const readString = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): string => {
  if (state.failure !== undefined) return "";
  const value = owner[key];
  if (typeof value === "string") return value;
  record(state, "invalid-type", child(path, key), "expected a string");
  return "";
};

const readOptionalString = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): string | undefined => {
  if (state.failure !== undefined || owner[key] === undefined) return undefined;
  return readString(state, owner, path, key);
};

const readBoolean = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): boolean => {
  if (state.failure !== undefined) return false;
  const value = owner[key];
  if (typeof value === "boolean") return value;
  record(state, "invalid-type", child(path, key), "expected a boolean");
  return false;
};

const readOptionalBoolean = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): boolean | undefined => {
  if (state.failure !== undefined || owner[key] === undefined) return undefined;
  return readBoolean(state, owner, path, key);
};

const readNumber = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): number => {
  if (state.failure !== undefined) return 0;
  const value = owner[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  record(state, "invalid-type", child(path, key), "expected a finite number");
  return 0;
};

const readOptionalNumber = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): number | undefined => {
  if (state.failure !== undefined || owner[key] === undefined) return undefined;
  return readNumber(state, owner, path, key);
};

const readEnum = <Value extends string>(
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
  allowed: readonly [Value, ...Value[]],
): Value => {
  if (state.failure !== undefined) return allowed[0];
  const value = owner[key];
  if (typeof value !== "string") {
    record(state, "invalid-type", child(path, key), "expected a string");
    return allowed[0];
  }
  if (!(allowed as readonly string[]).includes(value)) {
    record(
      state,
      "invalid-enum",
      child(path, key),
      `expected one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`,
    );
    return allowed[0];
  }
  return value as Value;
};

const readStringArray = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): readonly string[] => {
  if (state.failure !== undefined) return [];
  const value = owner[key];
  if (!Array.isArray(value)) {
    record(state, "invalid-type", child(path, key), "expected an array of strings");
    return [];
  }
  const entries: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      record(state, "invalid-type", `${child(path, key)}[${index}]`, "expected a string");
      return [];
    }
    entries.push(entry);
  }
  return entries;
};

/**
 * Read a homogeneous record. Keys are data here, not schema, so an unexpected
 * key is not an unknown field — but an unexpected VALUE type still fails.
 */
const readHomogeneousRecord = <Value>(
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
  valueType: "string" | "boolean",
): Readonly<Record<string, Value>> => {
  if (state.failure !== undefined) return {};
  const value = owner[key];
  if (!isPlainObject(value)) {
    record(state, "not-an-object", child(path, key), "expected an object");
    return {};
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== valueType) {
      record(state, "invalid-type", `${child(path, key)}.${entryKey}`, `expected a ${valueType}`);
      return {};
    }
  }
  return value as Readonly<Record<string, Value>>;
};

const readCapacity = (
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
): LegacyWorkjetCapacity | undefined => {
  if (state.failure !== undefined || owner[key] === undefined) return undefined;
  const envelope = readObject(state, owner[key], child(path, key), CAPACITY_KEYS);
  if (envelope === undefined) return undefined;
  // Swift encodes an enum with associated values as a single-key object. Any
  // unrecognized key was already recorded as an unknown field by readObject; a
  // variant we do know must still be present, or the shape is not a capacity.
  const variant = CAPACITY_KEYS.find((candidate) => envelope[candidate] !== undefined);
  if (variant === undefined) {
    record(
      state,
      "invalid-enum",
      child(path, key),
      `expected one of ${CAPACITY_KEYS.map((entry) => JSON.stringify(entry)).join(", ")}`,
    );
    return undefined;
  }
  return { variant };
};

const readArrayOf = <Value>(
  state: ReadState,
  owner: Record<string, unknown>,
  path: string,
  key: string,
  readEntry: (state: ReadState, entry: unknown, entryPath: string) => Value | undefined,
): readonly Value[] => {
  if (state.failure !== undefined) return [];
  const value = owner[key];
  if (!Array.isArray(value)) {
    record(state, "invalid-type", child(path, key), "expected an array");
    return [];
  }
  const entries: Value[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = readEntry(state, entry, `${child(path, key)}[${index}]`);
    if (parsed === undefined) return [];
    entries.push(parsed);
  }
  return entries;
};

const readComputer = (
  state: ReadState,
  value: unknown,
  path: string,
): LegacyWorkjetComputer | undefined => {
  const raw = readObject(state, value, path, COMPUTER_KEYS);
  if (raw === undefined) return undefined;
  const computer: LegacyWorkjetComputer = {
    id: readString(state, raw, path, "id"),
    name: readString(state, raw, path, "name"),
    transport: readEnum(state, raw, path, "transport", LEGACY_TRANSPORTS),
    host: readString(state, raw, path, "host"),
    user: readString(state, raw, path, "user"),
    port: readNumber(state, raw, path, "port"),
    sandboxEnabled: readBoolean(state, raw, path, "sandboxEnabled"),
    pinnedSidecarVersion: readString(state, raw, path, "pinnedSidecarVersion"),
    telemetryEnabled: readBoolean(state, raw, path, "telemetryEnabled"),
    sidecarBundlePath: readString(state, raw, path, "sidecarBundlePath"),
    deploymentStatus: readString(state, raw, path, "deploymentStatus"),
    deploymentDetail: readString(state, raw, path, "deploymentDetail"),
    remoteSetupIssue: readOptionalString(state, raw, path, "remoteSetupIssue"),
    installedContentHash: readOptionalString(state, raw, path, "installedContentHash"),
    installedSidecarVersion: readOptionalString(state, raw, path, "installedSidecarVersion"),
    knownHostsPath: readString(state, raw, path, "knownHostsPath"),
    identityFilePath: readString(state, raw, path, "identityFilePath"),
    tailscaleSSHEnabled: readOptionalBoolean(state, raw, path, "tailscaleSSHEnabled"),
    tailscaleExecutablePath: readOptionalString(state, raw, path, "tailscaleExecutablePath"),
    bubblewrapExecutablePath: readOptionalString(state, raw, path, "bubblewrapExecutablePath"),
    lastSuccessfulPreflightAt: readOptionalNumber(state, raw, path, "lastSuccessfulPreflightAt"),
    lastSuccessfulDeploymentAt: readOptionalNumber(state, raw, path, "lastSuccessfulDeploymentAt"),
  };
  return state.failure === undefined ? computer : undefined;
};

const EMPTY_INVOCATION: LegacyWorkjetInvocation = {
  executable: "",
  arguments: [],
  capabilities: [],
  options: {},
};

const readInvocation = (
  state: ReadState,
  value: unknown,
  path: string,
): LegacyWorkjetInvocation => {
  const raw = readObject(state, value, path, INVOCATION_KEYS);
  if (raw === undefined) return EMPTY_INVOCATION;
  return {
    executable: readString(state, raw, path, "executable"),
    arguments: readStringArray(state, raw, path, "arguments"),
    capabilities: readStringArray(state, raw, path, "capabilities"),
    options: readHomogeneousRecord<string>(state, raw, path, "options", "string"),
  };
};

const readWorker = (
  state: ReadState,
  value: unknown,
  path: string,
): LegacyWorkjetWorker | undefined => {
  const raw = readObject(state, value, path, WORKER_KEYS);
  if (raw === undefined) return undefined;
  const worker: LegacyWorkjetWorker = {
    id: readString(state, raw, path, "id"),
    name: readString(state, raw, path, "name"),
    model: readString(state, raw, path, "model"),
    instructions: readString(state, raw, path, "instructions"),
    reasoningEffort: readEnum(state, raw, path, "reasoningEffort", LEGACY_REASONING_EFFORTS),
    harness: readEnum(state, raw, path, "harness", LEGACY_HARNESSES),
    computerID: readString(state, raw, path, "computerID"),
    providerID: readOptionalString(state, raw, path, "providerID"),
    providerPool: readOptionalString(state, raw, path, "providerPool"),
    skillOverrides: readHomogeneousRecord<boolean>(state, raw, path, "skillOverrides", "boolean"),
    invocation: readInvocation(state, raw["invocation"], child(path, "invocation")),
    capacity: readCapacity(state, raw, path, "capacity"),
  };
  return state.failure === undefined ? worker : undefined;
};

const readProvider = (
  state: ReadState,
  value: unknown,
  path: string,
): LegacyWorkjetProvider | undefined => {
  const raw = readObject(state, value, path, PROVIDER_KEYS);
  if (raw === undefined) return undefined;
  const provider: LegacyWorkjetProvider = {
    id: readString(state, raw, path, "id"),
    name: readString(state, raw, path, "name"),
    credentialReference: readString(state, raw, path, "credentialReference"),
    kind: readEnum(state, raw, path, "kind", LEGACY_PROVIDER_KINDS),
    endpoint: readString(state, raw, path, "endpoint"),
    authentication: readString(state, raw, path, "authentication"),
    modelProvider: readString(state, raw, path, "modelProvider"),
    accountLabel: readOptionalString(state, raw, path, "accountLabel"),
    externalCredentialID: readOptionalString(state, raw, path, "externalCredentialID"),
    modelIDs: readStringArray(state, raw, path, "modelIDs"),
    status: readString(state, raw, path, "status"),
    statusDetail: readString(state, raw, path, "statusDetail"),
    loginExecutable: readOptionalString(state, raw, path, "loginExecutable"),
    loginArguments: readStringArray(state, raw, path, "loginArguments"),
    routingPriority: readNumber(state, raw, path, "routingPriority"),
    capacity: readCapacity(state, raw, path, "capacity"),
  };
  return state.failure === undefined ? provider : undefined;
};

const EMPTY_CLI_PROXY: LegacyWorkjetCliProxy = { endpoint: "", usageStatisticsEnabled: false };

const readCliProxy = (state: ReadState, value: unknown, path: string): LegacyWorkjetCliProxy => {
  const raw = readObject(state, value, path, CLI_PROXY_KEYS);
  if (raw === undefined) return EMPTY_CLI_PROXY;
  return {
    endpoint: readString(state, raw, path, "endpoint"),
    inferenceCredentialReference: readOptionalString(
      state,
      raw,
      path,
      "inferenceCredentialReference",
    ),
    managementCredentialReference: readOptionalString(
      state,
      raw,
      path,
      "managementCredentialReference",
    ),
    usageStatisticsEnabled: readBoolean(state, raw, path, "usageStatisticsEnabled"),
  };
};

/**
 * Read an already-parsed legacy configuration document.
 *
 * Pure: no filesystem, no clock, no environment.
 */
export function readLegacyWorkjetConfig(document: unknown): LegacyWorkjetReadResult {
  if (!isPlainObject(document)) {
    return {
      _tag: "unreadable",
      failure: {
        reason: "not-an-object",
        path: ROOT_PATH,
        detail: "the configuration document is not a JSON object",
      },
    };
  }

  const rawVersion = document["version"];
  if (rawVersion === undefined) {
    return {
      _tag: "unreadable",
      failure: {
        reason: "missing-version",
        path: "version",
        detail: "the configuration document carries no version",
      },
    };
  }
  if (rawVersion !== LEGACY_WORKJET_CONFIG_VERSION) {
    return {
      _tag: "unreadable",
      failure: {
        reason: "unsupported-version",
        path: "version",
        detail: `only configuration version ${LEGACY_WORKJET_CONFIG_VERSION} is supported`,
      },
    };
  }

  const state: ReadState = { failure: undefined, unknownFields: [] };
  const raw = readObject(state, document, ROOT_PATH, ROOT_KEYS) ?? {};

  const config: LegacyWorkjetConfig = {
    version: LEGACY_WORKJET_CONFIG_VERSION,
    workers: readArrayOf(state, raw, ROOT_PATH, "workers", readWorker),
    computers: readArrayOf(state, raw, ROOT_PATH, "computers", readComputer),
    providers: readArrayOf(state, raw, ROOT_PATH, "providers", readProvider),
    selectedComputerID: readString(state, raw, ROOT_PATH, "selectedComputerID"),
    skillRules: readString(state, raw, ROOT_PATH, "skillRules"),
    skillLoaderInstructions: readString(state, raw, ROOT_PATH, "skillLoaderInstructions"),
    modelPrompts: readHomogeneousRecord<string>(state, raw, ROOT_PATH, "modelPrompts", "string"),
    progressBoardRules: readString(state, raw, ROOT_PATH, "progressBoardRules"),
    adHocLearnings: readString(state, raw, ROOT_PATH, "adHocLearnings"),
    technicalRules: readString(state, raw, ROOT_PATH, "technicalRules"),
    transparentWorkerPromptsMigrated: readBoolean(
      state,
      raw,
      ROOT_PATH,
      "transparentWorkerPromptsMigrated",
    ),
    skillActivation: readEnum(state, raw, ROOT_PATH, "skillActivation", LEGACY_SKILL_ACTIVATIONS),
    injectWorkerDeclarations: readBoolean(state, raw, ROOT_PATH, "injectWorkerDeclarations"),
    telemetryClaudeCodeEvents: readBoolean(state, raw, ROOT_PATH, "telemetryClaudeCodeEvents"),
    telemetrySidecarEvents: readBoolean(state, raw, ROOT_PATH, "telemetrySidecarEvents"),
    telemetryRetentionDays: readNumber(state, raw, ROOT_PATH, "telemetryRetentionDays"),
    providerSlots: readNumber(state, raw, ROOT_PATH, "providerSlots"),
    probeTimeoutSeconds: readNumber(state, raw, ROOT_PATH, "probeTimeoutSeconds"),
    turnTimeoutSeconds: readNumber(state, raw, ROOT_PATH, "turnTimeoutSeconds"),
    degradationAllowed: readBoolean(state, raw, ROOT_PATH, "degradationAllowed"),
    cliProxy: readCliProxy(state, raw["cliProxy"], "cliProxy"),
  };

  if (state.failure !== undefined) {
    return { _tag: "unreadable", failure: state.failure };
  }
  return { _tag: "read", config, unknownFields: [...state.unknownFields].sort() };
}

/** Parse and read. A parse error fails closed like any other unknown shape. */
export function parseLegacyWorkjetConfig(text: string): LegacyWorkjetReadResult {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return {
      _tag: "unreadable",
      failure: {
        reason: "not-json",
        path: ROOT_PATH,
        detail: "the configuration file is not valid JSON",
      },
    };
  }
  return readLegacyWorkjetConfig(document);
}
