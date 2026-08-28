import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../../config.ts";
import * as NativeProcess from "./WebStackNativeProcess.ts";

export const WEB_STACK_BROWSER_SURFACE_VERSION = "workjet-web-stack-browser-json-v1\n";
export const WEB_STACK_BROWSER_ACTION_LIMIT = 32;
export const WEB_STACK_BROWSER_OBSERVATION_LIMIT = 200;
export const WEB_STACK_BROWSER_URL_MAX_CHARS = 8_000;
export const WEB_STACK_BROWSER_TARGET_MAX_CHARS = 2_000;
export const WEB_STACK_BROWSER_ROLE_MAX_CHARS = 200;
export const WEB_STACK_BROWSER_VALUE_MAX_CHARS = 8_000;
export const WEB_STACK_BROWSER_KEY_MAX_CHARS = 200;
export const WEB_STACK_BROWSER_DESCRIPTION_MAX_CHARS = 8_000;
export const WEB_STACK_BROWSER_MIN_TIMEOUT_MS = 1_000;
export const WEB_STACK_BROWSER_MAX_TIMEOUT_MS = 300_000;

const WEB_STACK_BROWSER_PROBE_TIMEOUT = Duration.seconds(10);
const WEB_STACK_BROWSER_PREPARE_TIMEOUT = Duration.minutes(5);
const WEB_STACK_BROWSER_STARTUP_ALLOWANCE_MS = 60_000;

export const WebStackBrowserFailureReason = Schema.Literals([
  "binary-unavailable",
  "version-mismatch",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "execution-failed",
]);
export type WebStackBrowserFailureReason = typeof WebStackBrowserFailureReason.Type;

export class WebStackBrowserError extends Schema.TaggedErrorClass<WebStackBrowserError>()(
  "WebStackBrowserError",
  { reason: WebStackBrowserFailureReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "binary-unavailable":
        return "Web Browser is unavailable on this server.";
      case "version-mismatch":
        return "The installed Web Browser runtime is incompatible.";
      case "timeout":
        return "Web Browser timed out.";
      case "malformed-response":
      case "oversized-response":
        return "Web Browser returned an invalid response.";
      case "process-exit":
      case "execution-failed":
        return "Web Browser failed.";
    }
  }
}

export type BrowserTarget =
  | { readonly selector: string }
  | { readonly testId: string }
  | { readonly role: string; readonly name: string }
  | { readonly label: string }
  | { readonly placeholder: string }
  | { readonly text: string };

export type BrowserAction =
  | { readonly action: "navigate"; readonly url: string }
  | { readonly action: "observe" }
  | { readonly action: "click"; readonly target: BrowserTarget }
  | { readonly action: "fill"; readonly target: BrowserTarget; readonly value: string }
  | { readonly action: "press"; readonly target: BrowserTarget; readonly key: string };

export interface BrowserAutomationInput {
  readonly actions: ReadonlyArray<BrowserAction>;
  readonly timeoutMs?: number;
}

export interface BrowserPrepareInput {
  readonly installReference?: boolean;
  readonly installBrowser?: boolean;
}

export type BrowserPrepareReason =
  | "ready"
  | "runtime-unavailable"
  | "dependency-missing"
  | "browser-missing"
  | "not-ready";

export interface BrowserPrepareResult {
  readonly ready: boolean;
  readonly dependencyInstalled: boolean;
  readonly browserInstalled: boolean;
  readonly installAttempted: boolean;
  readonly dependencyInstallRan: boolean;
  readonly browserInstallRan: boolean;
  readonly reason: BrowserPrepareReason;
}

export interface BrowserObservation {
  readonly description: string;
  readonly url?: string;
}

export interface BrowserAutomationResult {
  readonly observations: ReadonlyArray<BrowserObservation>;
}

export interface WebStackBrowserShape {
  readonly prepare: (
    input: BrowserPrepareInput,
  ) => Effect.Effect<BrowserPrepareResult, WebStackBrowserError>;
  readonly automate: (
    input: BrowserAutomationInput,
  ) => Effect.Effect<BrowserAutomationResult, WebStackBrowserError>;
}

export class WebStackBrowser extends Context.Service<WebStackBrowser, WebStackBrowserShape>()(
  "t3/mcp/toolkits/workjet/WebStackBrowser",
) {}

