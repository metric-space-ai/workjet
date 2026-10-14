/**
 * Per-thread team identity and managed prompt, independent of whether a Workjet
 * MCP session could be issued. Adapters read the managed prompt and the
 * CTOX_* spawn environment from here, so every harness gets both.
 */
import type { ThreadId, WorkjetThreadRole } from "@workjet/contracts";

import { readMcpProviderSession } from "./McpProviderSession.ts";

export type CtoxTeamRole = "supervisor" | "persistent_worker" | "one_shot_worker" | "operator";

/** Workjet team config → CTOX role (same mapping as the role-aware prompt). */
export const ctoxTeamRole = (input: {
  readonly projectTeamRole?: "supervisor" | "specialist" | "worker" | undefined;
  readonly workjetRole?: WorkjetThreadRole | undefined;
}): CtoxTeamRole =>
  input.projectTeamRole === "supervisor"
    ? "supervisor"
    : input.projectTeamRole === "specialist"
      ? "persistent_worker"
      : input.projectTeamRole === "worker" || input.workjetRole === "worker"
        ? "one_shot_worker"
        : "operator";

/** Shown first when no MCP session exists: the prompt then names tools the harness lacks. */
export const NO_MCP_SESSION_NOTE =
  "Workjet tools (workjet_*, ctox_business_os, decision_hub_*) are not connected in this session. Do not call them; where an instruction below needs one, report that need in your answer instead.";

interface ThreadTeam {
  readonly role: CtoxTeamRole;
  readonly fallbackPrompt?: string;
}

const teams = new Map<ThreadId, ThreadTeam>();

export function setWorkjetThreadTeam(
  threadId: ThreadId,
  role: CtoxTeamRole,
  compiledManagedPrompt: string,
  hasMcpSession: boolean,
): void {
  const trimmed = compiledManagedPrompt.trim();
  teams.set(
    threadId,
    Object.freeze({
      role,
      ...(!hasMcpSession && trimmed
        ? { fallbackPrompt: `${NO_MCP_SESSION_NOTE}\n\n${trimmed}` }
        : {}),
    }),
  );
}

export function clearWorkjetThreadTeam(threadId: ThreadId): void {
  teams.delete(threadId);
}

export function readWorkjetThreadRole(threadId: ThreadId): CtoxTeamRole | undefined {
  return teams.get(threadId)?.role;
}

/** The managed prompt for a harness: MCP session prompt, else the no-MCP fallback. */
export function readWorkjetManagedPrompt(threadId: ThreadId): string | undefined {
  return (
    readMcpProviderSession(threadId)?.compiledManagedPrompt ?? teams.get(threadId)?.fallbackPrompt
  );
}

/**
 * Child-process environment with the CTOX team identity, so a local `ctox`
 * CLI enforces the same role (only the supervisor raises user cards). Owner
 * chats (operator) get no CTOX_SESSION_ID so CTOX does not treat them as
 * unbound workers. The MCP Toolhub path stays authoritative: env vars are
 * visible to the model's shell, the MCP thread/role are not.
 */
export function workjetTeamEnvironment(
  threadId: ThreadId,
  base?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const role = readWorkjetThreadRole(threadId) ?? "operator";
  const env: NodeJS.ProcessEnv = { ...(base ?? process.env), CTOX_TEAM_ROLE: role };
  if (role === "operator") delete env.CTOX_SESSION_ID;
  else env.CTOX_SESSION_ID = threadId;
  return env;
}
