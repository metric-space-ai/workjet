# ctox.dev device recovery

Wire contract: mkh-welsch/ctox-dev `docs/desktop-device-keys.md` at
`7e758a20ad9ed31c4e291f999fd37b9246d44f14`. The interoperability fixture is an
unaltered copy of `lib/desktop-device-proof.ts` from that commit (MIT).

Workjet keeps the P-256 private key in the existing ServerSecretStore, under
`userdata/secrets`, with directory mode 0700 and file mode 0600. This credential
is independent of Electron safeStorage and the #414 recovery reset. Copying a
file as the same UID is an explicitly accepted risk; the server restricts the
credential to its tenant snapshot and three desktop operations.

TODO: optional Secure Enclave storage as a later hardening step.
