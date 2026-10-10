// @effect-diagnostics nodeBuiltinImport:off -- Pure paths for the bounded worker loopback adapter.
import * as NodePath from "node:path";
import type { WorkjetHarness } from "@workjet/contracts";

export const WORKER_SOURCE_HARNESS_DRIVERS = {
  "claude-code": "claudeAgent",
  "codex-cli": "codex",
  "grok-cli": "grok",
  opencode: "opencode",
  greppy: "greppy",
  "minimax-code": "minimax",
  "pi-code": "pi",
} as const;

export const workerSourceDriver = (harness: WorkjetHarness | undefined) =>
  harness === undefined
    ? WORKER_SOURCE_HARNESS_DRIVERS["codex-cli"]
    : harness in WORKER_SOURCE_HARNESS_DRIVERS
      ? WORKER_SOURCE_HARNESS_DRIVERS[harness as keyof typeof WORKER_SOURCE_HARNESS_DRIVERS]
      : undefined;

export interface WorkerSourceNativeProfile {
  readonly harness: WorkjetHarness;
  readonly model: string;
  readonly provider?: string;
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<{ readonly name: string; readonly content: string }>;
}

/** Model comes from the source permit. This profile contains only that model and an ephemeral loopback key. */
export function workerSourceNativeProfile(input: {
  readonly harness: WorkjetHarness;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly directory: string;
}): WorkerSourceNativeProfile {
  const endpoint = new URL(input.baseUrl);
  if (
    workerSourceDriver(input.harness) === undefined ||
    !input.model.trim() ||
    !input.apiKey.trim() ||
    !NodePath.isAbsolute(input.directory) ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/v1"
  )
    throw new Error("Invalid source-only native harness profile");
  const root = input.baseUrl.slice(0, -3);
  const home = NodePath.join(input.directory, "home");
  const environment: Record<string, string> = {
    WORKJET_SOURCE_ISOLATED: "true",
    HOME: home,
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local/share"),
    XDG_CACHE_HOME: NodePath.join(home, ".cache"),
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    OPENAI_API_KEY: "",
    XAI_API_KEY: "",
    MINIMAX_API_KEY: "",
  };
  const common = {
    harness: input.harness,
    model: input.model,
    directory: input.directory,
    environment,
  };
  const files: { name: string; content: string }[] = [];
  switch (input.harness) {
    case "claude-code":
      Object.assign(environment, {
        ANTHROPIC_BASE_URL: root,
        ANTHROPIC_AUTH_TOKEN: input.apiKey,
        CLAUDE_CONFIG_DIR: NodePath.join(input.directory, "claude"),
      });
      break;
    case "grok-cli":
      Object.assign(environment, {
        GROK_MODELS_BASE_URL: input.baseUrl,
        XAI_API_KEY: input.apiKey,
      });
      break;
    case "greppy":
      Object.assign(environment, { GREPPY_ENDPOINT: root, GREPPY_API_KEY: input.apiKey });
      break;
    case "opencode":
      environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        enabled_providers: ["workjet-source"],
        provider: {
          "workjet-source": {
            npm: "@ai-sdk/openai",
            name: "Workjet source",
            options: { baseURL: input.baseUrl, apiKey: input.apiKey },
            models: { [input.model]: { name: input.model } },
          },
        },
      });
      return { ...common, model: `workjet-source/${input.model}`, files };
    case "minimax-code":
      environment.MINIMAX_DATA_DIR = input.directory;
      files.push({
        name: "config.yaml",
        content: JSON.stringify({
          defaultModel: `custom_provider:workjet-source/${input.model}`,
          custom_provider: {
            "workjet-source": {
              name: "Workjet source",
              kind: "custom",
              enabled: true,
              api: "anthropic-messages",
              options: { baseURL: root, apiKey: input.apiKey, authMode: "api-key" },
              models: { [input.model]: {} },
            },
          },
        }),
      });
      break;
    case "pi-code":
      environment.PI_CODING_AGENT_DIR = input.directory;
      files.push({
        name: "models.json",
        content: JSON.stringify({
          providers: {
            "workjet-source": {
              baseUrl: input.baseUrl,
              api: "openai-responses",
              apiKey: input.apiKey,
              models: [{ id: input.model, name: input.model }],
            },
          },
        }),
      });
      return { ...common, provider: "workjet-source", files };
    case "codex-cli":
      environment.WORKJET_WORKER_SOURCE_KEY = input.apiKey;
      break;
  }
  return { ...common, files };
}
