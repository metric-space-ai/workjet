import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetConnectionId,
  WorkjetHarness,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCapabilityContext } from "../workjet/ThreadCapabilityContext.ts";
import { setMcpProviderSession, clearAllMcpProviderSessions } from "../mcp/McpProviderSession.ts";
import {
  NO_MCP_SESSION_NOTE,
  clearWorkjetThreadTeam,
  ctoxTeamRole,
  readWorkjetManagedPrompt,
  setWorkjetThreadTeam,
  workjetTeamEnvironment,
} from "../mcp/WorkjetThreadTeam.ts";
import { HARNESS_MANAGED_PROMPT_HOOKS } from "./managedPromptHooks.ts";

const RULES = {
  supervisor: "Role rule (Supervisor)",
  persistent_worker: "Role rule (Persistent worker)",
  one_shot_worker: "Role rule (One-shot worker)",
  operator: "Role rule (Owner chat)",
} as const;

const connectionId = WorkjetConnectionId.make("ctox-connection");
const team = (role: "supervisor" | "specialist" | "worker") => ({
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make(`thread-${role}`),
  role,
  parentThreadId: role === "supervisor" ? null : ThreadId.make("parent"),
  ...(role === "worker" ? { packageId: "package" } : {}),
  ...(role === "specialist" ? { domain: "harness" } : {}),
  goal: "Deliver the outcome.",
  createdAt: "2026-10-14T09:00:00.000Z",
});

const config = (
  variant: "supervisor" | "specialist" | "worker" | "standard" | "legacy-worker",
  capabilities: ReadonlyArray<"greppy" | "web-search" | "ctox-business-os">,
): WorkjetThreadConfig =>
  ({
    schemaVersion: 2,
    role:
      variant === "standard" ? "standard" : variant === "supervisor" ? "orchestrator" : "worker",
    parent:
      variant === "standard" || variant === "supervisor"
        ? null
        : { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("parent") },
    managedInstructions: "",
    enabledCapabilityIds: [...capabilities],
    capabilityBindings: capabilities.includes("ctox-business-os")
      ? [
          {
            capabilityId: "ctox-business-os",
            target: { kind: "ctox-connection", connectionId, instanceId: "instance-1" },
          },
        ]
      : [],
    ctoxSession: null,
    ...(variant === "supervisor" || variant === "specialist" || variant === "worker"
      ? { team: team(variant) }
      : {}),
  }) as unknown as WorkjetThreadConfig;

const contextFor = (cfg: WorkjetThreadConfig) =>
  resolveThreadCapabilityContext(cfg, undefined, {
    knownConnectionIds: new Set([connectionId]),
    reachableConnectionIds: new Set([connectionId]),
    connectionInstances: new Map([[connectionId, "instance-1"]]),
  });

/** What the harness sends, read the way adapters read it (with or without MCP). */
const effective = (
  harness: keyof typeof HARNESS_MANAGED_PROMPT_HOOKS,
  cfg: WorkjetThreadConfig,
  withMcp = true,
) => {
  const context = contextFor(cfg);
  const threadId = ThreadId.make(`matrix-${harness}`);
  clearAllMcpProviderSessions();
  clearWorkjetThreadTeam(threadId);
  if (withMcp)
    setMcpProviderSession({
      environmentId: EnvironmentId.make("env"),
      threadId,
      providerSessionId: "session",
      providerInstanceId: "instance" as never,
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer x",
      activeWorkjetMcpCapabilityIds: [],
      compiledManagedPrompt: context.compiledManagedPrompt,
    });
  setWorkjetThreadTeam(threadId, ctoxTeamRole(context), context.compiledManagedPrompt, withMcp);
  return HARNESS_MANAGED_PROMPT_HOOKS[harness](readWorkjetManagedPrompt(threadId));
};

const HARNESSES = Object.keys(HARNESS_MANAGED_PROMPT_HOOKS) as Array<
  keyof typeof HARNESS_MANAGED_PROMPT_HOOKS
>;

