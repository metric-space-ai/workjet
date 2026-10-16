// @effect-diagnostics nodeBuiltinImport:off -- hashes the app's bundled archive before SSH transfer.
import * as NodeCrypto from "node:crypto";
import type { DesktopSshEnvironmentTarget } from "@workjet/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isSshAuthFailure, type SshAuthOptions } from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError, SshLaunchError } from "./errors.ts";

const PLATFORMS: Readonly<Record<string, string>> = {
  "Linux:x86_64": "linux-x64",
  "Linux:aarch64": "linux-arm64",
  "Darwin:x86_64": "darwin-x64",
  "Darwin:arm64": "darwin-arm64",
};

/**
 * The server archive is ~100 MB. Over a slow tailnet path (DERP relay, home
 * uplink) one 180 s command could not finish it, and every retry started from
 * zero. It now travels in bounded chunks appended to a digest-named partial
 * file: each chunk has its own timeout, a timed-out chunk keeps the bytes that
 * arrived, and the next attempt (or the next "Erneut versuchen") resumes at the
 * size the host reports.
 */
export const PORTABLE_SERVER_CHUNK_BYTES = 4 * 1024 * 1024;
/** One chunk must arrive within this time (≈ 35 KB/s minimum throughput). */
export const PORTABLE_SERVER_CHUNK_TIMEOUT_MS = 120_000;
/** Consecutive chunk attempts without a single new byte before giving up. */
export const PORTABLE_SERVER_STALLED_ATTEMPTS = 3;
const BUSY_WAIT_MS = 2_000;
/** Another transfer of the same archive (second window, reconnect) holds the lock. */
const MAX_BUSY_WAITS = 90;

export function portableServerPlatform(value: string): string | undefined {
  return PLATFORMS[value.trim()];
}

