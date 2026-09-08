import {
  WORKJET_PROJECT_FILE_NAME,
  type EnvironmentId,
  type WorkjetProjectFile,
  type WorkjetProjectFileScript,
} from "@workjet/contracts";
import { parseWorkjetProjectFile } from "@workjet/shared/workjetProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<WorkjetProjectFileScript> = [];

export interface WorkjetProjectFileState {
  /**
   * - `valid`: workjet.json exists and decoded.
   * - `invalid`: workjet.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable workjet.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: WorkjetProjectFile | null;
  scripts: ReadonlyArray<WorkjetProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `workjet.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useWorkjetProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): WorkjetProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", WORKJET_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseWorkjetProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `workjet.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useWorkjetProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<WorkjetProjectFileScript> {
  return useWorkjetProjectFileState(environmentId, cwd).scripts;
}
