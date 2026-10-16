# E51 App API stub pin (`api.prefs`)

Byte-identical copy of the controller-owned CTOX Sync v4 App API stub (private local repository
`~/.local/state/ctox-sync-v4/stub`, not on GitHub) at commit
`93a322c8af59095348cc862021be0df13f079287` (E42.1 + E51). Shell v4 pins the same commit.
Test-only: it supplies the real E51 `api.prefs` (`PreferencesApi`) to the fake-core tests until the
public kernel types and implements `prefs` (ctox #912, `v4/kernel-e47`); then this directory goes.
`ctox-app-api-stub.d.mts` is Workjet's typing shim. Copy the files unchanged when the pin moves
and update the commit and hashes here; `kernelProvenance.test.ts` checks every hash.

| File                  | SHA-256                                                          |
| --------------------- | ---------------------------------------------------------------- |
| ctox-app-api-stub.mjs | 006a50c4c111d1a4ee582d440b2b4e60780cb6f25748ce4f845907fc079f8644 |
| index.d.ts            | 1801092917364f44302ceb2b80acb4b45fa0d3d2aea2e48c80c3f652899e7ccf |
