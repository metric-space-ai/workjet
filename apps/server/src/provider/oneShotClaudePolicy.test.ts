// @effect-diagnostics nodeBuiltinImport:off -- Native hook test verifies filesystem symlink confinement.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { oneShotClaudePolicy } from "./oneShotClaudePolicy.ts";

it("confines one-shot editor writes and cwd, follows symlinks and refuses unsandboxed shell commands", async () => {
  const fixture = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-one-shot-policy-"));
  const root = NodePath.join(fixture, "worktree");
  const outside = NodePath.join(fixture, "outside");
  NodeFS.mkdirSync(root);
  NodeFS.mkdirSync(outside);
  NodeFS.symlinkSync(outside, NodePath.join(root, "escape"));
  try {
    const policy = oneShotClaudePolicy(root);
    expect(policy.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [NodeFS.realpathSync(root)] },
    });
    expect(policy.additionalDirectories).toEqual([]);
    const hook = policy.hooks!.PreToolUse![0]!.hooks[0]!;
    const invoke = (tool_input: Record<string, unknown>, cwd = root) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Write",
          tool_input,
        } as Parameters<HookCallback>[0],
        undefined,
        { signal: new AbortController().signal },
      );
    expect(await invoke({ file_path: NodePath.join(root, "new.ts") })).toEqual({});
    for (const file_path of [
      NodePath.join(outside, "new.ts"),
      NodePath.join(root, "escape", "new.ts"),
      "../outside/new.ts",
    ])
      expect(await invoke({ file_path })).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    expect(await invoke({ file_path: NodePath.join(root, "ok.ts") }, outside)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await invoke({ dangerouslyDisableSandbox: true })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  } finally {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
});
