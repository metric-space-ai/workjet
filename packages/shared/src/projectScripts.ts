import type { ProjectScript } from "@workjet/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string | null;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd<Cwd extends string | null>(input: {
  project: {
    cwd: Cwd;
  };
  worktreePath?: string | null;
}): string | Cwd {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> =
    input.project.cwd === null
      ? {}
      : {
          WORKJET_PROJECT_ROOT: input.project.cwd,
        };
  if (input.worktreePath) {
    env.WORKJET_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
