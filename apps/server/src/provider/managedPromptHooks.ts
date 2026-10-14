/**
 * The one place each harness turns the compiled Workjet managed prompt
 * (collective + team role + capability contributions such as greppy, web and
 * ctox-business-os/Toolhub) into what its model actually receives. Adapters
 * call these functions; tests render every harness through this table, and the
 * `Record<…>` type makes a harness without a hook a compile error.
 */
import type { WorkjetHarness } from "@workjet/contracts";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

export const WORKJET_MANAGED_OPEN = "<workjet_managed_instructions>";
export const WORKJET_MANAGED_CLOSE = "</workjet_managed_instructions>";

/** System-prompt append (Claude, Cursor, OpenCode, Grok, Pi). */
export function delimitWorkjetManagedPrompt(
  compiledManagedPrompt: string | undefined,
): string | undefined {
  const managedPrompt = compiledManagedPrompt?.trim();
  return managedPrompt
    ? `${WORKJET_MANAGED_OPEN}\n${managedPrompt}\n${WORKJET_MANAGED_CLOSE}`
    : undefined;
}

/** ACP harnesses without a system prompt (Greppy, MiniMax): first user turn. */
export function prefixTurnWithManagedPrompt(
  managedPrompt: string | undefined,
  text: string,
): string {
  const delimited = delimitWorkjetManagedPrompt(managedPrompt);
  return delimited ? `${delimited}\n\n${text}` : text;
}

/** Pi CLI flags. */
export function piManagedPromptArgs(managedPrompt: string | undefined): ReadonlyArray<string> {
  const delimited = delimitWorkjetManagedPrompt(managedPrompt);
  return delimited ? ["--append-system-prompt", delimited] : [];
}

/** Native CTOX: role prompt travels in the instruction (CTOX adds its own Toolhub section). */
export function ctoxNativeInstruction(managedPrompt: string | undefined, input: string): string {
  return [managedPrompt?.trim(), input].filter(Boolean).join("\n\n");
}

export type HarnessManagedPromptHook = (compiledManagedPrompt: string | undefined) => string;

export const HARNESS_MANAGED_PROMPT_HOOKS: Readonly<
  Record<WorkjetHarness | "ctox", HarnessManagedPromptHook>
> = Object.freeze({
  "claude-code": (m) => delimitWorkjetManagedPrompt(m) ?? "",
  "codex-cli": (m) =>
    buildCodexDeveloperInstructions("default", { model: "model", reasoningEffort: "medium" }, m),
  opencode: (m) => delimitWorkjetManagedPrompt(m) ?? "",
  "grok-cli": (m) => delimitWorkjetManagedPrompt(m) ?? "",
  "cursor-agent": (m) => delimitWorkjetManagedPrompt(m) ?? "",
  greppy: (m) => prefixTurnWithManagedPrompt(m, ""),
  "minimax-code": (m) => prefixTurnWithManagedPrompt(m, ""),
  "pi-code": (m) => piManagedPromptArgs(m).join("\n"),
  ctox: (m) => ctoxNativeInstruction(m, ""),
});
