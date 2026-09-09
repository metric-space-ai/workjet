# Native target identity resolution

The Electron Main CtoxNativeIdentityResolver service is provided by the existing desktopCtoxControlLayer. It resolves a public native key for a selected local or SSH target using CtoxInstanceRegistry and the existing process/SSH adapters. It does not create a BusinessData session, confirm an account, fetch credentials, mint an invite, initialize a key or persist a second identity store.

## Existing source of trust

The CTOX command `ctox sync identity --root <existing instance root>` reads the established ctox-sync-host/identity-pkcs8 SecretStore key and returns only its public Ed25519 identity. This is an independent target pin when read through the trusted local executable/root or authenticated SSH channel. The publicIdentity in a later peer response must still be checked against this pin by the shared native proof reader.

Local discovery reuses its existing descriptor/ownership/health checks. discoverCtoxLocalDaemonNativeTargets provides the descriptor's parent directory only to Main. The original discoverCtoxLocalDaemonInstances result and the registry's renderer-visible instance projection remain path-free. Nested instance descriptors retain their own roots; a missing root is never replaced by the default root.

SSH resolution reuses makeCtoxSshInviteExec and therefore the existing SSH credentials, configured host-key pin/known_hosts policy and scoped temporary known-host file. The selected daemon's private instance ID is retained from the same descriptor discovery. The fixed identity command uses the configured root or the same default-root resolution as descriptor discovery, quotes it as one shell value, bounds stdout at the remote source and discards CLI stderr except for a fixed failure marker. It opens no signaling forward.

The CLI output is bounded at4KiB and must be exactly the existing identity document shape with an ed25519: key containing64 lowercase hex characters. Unknown fields, partial/multiple documents, helper failure and missing target metadata are rejected with a fixed diagnostic. Shape validation does not verify a peer signature or principal.

## Account ordering

Each resolve attempt registers with the existing CtoxAccountLifecycle before synchronously capturing its local sessionEpoch. Registration rejects during invalidation. A transition aborts the owned read and awaits the underlying Effect scope's cleanup before the callback resolves. Local helper output is bounded and the read has a20-second deadline; SSH uses the existing executor deadline. Expected failures do not expose helper output or local paths.

The initial awaiting-authority phase may obtain a public target pin; requiring Ready at this point would prevent the first authentication. The resolver never calls confirmSession. Its result contains the captured epoch so the subsequent native target/credential owner can recheck it after every asynchronous step and before credential delivery or publication. A completed key read is not a live session, remote Principal proof or permission to execute a worker.

## Remaining integration and verification

Managed/QR enrollment must obtain the same public key from its authentic provisioning contract. An imported pairing document or the peer response alone is insufficient. These sources currently return unavailable from this resolver. Local Windows and Windows SSH targets also remain unavailable here until the native identity command and local ACL trust contract are supported; existing browser launch behavior is unaffected.

Eight new source tests cover selected-root resolution without credentials, unsupported/missing targets, strict output validation, pending-child cleanup on account transition, rejection during an active transition, SSH host-key/target propagation, SSH failure and quoting. Existing discovery tests additionally verify private root/instance metadata while preserving their renderer privacy guards. No actual SSH/tenant command or native peer authentication is exercised by those injected executor tests.

The operational BusinessData host/IPC service, deferred credential callback, current remote Principal comparison, device proof, actual handle/event cleanup and desktop/mobile account-isolation acceptance remain required. This source addition must not be advertised as an enabled VM or completed native data connection.
