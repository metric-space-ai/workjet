/**
 * Reine Logik für „Projekt anlegen“ mit Quelle (Neu | Aus Ordner | Repository
 * klonen). Die Seiteneffekte (Ordnerwahl, Klonen) laufen über übergebene
 * Funktionen, damit sie ohne Desktop und ohne Backend testbar sind.
 */
import type { AtomCommandResult } from "@workjet/client-runtime/state/runtime";
import { squashAtomCommandFailure } from "@workjet/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PickFolderOptions,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
} from "@workjet/contracts";

import { inferProjectTitleFromPath } from "../lib/projectPaths";

export type ProjectCreateSource = "new" | "folder" | "clone";

export const PROJECT_CREATE_SOURCES: ReadonlyArray<{
  readonly value: ProjectCreateSource;
  readonly label: string;
}> = [
  { value: "new", label: "Neu" },
  { value: "folder", label: "Aus Ordner" },
  { value: "clone", label: "Repository klonen" },
];

export type ProjectCloneProvider = "url" | "github" | "gitlab" | "bitbucket" | "azure-devops";

export const PROJECT_CLONE_PROVIDERS: ReadonlyArray<{
  readonly value: ProjectCloneProvider;
  readonly label: string;
  readonly placeholder: string;
}> = [
  { value: "url", label: "Git-URL", placeholder: "https://… oder git@…" },
  { value: "github", label: "GitHub", placeholder: "owner/repo" },
  { value: "gitlab", label: "GitLab", placeholder: "gruppe/projekt" },
  { value: "bitbucket", label: "Bitbucket", placeholder: "workspace/repo" },
  { value: "azure-devops", label: "Azure DevOps", placeholder: "projekt/repo" },
];

/** Git-URL always; a provider only when it is installed and signed in. */
export function readyCloneProviders(
  discovery: SourceControlDiscoveryResult | null | undefined,
): ProjectCloneProvider[] {
  const ready: ProjectCloneProvider[] = ["url"];
  if (!discovery) return ready;
  for (const entry of PROJECT_CLONE_PROVIDERS) {
    if (entry.value === "url") continue;
    const provider = discovery.sourceControlProviders.find(
      (candidate) => candidate.kind === entry.value,
    );
    if (provider?.status === "available" && provider.auth.status !== "unauthenticated")
      ready.push(entry.value);
  }
  return ready;
}

/** Folder name of a repository from a clone URL, `owner/repo` or a path. */
export function deriveRepositoryFolderName(input: string): string {
  const trimmed = input
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/i, "");
  const segment = trimmed.split(/[/\\:]/).findLast((part) => part.trim().length > 0) ?? "";
  return segment.trim();
}

/** Default parent folder for clones: the computer's setting, else `~/`. */
export function defaultCloneBaseDirectory(setting: string | null | undefined): string {
  const trimmed = setting?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "~/";
}

/** Target folder of a clone: base folder plus the repository folder name. */
export function joinCloneDestination(baseDirectory: string, folderName: string): string {
  const base = baseDirectory.trim().length > 0 ? baseDirectory.trim() : "~/";
  const separator = /^[A-Za-z]:[\\/]/.test(base) || base.startsWith("\\\\") ? "\\" : "/";
  return `${base.replace(/[/\\]+$/, "")}${separator}${folderName}`;
}

export interface ProjectComputerCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly isPrimary: boolean;
  readonly connected: boolean;
}

export interface ProjectComputerOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly connected: boolean;
}

const GENERIC_LOCAL_LABELS = new Set(["local", "this device", "localhost", "lokal"]);

/** Connected computers first, this computer on top; generic names in German. */
export function buildProjectComputerOptions(
  candidates: readonly ProjectComputerCandidate[],
): ProjectComputerOption[] {
  return candidates
    .map((candidate) => {
      const label = candidate.label?.trim() ?? "";
      return {
        environmentId: candidate.environmentId,
        isPrimary: candidate.isPrimary,
        connected: candidate.connected,
        label:
          candidate.isPrimary &&
          (label.length === 0 || GENERIC_LOCAL_LABELS.has(label.toLowerCase()))
            ? "Dieser Rechner"
            : label.length > 0
              ? label
              : candidate.environmentId,
      };
    })
    .toSorted((left, right) => {
      if (left.connected !== right.connected) return left.connected ? -1 : 1;
      if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
      return left.label.localeCompare(right.label, "de");
    });
}

/** The chosen computer while it stays connected, else the first connected one. */
export function resolveProjectComputer(
  options: readonly ProjectComputerOption[],
  chosen: EnvironmentId | null,
): EnvironmentId | null {
  const connected = options.filter((option) => option.connected);
  if (chosen !== null && connected.some((option) => option.environmentId === chosen)) return chosen;
  return connected[0]?.environmentId ?? null;
}

export interface PickedProjectFolder {
  readonly path: string;
  readonly title: string;
}

/** Opens the native folder chooser of the desktop (not an app popup). */
export async function pickProjectFolder(
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>,
  input: { readonly initialPath?: string | null; readonly targetEnvironmentId?: string | null },
): Promise<PickedProjectFolder | null> {
  const options: PickFolderOptions = {
    ...(input.initialPath ? { initialPath: input.initialPath } : {}),
    ...(input.targetEnvironmentId ? { targetEnvironmentId: input.targetEnvironmentId } : {}),
  };
  const path = await pickFolder(Object.keys(options).length > 0 ? options : undefined);
  if (path === null || path.trim().length === 0) return null;
  return { path, title: inferProjectTitleFromPath(path) };
}

export interface ProjectCloneRequest {
  readonly environmentId: EnvironmentId;
  readonly provider: ProjectCloneProvider;
  readonly repository: string;
  readonly baseDirectory: string;
}

/** The request the backend clones from: a URL, or a provider repository. */
export function buildCloneRepositoryInput(
  request: ProjectCloneRequest,
): SourceControlCloneRepositoryInput {
  const repository = request.repository.trim();
  const destinationPath = joinCloneDestination(
    request.baseDirectory,
    deriveRepositoryFolderName(repository),
  );
  return request.provider === "url"
    ? { remoteUrl: repository, destinationPath }
    : { provider: request.provider, repository, destinationPath };
}

/** Clones into the target folder and returns the working copy path. */
export async function cloneProjectRepository(
  cloneRepository: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: SourceControlCloneRepositoryInput;
  }) => Promise<AtomCommandResult<SourceControlCloneRepositoryResult, unknown>>,
  request: ProjectCloneRequest,
): Promise<string> {
  if (deriveRepositoryFolderName(request.repository).length === 0)
    throw new Error("Repository fehlt.");
  const result = await cloneRepository({
    environmentId: request.environmentId,
    input: buildCloneRepositoryInput(request),
  });
  if (result._tag === "Failure") {
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error ? failure : new Error("Klonen fehlgeschlagen.");
  }
  return result.value.cwd;
}
