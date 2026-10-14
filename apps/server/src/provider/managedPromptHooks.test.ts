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
import { HARNESS_MANAGED_PROMPT_HOOKS } from "./managedPromptHooks.ts";

const RULES = {
  supervisor: "Role rule (Supervisor)",
  persistent_worker: "Role rule (Persistent worker)",
  one_shot_worker: "Role rule (One-shot worker)",
  operator: "Role rule (Operator shell)",
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

const effective = (
  harness: keyof typeof HARNESS_MANAGED_PROMPT_HOOKS,
  cfg: WorkjetThreadConfig,
) => {
  const context = resolveThreadCapabilityContext(cfg, undefined, {
    knownConnectionIds: new Set([connectionId]),
    reachableConnectionIds: new Set([connectionId]),
    connectionInstances: new Map([[connectionId, "instance-1"]]),
  });
  return HARNESS_MANAGED_PROMPT_HOOKS[harness](context.compiledManagedPrompt);
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
        expect(prompt).toContain("## CTOX Toolhub (connected apps)");
        expect(prompt).toContain("ctox toolhub exec");
        expect(prompt).toContain(RULES[toolhubRole]);
        for (const [other, rule] of Object.entries(RULES)) {
          if (other !== toolhubRole) expect(prompt).not.toContain(rule);
        }
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