const failure = (reason: WebStackBrowserFailureReason): WebStackBrowserError =>
  new WebStackBrowserError({ reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeEffect(JsonText);
const encodeJsonText = Schema.encodeSync(JsonText);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const boundedString = (value: unknown, maximum: number, allowEmpty = false): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.trim().length > 0) &&
  Array.from(value).length <= maximum;

const decodeTarget = (value: unknown): BrowserTarget | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    hasExactKeys(value, ["selector"]) &&
    boundedString(value.selector, WEB_STACK_BROWSER_TARGET_MAX_CHARS)
  ) {
    return { selector: value.selector };
  }
  if (
    hasExactKeys(value, ["testId"]) &&
    boundedString(value.testId, WEB_STACK_BROWSER_TARGET_MAX_CHARS)
  ) {
    return { testId: value.testId };
  }
  if (
    hasExactKeys(value, ["role", "name"]) &&
    boundedString(value.role, WEB_STACK_BROWSER_ROLE_MAX_CHARS) &&
    boundedString(value.name, WEB_STACK_BROWSER_TARGET_MAX_CHARS)
  ) {
    return { role: value.role, name: value.name };
  }
  if (
    hasExactKeys(value, ["label"]) &&
    boundedString(value.label, WEB_STACK_BROWSER_TARGET_MAX_CHARS)
  ) {
    return { label: value.label };
  }
  if (
    hasExactKeys(value, ["placeholder"]) &&
    boundedString(value.placeholder, WEB_STACK_BROWSER_TARGET_MAX_CHARS)
  ) {
    return { placeholder: value.placeholder };
  }
  if (
    hasExactKeys(value, ["text"]) &&
    boundedString(value.text, WEB_STACK_BROWSER_TARGET_MAX_CHARS)
  ) {
    return { text: value.text };
  }
  return undefined;
};

const decodeAction = (value: unknown): BrowserAction | undefined => {
  if (!isRecord(value) || typeof value.action !== "string") return undefined;
  switch (value.action) {
    case "navigate":
      return hasExactKeys(value, ["action", "url"]) &&
        boundedString(value.url, WEB_STACK_BROWSER_URL_MAX_CHARS)
        ? { action: "navigate", url: value.url }
        : undefined;
    case "observe":
      return hasExactKeys(value, ["action"]) ? { action: "observe" } : undefined;
    case "click": {
      const target = decodeTarget(value.target);
      return hasExactKeys(value, ["action", "target"]) && target
        ? { action: "click", target }
        : undefined;
    }
    case "fill": {
      const target = decodeTarget(value.target);
      return hasExactKeys(value, ["action", "target", "value"]) &&
        target &&
        boundedString(value.value, WEB_STACK_BROWSER_VALUE_MAX_CHARS, true)
        ? { action: "fill", target, value: value.value }
        : undefined;
    }
    case "press": {
      const target = decodeTarget(value.target);
      return hasExactKeys(value, ["action", "target", "key"]) &&
        target &&
        boundedString(value.key, WEB_STACK_BROWSER_KEY_MAX_CHARS)
        ? { action: "press", target, key: value.key }
        : undefined;
    }
    default:
      return undefined;
  }
};

export const decodeBrowserAutomationInput = (
  value: unknown,
): BrowserAutomationInput | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, ["actions"], ["timeoutMs"])) return undefined;
  if (
    !Array.isArray(value.actions) ||
    value.actions.length < 1 ||
    value.actions.length > WEB_STACK_BROWSER_ACTION_LIMIT
  ) {
    return undefined;
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < WEB_STACK_BROWSER_MIN_TIMEOUT_MS ||
      (value.timeoutMs as number) > WEB_STACK_BROWSER_MAX_TIMEOUT_MS)
  ) {
    return undefined;
  }
  const actions = value.actions.map(decodeAction);
  if (actions.some((action) => action === undefined)) return undefined;
  return {
    actions: actions as Array<BrowserAction>,
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
};

export const decodeBrowserPrepareInput = (value: unknown): BrowserPrepareInput | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, [], ["installReference", "installBrowser"])) {
    return undefined;
  }
  if (
    (value.installReference !== undefined && typeof value.installReference !== "boolean") ||
    (value.installBrowser !== undefined && typeof value.installBrowser !== "boolean")
  ) {
    return undefined;
  }
  return {
    ...(typeof value.installReference === "boolean"
      ? { installReference: value.installReference }
      : {}),
    ...(typeof value.installBrowser === "boolean" ? { installBrowser: value.installBrowser } : {}),
  };
};

const parseJsonResponse = (
  output: NativeProcess.ProcessOutput,
): Effect.Effect<Record<string, unknown>, WebStackBrowserError> => {
  if (output.stdout.totalBytes > NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES) {
    return Effect.fail(failure("oversized-response"));
  }
  if (output.exitCode !== 0) return Effect.fail(failure("process-exit"));
  return decodeJsonText(NativeProcess.outputText(output.stdout)).pipe(
    Effect.mapError(() => failure("malformed-response")),
    Effect.flatMap((value) =>
      isRecord(value) && value.ok === true
        ? Effect.succeed(value)
        : Effect.fail(failure("malformed-response")),
    ),
  );
};

const PREPARE_REASONS = new Set<BrowserPrepareReason>([
  "ready",
  "runtime-unavailable",
  "dependency-missing",
  "browser-missing",
  "not-ready",
]);

