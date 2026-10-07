# Desktop keychain access

On macOS, Workjet uses Electron's asynchronous safeStorage API for its
connection catalog, saved environments and CTOX credentials. The OS may require
Keychain authorization after an application update. Waiting for that decision
must not block Electron's main thread, window creation or IPC. An authorization
failure remains a typed storage error; it never falls back to plaintext or to
the synchronous API.

Electron 42.11.2 is pinned in the desktop package and lockfile. It includes the
lazy asynchronous keychain initialization fixes; the previous Electron 41
runtime did not expose the asynchronous API. The bundled Clerk SDK also selects
asynchronous safeStorage when that API is available. Windows and Linux retain
the existing Workjet keystore adapter and Linux backend checks.

The desktop install workflow checks real macOS storage in separate processes:
one process encrypts and exits, another decrypts, and a separate legacy
synchronous encryption is then read by the asynchronous API. Both the new
round-trip and legacy migration must pass before packaging. The workflow does
not accept an unavailable keychain as evidence of compatibility.

Run the native probe with `node scripts/keychain-smoke.ts` after ensuring the
pinned Electron runtime is installed. It uses only a fixed test sentinel and
removes its temporary ciphertext. Set TMPDIR to the task's disposable volume
when running locally. Existing user profiles and keychain entries must not be
removed to make this check pass.

Local background-service discovery runs before credential validation. If that
bounded discovery command times out, Desktop retries with the saved session
intact. A slow service discovery therefore does not request credential recovery.
Authentication and protected-storage failures retain the explicit recovery
dialog and its stopped-installations confirmation.

Discovery failures retain the command category, failure kind and numeric exit
code. Captured command output and arguments remain private. Invalid target
documents and mismatched profile, endpoint or server-version bindings continue
to stop startup.

References:

- https://www.electronjs.org/docs/latest/api/safe-storage
- https://releases.electronjs.org/pr/51924
