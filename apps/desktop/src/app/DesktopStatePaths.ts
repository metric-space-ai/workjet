import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(workjetHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(workjetHome)) {
    return Option.none();
  }
  const trimmed = workjetHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly workjetHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.workjetHome), () =>
    input.joinPath(input.homeDirectory, ".workjet"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly workjetHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.workjetHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
