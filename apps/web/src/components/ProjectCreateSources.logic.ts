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
import { workjetUiLanguage } from "../workjetProjectControl";

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
  { value: "url", label: "Adresse", placeholder: "https://… oder git@…" },
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
  // A bare scheme or host ("https", "https://github.com") is not a repository
  // yet; deriving a name from it produced projects titled „https“.
  const path = trimmed.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "").replace(/^[^/\\:]*@/, "");
  if (!/[/\\:]/.test(path)) return "";
  const segment = trimmed.split(/[/\\:]/).findLast((part) => part.trim().length > 0) ?? "";
  return segment.trim();
}

/** Last path segment of a working copy, without trailing separators. */
function folderNameOf(path: string): string {
  return (
    path
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .at(-1) ?? ""
  );
}

/**
 * Existing project a new source would duplicate: same title or same working
 * copy folder name, compared case-insensitively („metric“ vs. „Metric“).
 */
export function findDuplicateProjectForName<
  P extends { readonly title: string; readonly workspaceRoot?: string | null },
>(projects: ReadonlyArray<P>, name: string): P | undefined {
  const wanted = name.trim().toLocaleLowerCase();
  if (wanted.length === 0) return undefined;
  return projects.find(
    (project) =>
      project.title.trim().toLocaleLowerCase() === wanted ||
      (project.workspaceRoot
        ? folderNameOf(project.workspaceRoot).toLocaleLowerCase() === wanted
        : false),
  );
}

/** Default parent folder for clones: the computer's setting, else `~/`. */
export function defaultCloneBaseDirectory(setting: string | null | undefined): string {
  const trimmed = setting?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "~/";
}

/** Elternordner eines Pfads, ohne abschließenden Trenner; leer für Wurzeln. */
function parentDirectory(path: string): string {
  const trimmed = path.trim().replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : "";
}

export interface ProjectCloneTargetFolder {
  readonly path: string;
  readonly label: string;
}

/**
 * Bekannte Zielordner für „Repository klonen“ (erkennen statt fragen): der
 * Projektordner des Rechners und die Elternordner seiner Arbeitskopien,
 * ohne Dubletten, höchstens `limit` Einträge.
 */
export function knownCloneTargetFolders(
  baseDirectorySetting: string,
  workspaceRoots: readonly (string | null | undefined)[],
  limit = 6,
): ProjectCloneTargetFolder[] {
  const seen = new Set<string>();
  const folders: ProjectCloneTargetFolder[] = [];
  for (const candidate of [
    baseDirectorySetting,
    ...workspaceRoots.map((root) => parentDirectory(root ?? "")),
  ]) {
    const path = candidate.trim().replace(/(.)[/\\]+$/, "$1");
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
    folders.push({ path, label: segments.at(-1) ?? path });
    if (folders.length >= limit) break;
  }
  return folders;
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
    throw new Error(cloneFailureMessage(squashAtomCommandFailure(result), request.repository));
  }
  return result.value.cwd;
}

const CLONE_FAILURE_TEXT = {
  de: {
    auth: "Kein Zugriff auf {repo} – auf diesem Rechner bei GitHub anmelden.",
    "not-found": "{repo} nicht gefunden.",
    "destination-exists": "Zielordner ist nicht leer.",
    network: "{host} nicht erreichbar.",
    unknown: "Klonen von {repo} fehlgeschlagen.",
  },
  en: {
    auth: "No access to {repo} – sign in to GitHub on this computer.",
    "not-found": "{repo} not found.",
    "destination-exists": "Target folder is not empty.",
    network: "{host} unreachable.",
    unknown: "Cloning {repo} failed.",
  },
} as const;

/** Human-readable de/en text for a clone failure; Git's own reason is kept for unknown cases. */
export function cloneFailureMessage(
  failure: unknown,
  repository: string,
  language: "de" | "en" = workjetUiLanguage(),
): string {
  const detail =
    failure !== null && typeof failure === "object" && "detail" in failure
      ? String((failure as { detail: unknown }).detail)
      : failure instanceof Error
        ? failure.message
        : "";
  if (/already exists and is not empty/i.test(detail))
    return CLONE_FAILURE_TEXT[language]["destination-exists"];
  if (
    !detail.includes("clone-failed:") &&
    !detail.startsWith("Source control repository operation") &&
    failure instanceof Error &&
    detail.length > 0
  )
    return detail;
  const match = /clone-failed:([a-z-]+)\s*(.*)$/s.exec(detail);
  const code = (match?.[1] ?? "unknown") as keyof (typeof CLONE_FAILURE_TEXT)["de"];
  const texts = CLONE_FAILURE_TEXT[language];
  const template = texts[code] ?? texts.unknown;
  const trimmed = repository
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const repo = trimmed.replace(/^https?:\/\/[^/]+\//, "") || trimmed;
  const host = /^https?:\/\/([^/]+)/.exec(trimmed)?.[1] ?? "GitHub";
  const text = template.replace("{repo}", repo).replace("{host}", host);
  const reason = match?.[2]?.trim() ?? "";
  return code === "unknown" && reason ? `${text} (${reason})` : text;
}
