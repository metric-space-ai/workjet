// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The Electron main script the platform-keychain smoke drives. CommonJS and
 * dependency-free on purpose: it must run under a bare `electron` with no
 * build step, so nothing about the app's own bundling can affect the result.
 *
 * One run does one phase, chosen by argv, and every answer goes to stdout as a
 * single JSON line. Two phases in two SEPARATE processes is the entire point:
 * decrypting in the process that encrypted would pass even if the key never
 * left memory, which is exactly the failure this is meant to catch.
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");

const emit = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

app.whenReady().then(() => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Electron helper has no Effect runtime; capture the host boundary once.
  const hostPlatform = process.platform;
  const phase = process.argv[process.argv.length - 2];
  const filePath = process.argv[process.argv.length - 1];
  try {
    const available = safeStorage.isEncryptionAvailable();
    const backend =
      hostPlatform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function"
        ? safeStorage.getSelectedStorageBackend()
        : null;

    if (phase === "encrypt") {
      if (!available) {
        emit({ ok: false, phase, available, backend, reason: "encryption-unavailable" });
      } else {
        fs.writeFileSync(filePath, safeStorage.encryptString("keychain-smoke-sentinel"));
        emit({ ok: true, phase, available, backend });
      }
    } else {
      const plaintext = available ? safeStorage.decryptString(fs.readFileSync(filePath)) : null;
      emit({ ok: available, phase, available, backend, plaintext });
    }
  } catch (error) {
    emit({ ok: false, phase, error: String(error && error.message ? error.message : error) });
  }
  app.exit(0);
});