export interface PortableServerTransferProgress {
  readonly transferredBytes: number;
  readonly totalBytes: number;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Shared prelude: the digest-named partial file, its lock, and stale-leftover cleanup. */
const partialPrelude = (digest: string) => `set -eu
umask 077
dir="$HOME/.workjet/ssh-server"
mkdir -p "$dir"
partial="$dir/.partial-${digest}.tgz"
lock="$dir/.partial-${digest}.lock"
size_of() { if [ -f "$1" ]; then wc -c <"$1" | tr -d ' '; else printf '0'; fi; }
`;

/** Probe: installed path, or the resumable offset (stale leftovers removed). */
export function portableServerProbeScript(digest: string, totalBytes: number): string {
  return `${partialPrelude(digest)}if [ -f "$dir/${digest}/.complete" ] && [ -f "$dir/${digest}/package/dist/bin.mjs" ]; then
  printf 'installed:%s\\n' "$dir/${digest}/package/dist/bin.mjs"
  exit 0
fi
# Leftovers of interrupted transfers (old one-shot stages, other versions).
find "$dir" -maxdepth 1 -name '.transfer.*' -mmin +30 -exec rm -rf {} + 2>/dev/null || true
find "$dir" -maxdepth 1 -name '.partial-*' ! -name '.partial-${digest}.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
if [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null || true; fi
size="$(size_of "$partial")"
if [ "$size" -gt ${totalBytes} ]; then rm -f "$partial"; size=0; fi
printf 'offset:%s\\n' "$size"
`;
}

/** Append one chunk if the partial file is exactly at the expected offset. */
export function portableServerAppendScript(digest: string, offset: number): string {
  return `${partialPrelude(digest)}if ! mkdir "$lock" 2>/dev/null; then cat >/dev/null; printf 'busy\\n'; exit 0; fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM PIPE
size="$(size_of "$partial")"
if [ "$size" != '${offset}' ]; then cat >/dev/null; printf 'offset:%s\\n' "$size"; exit 0; fi
cat >>"$partial"
printf 'offset:%s\\n' "$(size_of "$partial")"
`;
}

/** Verify the complete partial file and install it under its digest. */
export function portableServerFinalizeScript(digest: string): string {
  return `${partialPrelude(digest)}destination="$dir/${digest}"
if [ -f "$destination/.complete" ] && [ -f "$destination/package/dist/bin.mjs" ]; then
  rm -f "$partial"
  printf '%s\\n' "$destination/package/dist/bin.mjs"
  exit 0
fi
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$partial")"; else actual="$(shasum -a 256 "$partial")"; fi
if [ "\${actual%% *}" != '${digest}' ]; then rm -f "$partial"; printf 'Workjet server transfer checksum verification failed.\\n' >&2; exit 1; fi
stage="$(mktemp -d "$dir/.transfer.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM PIPE
mkdir "$stage/${digest}"
tar -xzf "$partial" -C "$stage/${digest}"
test -f "$stage/${digest}/package/dist/bin.mjs"
touch "$stage/${digest}/.complete"
if [ ! -e "$destination" ]; then mv "$stage/${digest}" "$dir/" 2>/dev/null || test -f "$destination/.complete"; fi
test -f "$destination/.complete"
rm -f "$partial"
printf '%s\\n' "$destination/package/dist/bin.mjs"
`;
}

const shellCommand = (script: string) => ["sh", "-c", "'" + script.replaceAll("'", "'\\''") + "'"];

const parseOffset = (stdout: string): number | null => {
  const match = /^offset:(\d+)\s*$/mu.exec(stdout);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
};

export const preparePortableServer = Effect.fn("ssh.preparePortableServer")(function* (
  target: DesktopSshEnvironmentTarget,
  directory: string,
  auth: SshAuthOptions,
  onProgress?: (progress: PortableServerTransferProgress) => Effect.Effect<void>,
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
  const total = archive.byteLength;
  const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");

  const probe = Effect.fn("ssh.preparePortableServer.probe")(function* () {
    const result = yield* runSshCommand(target, {
      ...auth,
      remoteCommandArgs: ["sh", "-s"],
      stdin: portableServerProbeScript(digest, total),
    });
    const installed = /^installed:(.+)$/mu.exec(result.stdout)?.[1]?.trim();
    if (installed) return { installed, offset: total } as const;
    const offset = parseOffset(result.stdout);
    if (offset === null)
      return yield* new SshLaunchError({
        message: "The SSH host did not report the Workjet server transfer state.",
        stdout: result.stdout,
      });
    return { installed: null, offset } as const;
  });

  const first = yield* probe();
  if (first.installed) return first.installed;
  let offset = first.offset;
  let stalled = 0;
  let busy = 0;
  yield* Effect.logInfo("ssh.portableServer.transfer.start", {
    alias: target.alias,
    totalBytes: total,
    resumeAt: offset,
  });
  if (onProgress) yield* onProgress({ transferredBytes: offset, totalBytes: total });
  while (offset < total) {
    const chunk = archive.subarray(offset, Math.min(total, offset + PORTABLE_SERVER_CHUNK_BYTES));
    const before = offset;
    const sent = yield* runSshCommand(target, {
      ...auth,
      remoteCommandArgs: shellCommand(portableServerAppendScript(digest, offset)),
      stdin: chunk,
      timeoutMs: PORTABLE_SERVER_CHUNK_TIMEOUT_MS,
    }).pipe(
      Effect.map((result) => ({ _tag: "sent" as const, stdout: result.stdout })),
      Effect.catchTag("SshCommandError", (error) =>
        isSshAuthFailure(error)
          ? Effect.fail(error)
          : Effect.succeed({ _tag: "interrupted" as const, error }),
      ),
    );
    if (sent._tag === "sent" && /^busy\s*$/mu.test(sent.stdout)) {
      busy += 1;
      if (busy > MAX_BUSY_WAITS)
        return yield* new SshLaunchError({
          message: "Another Workjet server transfer to this computer did not finish.",
          stdout: "",
        });
      yield* Effect.sleep(Duration.millis(BUSY_WAIT_MS));
      const waited = yield* probe();
      if (waited.installed) return waited.installed;
      offset = waited.offset;
      continue;
    }
    const reported = sent._tag === "sent" ? parseOffset(sent.stdout) : null;
    if (reported !== null && reported > before) offset = reported;
    else {
      // A cut chunk keeps the prefix that arrived; ask the host where to
      // resume (or whether a parallel transfer already installed it).
      const resumed = yield* probe();
      if (resumed.installed) return resumed.installed;
      offset = resumed.offset;
    }
    if (offset > before) {
      stalled = 0;
      busy = 0;
      if (onProgress) yield* onProgress({ transferredBytes: offset, totalBytes: total });
      yield* Effect.logDebug("ssh.portableServer.transfer.progress", {
        alias: target.alias,
        transferredBytes: offset,
        totalBytes: total,
      });
      continue;
    }
    stalled += 1;
    if (stalled >= PORTABLE_SERVER_STALLED_ATTEMPTS) {
      const cause = sent._tag === "interrupted" ? sent.error : undefined;
      return yield* new SshCommandError({
        command: ["ssh"],
        exitCode: null,
        stderr: "",
        message: `Workjet package transfer stalled at ${megabytes(offset)} of ${megabytes(total)}. Retry resumes the transfer.`,
        ...(cause ? { cause } : {}),
      });
    }
  }
  const installed = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: ["sh", "-s"],
    stdin: portableServerFinalizeScript(digest),
    timeoutMs: PORTABLE_SERVER_CHUNK_TIMEOUT_MS,
  });
  yield* Effect.logInfo("ssh.portableServer.transfer.installed", {
    alias: target.alias,
    totalBytes: total,
  });
  return installed.stdout.trim();
});
