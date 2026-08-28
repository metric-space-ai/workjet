// @effect-diagnostics nodeBuiltinImport:off
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Platform-keychain runtime smoke (docs/workjet-remaining-work.md item 23,
 * plan §10).
 *
 * Everything else that touches `safeStorage` is a unit test against a stub, so
 * nothing in CI ever proves the real OS keychain works. This drives a bare
 * Electron twice against the actual keychain:
 *
 *   1. encrypt a sentinel and write the ciphertext to a temp file, then EXIT;
 *   2. in a SECOND process, read the file and decrypt it.
 *
 * The separate processes are the substance. Decrypting inside the process that
 * encrypted would pass even if the key never reached the keychain and lived
 * only in memory — which is precisely the regression worth catching. A pass
 * here means the ciphertext survived process death, so the key came back from
 * the OS.
 *
 * On Linux it additionally fails closed on the selected backend: Chromium
 * falls back to `basic_text` (plaintext on disk masquerading as a keychain)
 * when no keyring is reachable, and a green run against that is the false
 * positive this whole script exists to prevent.
 *
 * Run: `pnpm vp exec -- tsx scripts/keychain-smoke.ts`
 * Exits non-zero on failure so a release job can gate on it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export interface KeychainPhaseResult {
  readonly ok: boolean;
  readonly phase?: string;
  readonly available?: boolean;
  readonly backend?: string | null;
  readonly plaintext?: string | null;
  readonly reason?: string;
  readonly error?: string;
}

export const KEYCHAIN_SMOKE_SENTINEL = "keychain-smoke-sentinel";

/**
 * The verdict, as a pure function so it is testable without an OS keychain.
 *
 * `unavailable` is deliberately NOT a failure: a headless CI box has no
 * keychain, and reporting that honestly is more useful than a red run that
 * says nothing about the code. A failure means the keychain was there and did
 * the wrong thing.
 */
export function interpretKeychainSmoke(input: {
  readonly encrypt: KeychainPhaseResult;
  readonly decrypt: KeychainPhaseResult;
}): { readonly verdict: "pass" | "fail" | "unavailable"; readonly detail: string } {
  if (input.encrypt.available === false) {
    return {
      verdict: "unavailable",
      detail: "safeStorage reports no encryption backend on this host; nothing was proven.",
    };
  }
  if (!input.encrypt.ok) {
    return { verdict: "fail", detail: `encrypt phase failed: ${describe(input.encrypt)}` };
  }
  if (!input.decrypt.ok) {
    return { verdict: "fail", detail: `decrypt phase failed: ${describe(input.decrypt)}` };
  }
  if (input.decrypt.plaintext !== KEYCHAIN_SMOKE_SENTINEL) {
    return {
      verdict: "fail",
      detail: `a fresh process decrypted ${JSON.stringify(input.decrypt.plaintext)}, not the sentinel — the ciphertext did not survive process death`,
    };
  }
  return {
    verdict: "pass",
    detail: "a second process decrypted the sentinel, so the key came back from the OS keychain.",
  };
}

/**
 * Backends that answer "encryption available" while writing PLAINTEXT to disk.
 * Chromium falls back to these when no real keyring is reachable, and that is
 * the whole hazard: the app believes it has a keychain and does not.
 *
 * `linuxSecretStorage.test.ts` already unit-tests the remediation text this
 * situation must produce. What only a RUNTIME smoke can add is which backend
 * the real host actually selected, so that is what this checks — and it fails
 * rather than warns, because a "successful" run against basic_text is exactly
 * the false green this smoke exists to prevent.
 */
export const PLAINTEXT_LINUX_BACKENDS: ReadonlySet<string> = new Set(["basic_text", "basic"]);

export function checkLinuxBackendFailsClosed(backend: string | null): {
  readonly ok: boolean;
  readonly detail: string;
} {
  if (backend === null) {
    return { ok: true, detail: "no backend reported; there is nothing to trust here either" };
  }
  if (PLAINTEXT_LINUX_BACKENDS.has(backend.trim().toLowerCase())) {
    return {
      ok: false,
      detail: `selected backend is ${backend}, which stores secrets as plaintext — the app must refuse this, not report success`,
    };
  }
  return { ok: true, detail: `selected backend is ${backend}` };
}

function describe(result: KeychainPhaseResult): string {
  return result.error ?? result.reason ?? JSON.stringify(result);
}

function runPhase(phase: "encrypt" | "decrypt", filePath: string): KeychainPhaseResult {
  const electron = NodePath.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  const mainScript = NodePath.join(repoRoot, "scripts/keychainSmoke/main.cjs");
  const result = NodeChildProcess.spawnSync(electron, [mainScript, phase, filePath], {
    encoding: "utf8",
    // A keychain prompt would hang a CI box forever.
    timeout: 120_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  const line = (result.stdout ?? "")
    .split("\n")
    .toReversed()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (line === undefined) {
    return {
      ok: false,
      phase,
      error: `no JSON line from electron; stderr: ${result.stderr ?? ""}`,
    };
  }
  return JSON.parse(line) as KeychainPhaseResult;
}

export function main(): number {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native keychain probe has no Effect runtime; capture the host boundary once.
  const hostPlatform = process.platform;
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "keychain-smoke-"));
  const filePath = NodePath.join(directory, "ciphertext.bin");
  try {
    const encrypt = runPhase("encrypt", filePath);
    const decrypt = encrypt.ok
      ? runPhase("decrypt", filePath)
      : ({ ok: false, phase: "decrypt", reason: "skipped, encrypt failed" } as KeychainPhaseResult);

    const { verdict, detail } = interpretKeychainSmoke({ encrypt, decrypt });
    process.stdout.write(`keychain smoke: ${verdict} — ${detail}\n`);

    if (hostPlatform === "linux") {
      const linux = checkLinuxBackendFailsClosed(encrypt.backend ?? null);
      process.stdout.write(`linux backend guard: ${linux.ok ? "ok" : "FAIL"} — ${linux.detail}\n`);
      if (!linux.ok) return 1;
    } else {
      process.stdout.write(
        `linux backend guard: skipped on ${hostPlatform}; it needs a Linux host.\n`,
      );
    }

    return verdict === "fail" ? 1 : 0;
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
