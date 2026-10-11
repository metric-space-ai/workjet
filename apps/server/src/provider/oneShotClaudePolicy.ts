// @effect-diagnostics nodeBuiltinImport:off -- SDK hooks run as native callbacks; realpath prevents symlink escapes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

/** The SDK sandbox confines shell writes; this hook also checks native editor paths and cwd. */
export function oneShotClaudePolicy(
  worktree: string,
): Pick<Options, "sandbox" | "hooks" | "additionalDirectories"> {
  const root = NodeFS.realpathSync(worktree);
  const confined = (value: string): boolean => {
    let candidate = NodePath.resolve(root, value);
    const missing: string[] = [];
    while (!NodeFS.existsSync(candidate)) {
      const parent = NodePath.dirname(candidate);
      if (parent === candidate) return false;
      missing.unshift(NodePath.basename(candidate));
      candidate = parent;
    }
    const resolved = NodePath.resolve(NodeFS.realpathSync(candidate), ...missing);
    return resolved === root || resolved.startsWith(root + NodePath.sep);
  };
  const guard: HookCallback = async (input) => {
    let allowed = confined(input.cwd);
    if (input.hook_event_name === "PreToolUse") {
      const toolInput = input.tool_input as Record<string, unknown>;
      allowed &&= toolInput.dangerouslyDisableSandbox !== true;
      for (const key of ["file_path", "notebook_path", "path", "cwd"]) {
        if (typeof toolInput[key] === "string") allowed &&= confined(toolInput[key]);
      }
      if (!allowed)
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "One-Shots must remain within their own worktree; document the open point in the PR.",
          },
        };
    }
    return allowed ? {} : { continue: false, stopReason: "One-Shot cwd escaped its worktree." };
  };
  return {
    additionalDirectories: [],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: { allowWrite: [root], denyWrite: ["/tmp/**", "/private/tmp/**"] },
    },
    hooks: { PreToolUse: [{ hooks: [guard] }], CwdChanged: [{ hooks: [guard] }] },
  };
}