const parsePrepareResponse = (
  output: NativeProcess.ProcessOutput,
): Effect.Effect<BrowserPrepareResult, WebStackBrowserError> =>
  parseJsonResponse(output).pipe(
    Effect.flatMap((value) => {
      const reason = value.reason;
      if (
        typeof value.ready !== "boolean" ||
        typeof value.dependencyInstalled !== "boolean" ||
        typeof value.browserInstalled !== "boolean" ||
        typeof value.installAttempted !== "boolean" ||
        typeof value.dependencyInstallRan !== "boolean" ||
        typeof value.browserInstallRan !== "boolean" ||
        typeof reason !== "string" ||
        !PREPARE_REASONS.has(reason as BrowserPrepareReason)
      ) {
        return Effect.fail(failure("malformed-response"));
      }
      return Effect.succeed({
        ready: value.ready,
        dependencyInstalled: value.dependencyInstalled,
        browserInstalled: value.browserInstalled,
        installAttempted: value.installAttempted,
        dependencyInstallRan: value.dependencyInstallRan,
        browserInstallRan: value.browserInstallRan,
        reason: reason as BrowserPrepareReason,
      });
    }),
  );

const truncateChars = (value: string, maximum: number): string =>
  Array.from(value).slice(0, maximum).join("");

const parseAutomationResponse = (
  output: NativeProcess.ProcessOutput,
): Effect.Effect<BrowserAutomationResult, WebStackBrowserError> =>
  parseJsonResponse(output).pipe(
    Effect.flatMap((value) => {
      if (!Array.isArray(value.observations)) {
        return Effect.fail(failure("malformed-response"));
      }
      const observations: Array<BrowserObservation> = [];
      for (const item of value.observations.slice(0, WEB_STACK_BROWSER_OBSERVATION_LIMIT)) {
        if (
          !isRecord(item) ||
          typeof item.description !== "string" ||
          item.description.length === 0
        ) {
          return Effect.fail(failure("malformed-response"));
        }
        if (item.url !== undefined && typeof item.url !== "string") {
          return Effect.fail(failure("malformed-response"));
        }
        observations.push({
          description: truncateChars(item.description, WEB_STACK_BROWSER_DESCRIPTION_MAX_CHARS),
          ...(typeof item.url === "string"
            ? { url: truncateChars(item.url, WEB_STACK_BROWSER_URL_MAX_CHARS) }
            : {}),
        });
      }
      return Effect.succeed({ observations });
    }),
  );

const makeWithOptions = Effect.fn("WebStackBrowser.make")(function* (options: {
  readonly stateDir: string;
  readonly runtime: NativeProcess.WebStackRuntimeBoundary;
  readonly probeTimeout?: Duration.Duration;
  readonly prepareTimeout?: Duration.Duration;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stateRoot = NativeProcess.webStackStateRoot(options.stateDir);
  const runNative = NativeProcess.makeProbedRunner({
    spawner,
    runtime: options.runtime,
    probeArgs: ["--browser-surface-version"],
    expectedSurfaceVersion: WEB_STACK_BROWSER_SURFACE_VERSION,
    probeTimeout: options.probeTimeout ?? WEB_STACK_BROWSER_PROBE_TIMEOUT,
    failure,
  });
  const ensureRoot = Effect.tryPromise({
    try: () => options.runtime.makeDirectory(stateRoot),
    catch: () => failure("execution-failed"),
  });

  const prepare: WebStackBrowserShape["prepare"] = Effect.fn("WebStackBrowser.prepare")(
    function* (input) {
      yield* ensureRoot;
      const output = yield* runNative({
        args: ["browser-prepare", "--root", stateRoot],
        stdin: encodeJsonText({ request: input, config: {} }),
        maximumStdoutBytes: NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES,
        timeout: options.prepareTimeout ?? WEB_STACK_BROWSER_PREPARE_TIMEOUT,
      });
      return yield* parsePrepareResponse(output);
    },
  );

  const automate: WebStackBrowserShape["automate"] = Effect.fn("WebStackBrowser.automate")(
    function* (input) {
      yield* ensureRoot;
      const timeoutMs = Math.min(
        WEB_STACK_BROWSER_MAX_TIMEOUT_MS,
        Math.max(WEB_STACK_BROWSER_MIN_TIMEOUT_MS, input.timeoutMs ?? 30_000),
      );
      const output = yield* runNative({
        args: ["browser-automate", "--root", stateRoot],
        stdin: encodeJsonText({ request: { ...input, timeoutMs }, config: {} }),
        maximumStdoutBytes: NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES,
        timeout: Duration.millis(timeoutMs + WEB_STACK_BROWSER_STARTUP_ALLOWANCE_MS),
      });
      return yield* parseAutomationResponse(output);
    },
  );

  return WebStackBrowser.of({ prepare, automate });
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* makeWithOptions({
    stateDir: config.stateDir,
    runtime: NativeProcess.productionRuntime(),
  });
});

export const layer = Layer.effect(WebStackBrowser, make);

export const __testing = {
  make: makeWithOptions,
  parsePrepareResponse,
  parseAutomationResponse,
};
