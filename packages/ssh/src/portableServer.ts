// @effect-diagnostics nodeBuiltinImport:off -- hashes the app's bundled archive before SSH transfer.
import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";
import type { DesktopSshEnvironmentTarget } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { SshAuthOptions } from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshLaunchError } from "./errors.ts";

const PLATFORMS: Readonly<Record<string, string>> = {
  "Linux:x86_64": "linux-x64",
  "Linux:aarch64": "linux-arm64",
  "Darwin:x86_64": "darwin-x64",
  "Darwin:arm64": "darwin-arm64",
};

export function portableServerPlatform(value: string): string | undefined {
  return PLATFORMS[value.trim()];
}

export const preparePortableServer = Effect.fn("ssh.preparePortableServer")(function* (
  target: DesktopSshEnvironmentTarget,
  directory: string,
  auth: SshAuthOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platformResult = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: ["sh", "-s"],
    stdin: 'printf \'%s:%s\\n\' "$(uname -s)" "$(uname -m)"\n',
  });
  const platform = portableServerPlatform(platformResult.stdout);
  if (!platform)
    return yield* new SshLaunchError({
      message: "This SSH platform is not supported by the bundled Workjet server.",
      stdout: "",
    });
  const archive = yield* fs.readFile(path.join(directory, `workjet-server-${platform}.tgz`)).pipe(
    Effect.mapError(
      (cause) =>
        new SshLaunchError({
          message: `This Workjet app is missing its server package for ${platform}. Reinstall a complete Workjet release.`,
          stdout: "",
          cause,
        }),
    ),
  );
  const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const destination = `.workjet/ssh-server/${digest}`;
  const probe = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: ["sh", "-s"],
    stdin: `if [ -f "$HOME/${destination}/.complete" ] && [ -f "$HOME/${destination}/package/dist/bin.mjs" ]; then printf '%s\\n' "$HOME/${destination}/package/dist/bin.mjs"; fi\n`,
  });
  if (probe.stdout.trim()) return probe.stdout.trim();
  const encoded =
    NodeBuffer.Buffer.from(archive)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\n") ?? "";
  const script = `set -eu
umask 077
mkdir -p "$HOME/.workjet/ssh-server"
stage="$(mktemp -d "$HOME/.workjet/ssh-server/.transfer.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
cat > "$stage/archive.base64" <<'WORKJET_ARCHIVE'
${encoded}
WORKJET_ARCHIVE
if [ "$(uname -s)" = Darwin ]; then base64 -D -i "$stage/archive.base64" > "$stage/server.tgz"; else base64 -d "$stage/archive.base64" > "$stage/server.tgz"; fi
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$stage/server.tgz")"; else actual="$(shasum -a 256 "$stage/server.tgz")"; fi
test "\${actual%% *}" = '${digest}' || { printf 'Workjet server transfer checksum verification failed.\\n' >&2; exit 1; }
mkdir "$stage/${digest}"
tar -xzf "$stage/server.tgz" -C "$stage/${digest}"
test -f "$stage/${digest}/package/dist/bin.mjs"
touch "$stage/${digest}/.complete"
if [ ! -e "$HOME/${destination}" ]; then mv "$stage/${digest}" "$HOME/.workjet/ssh-server/" 2>/dev/null || test -f "$HOME/${destination}/.complete"; fi
test -f "$HOME/${destination}/.complete"
printf '%s\\n' "$HOME/${destination}/package/dist/bin.mjs"
`;
  const installed = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: ["sh", "-s"],
    stdin: script,
    timeoutMs: 180_000,
  });
  return installed.stdout.trim();
});
