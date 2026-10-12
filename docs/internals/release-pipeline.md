# Draft release pipeline

PR #452 remains unpublished and unmerged. Required desktop targets:

| Platform      | Runner           | Assets for 0.0.89                                                               |
| ------------- | ---------------- | ------------------------------------------------------------------------------- |
| macOS arm64   | macos-15         | Workjet-0.0.89-arm64.dmg, Workjet-0.0.89-arm64.zip, latest-mac.yml              |
| Linux x64     | ubuntu-24.04     | Workjet-0.0.89-x64.AppImage, Workjet-0.0.89-x64.deb, latest-linux.yml           |
| Linux arm64   | ubuntu-24.04-arm | Workjet-0.0.89-arm64.AppImage, Workjet-0.0.89-arm64.deb, latest-linux-arm64.yml |
| Windows x64   | windows-latest   | Workjet-0.0.89-x64.exe, latest.yml                                              |
| Windows arm64 | windows-11-arm   | Workjet-0.0.89-arm64.exe, latest.yml (combined architecture entries)            |

Each release also includes workjet-desktop-install-manifest-v1.json, SOURCE_COMMIT,
SHA256SUMS and generated blockmaps. No Intel Mac is required.

## Signing inputs

macOS secrets:

- CSC_LINK: Developer ID certificate in electron-builder-supported form.
- CSC_KEY_PASSWORD: certificate password.
- APPLE_API_KEY: actual App Store Connect .p8 **contents**.
- APPLE_API_KEY_ID, APPLE_API_ISSUER.
- MACOS_PROVISIONING_PROFILE is optional, only for an explicitly configured
  associated-domain/passkey profile. Not needed for ordinary Developer ID signing.

Repository variable APPLE*TEAM_ID is 2HS27B8739 (set by Main).
Optional passkey variables: WORKJET_CLERK_PASSKEY_RP_DOMAINS or
CLERK_PUBLISHABLE_KEY. Neither is required for ordinary signing.
The macOS job writes the .p8 contents to
$RUNNER_TEMP/AuthKey*${APPLE_API_KEY_ID}.p8 with mode 600, then sets APPLE_API_KEY
to that path. Certificate configured => Developer ID signing; complete API inputs
=> notarization. Missing certificate => ad-hoc; missing notarization => prerelease
draft marked “nicht notarisiert”.

Windows Azure Artifact Signing secrets:

- AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
- AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME
- AZURE_TRUSTED_SIGNING_PUBLISHER_NAME

Optional endpoint/account overrides remain secrets:
AZURE_TRUSTED_SIGNING_ENDPOINT, AZURE_TRUSTED_SIGNING_ACCOUNT_NAME.
Defaults: https://weu.codesigning.azure.net/ and metricspace-signing.
Resource group rg-workjet-signing; subscription
323f3d53-921c-4fa7-a0f5-878083d0ac86 are administrative context, not signing
credentials consumed by this job.

Classic PFX alternative secrets: WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD.
Complete Azure configuration takes precedence; otherwise PFX if configured;
otherwise unsigned NSIS, explicitly marked in notes.

Main has not read or administered secrets. Michael supplies them.

## Update feed

Build parameter: --update-feed-url https://ctox.dev/updates/workjet/<channel>/
where channel is stable or nightly. Uses electron-updater generic provider and
latest metadata filenames within each channel directory. Assets stay on GitHub.
ctox.dev routes/feed publication are owned separately; not activated here.

## Open start-gate requirement

The existing scripts/smoke-packaged-startup.mjs rejects non-macOS hosts and its
process-group cleanup is Unix-specific. It has not yet been safely extended for
Windows and Linux. Linux requires both xvfb/dbus/gnome-keyring startup and a
second startup without Secret Service, with **product-surface** proof of backend
selection and unsafe_secret_storage. No safeStorage helper or protected-file
inspection may substitute for this proof.

Until these gates are implemented, this PR is incomplete and no replacement
five-platform dispatch has been started. Never treat the 58 focused tests as
installed/platform startup acceptance.

## Local notarization

xcrun --find notarytool succeeds. No named keychain profile is documented in the
scoped Workjet release scripts. A profile name was requested; existence remains
UNKNOWN, not “no profile exists”. No keychain enumeration, credentials lookup,
profile creation or history with a guessed profile was performed.
