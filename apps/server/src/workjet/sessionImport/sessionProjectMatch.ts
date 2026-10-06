// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type { OrchestrationProjectShell } from "@workjet/contracts";

export const repositoryKey = (remote: string | null | undefined): string | undefined => {
  if (!remote) return undefined;
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):([^/].+)$/u.exec(remote.trim());
  const url = remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : undefined;
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["ssh:", "https:", "http:", "git:"].includes(parsed.protocol)) return undefined;
    const host = parsed.hostname.toLowerCase();
    let path = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
    if (!host || path === "" || path === "/") return undefined;
    if (host === "github.com") path = path.toLowerCase();
    return `${host}${parsed.port ? `:${parsed.port}` : ""}${path}`;
  } catch { return undefined; }
};

/** Match only evidence belonging to existing projects in the current environment. */
export const matchSessionProject = (
  source: { readonly workspaceRoot: string | null; readonly repositoryUrl?: string | null },
  projects: ReadonlyArray<OrchestrationProjectShell>,
): OrchestrationProjectShell | undefined => {
  if (source.workspaceRoot) {
    const cwd = NodePath.resolve(source.workspaceRoot);
    const roots = projects.flatMap((project) => {
      if (!project.workspaceRoot) return [];
      const root = NodePath.resolve(project.workspaceRoot);
      const relative = NodePath.relative(root, cwd);
      return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== ".." && !NodePath.isAbsolute(relative))
        ? [{ project, length: root.length }] : [];
    }).sort((left, right) => right.length - left.length);
    if (roots.length) return roots[1]?.length === roots[0]!.length ? undefined : roots[0]!.project;
  }
  const remote = repositoryKey(source.repositoryUrl);
  if (!remote) return undefined;
  const matches = projects.filter((project) => repositoryKey(project.repositoryIdentity?.locator.remoteUrl) === remote);
  return matches.length === 1 ? matches[0] : undefined;
};
