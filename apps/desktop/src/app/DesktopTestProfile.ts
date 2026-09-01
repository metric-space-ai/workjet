import * as NodePath from "node:path";

const TEST_PROFILE_SWITCH = "--workjet-ui-test-profile-root=";

export function resolveDesktopProfileHome(input: {
  readonly argv: readonly string[];
  readonly defaultHomeDirectory: string;
  readonly isPackaged: boolean;
}): string {
  if (input.isPackaged) return input.defaultHomeDirectory;

  const values = input.argv
    .filter((argument) => argument.startsWith(TEST_PROFILE_SWITCH))
    .map((argument) => argument.slice(TEST_PROFILE_SWITCH.length).trim());
  if (values.length === 0) return input.defaultHomeDirectory;
  if (values.length > 1) {
    throw new Error("--workjet-ui-test-profile-root may only be provided once");
  }

  const profileRoot = values[0];
  if (profileRoot === undefined || profileRoot.length === 0 || !NodePath.isAbsolute(profileRoot)) {
    throw new Error("--workjet-ui-test-profile-root must be an absolute path");
  }
  return NodePath.resolve(profileRoot);
}
