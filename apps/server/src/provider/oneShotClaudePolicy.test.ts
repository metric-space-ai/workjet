import { expect, it } from "vitest";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { oneShotClaudePolicy } from "./oneShotClaudePolicy.ts";

it("confines one-shot editor writes and cwd, follows symlinks and refuses unsandboxed shell commands", async () => {
  const fixture = Fs.mkdtempSync(Path.join(Os.tmpdir(), "workjet-one-shot-policy-"));
  const root = Path.join(fixture, "worktree");
  const outside = Path.join(fixture, "outside");
  Fs.mkdirSync(root); Fs.mkdirSync(outside);
  Fs.symlinkSync(outside, Path.join(root,"escape"));
  try {
    const policy = oneShotClaudePolicy(root);
    expect(policy.sandbox).toMatchObject({enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false,filesystem:{allowWrite:[Fs.realpathSync(root)]}});
    expect(policy.additionalDirectories).toEqual([]);
    const hook = policy.hooks!.PreToolUse![0]!.hooks[0]!;
    const invoke = (tool_input: Record<string,unknown>, cwd=root) => hook({hook_event_name:"PreToolUse",cwd,tool_name:"Write",tool_input} as Parameters<HookCallback>[0],undefined,{signal:new AbortController().signal});
    expect(await invoke({file_path:Path.join(root,"new.ts")})).toEqual({});
    for (const file_path of [Path.join(outside,"new.ts"),Path.join(root,"escape","new.ts"),"../outside/new.ts"])
      expect(await invoke({file_path})).toMatchObject({hookSpecificOutput:{permissionDecision:"deny"}});
    expect(await invoke({file_path:Path.join(root,"ok.ts")},outside)).toMatchObject({hookSpecificOutput:{permissionDecision:"deny"}});
    expect(await invoke({dangerouslyDisableSandbox:true})).toMatchObject({hookSpecificOutput:{permissionDecision:"deny"}});
  } finally { Fs.rmSync(fixture,{recursive:true,force:true}); }
});