const ROLE_CASES = [
  ["supervisor", "supervisor"],
  ["specialist", "persistent_worker"],
  ["worker", "one_shot_worker"],
  ["legacy-worker", "one_shot_worker"],
  ["standard", "operator"],
] as const;

describe("every harness renders the managed prompt with capability extensions", () => {
  it("has a prompt hook for every Workjet harness (fails loudly when one is added without)", () => {
    for (const harness of WorkjetHarness.literals) {
      expect(HARNESS_MANAGED_PROMPT_HOOKS, `missing hook for ${harness}`).toHaveProperty(harness);
    }
    expect(HARNESS_MANAGED_PROMPT_HOOKS).toHaveProperty("ctox");
  });

  describe.each(HARNESSES)("%s", (harness) => {
    it.each(ROLE_CASES)(
      "%s thread: Toolhub section with exactly the %s rule, plus greppy and web",
      (variant, toolhubRole) => {
        const prompt = effective(
          harness,
          config(variant, ["greppy", "web-search", "ctox-business-os"]),
        );
        if (harness !== "ctox") expect(prompt).toContain("<workjet_managed_instructions>");
        expect(prompt).toContain("## Capability: greppy@");
        expect(prompt).toContain("## Capability: web-search@");
        expect(prompt).toContain("## Capability: ctox-business-os@");
        if (harness === "ctox") {
          // Native CTOX adds its own role-aware section; Workjet's is deduped.
          expect(prompt).not.toContain("## CTOX Toolhub");
          for (const rule of Object.values(RULES)) expect(prompt).not.toContain(rule);
          return;
        }
        expect(prompt.match(/## CTOX Toolhub \(connected apps\)/g)).toHaveLength(1);
        expect(prompt).toContain("toolhub_exec");
        expect(prompt).toContain("ctox toolhub exec");
        expect(prompt).toContain(RULES[toolhubRole]);
        for (const [other, rule] of Object.entries(RULES)) {
          if (other !== toolhubRole) expect(prompt).not.toContain(rule);
        }
      },
    );

    it.each(ROLE_CASES)(
      "%s thread without MCP session still gets the managed prompt",
      (variant, toolhubRole) => {
        const prompt = effective(
          harness,
          config(variant, ["greppy", "web-search", "ctox-business-os"]),
          false,
        );
        expect(prompt).toContain(NO_MCP_SESSION_NOTE);
        expect(prompt).toContain("## Capability: greppy@");
        expect(prompt).toContain("## Capability: web-search@");
        if (harness !== "ctox") expect(prompt).toContain(RULES[toolhubRole]);
      },
    );

    it("omits extensions that are not mounted", () => {
      const prompt = effective(harness, config("standard", ["greppy"]));
      expect(prompt).toContain("## Capability: greppy@");
      expect(prompt).not.toContain("## Capability: web-search@");
      expect(prompt).not.toContain("## CTOX Toolhub");
    });
  });
});

describe("spawn environment carries the CTOX team identity", () => {
  it.each(ROLE_CASES)("%s → CTOX_TEAM_ROLE=%s", (variant, toolhubRole) => {
    const context = contextFor(config(variant, []));
    const threadId = ThreadId.make(`env-${variant}`);
    setWorkjetThreadTeam(threadId, ctoxTeamRole(context), context.compiledManagedPrompt, true);
    const env = workjetTeamEnvironment(threadId, { PATH: "/bin", CTOX_SESSION_ID: "stale" });
    expect(env.PATH).toBe("/bin");
    expect(env.CTOX_TEAM_ROLE).toBe(toolhubRole);
    if (toolhubRole === "operator") expect(env.CTOX_SESSION_ID).toBeUndefined();
    else expect(env.CTOX_SESSION_ID).toBe(threadId);
  });

  it("defaults to operator without session id when the thread is unknown", () => {
    const env = workjetTeamEnvironment(ThreadId.make("unknown-thread"), {});
    expect(env).toEqual({ CTOX_TEAM_ROLE: "operator" });
  });
});
