# Stable Node identity for the macOS background service

Bundled macOS installations copy the verified portable Node runtime to `<profile>/runtime/node/<major>/bin/node` before stopping the existing service. The LaunchAgent starts this executable; the launcher uses its own executable for every server child. Workjet version directories retain immutable application files but no longer define the service executable identity.

Subsequent Workjet releases on the same Node major reuse the existing runtime without replacing its executable, preserving its path, bytes, inode and original signature. A different Node major gets a new directory and a new LaunchAgent target. Existing directories with missing metadata, mismatched architecture/platform or changed executable digests are rejected, never silently repaired. Installation remains under the existing profile administration ownership lock and uses an atomic staging rename.

Linux bundled services, unbundled npm services, SSH bootstrap, and remote/mobile clients retain their current launch paths. TCC grants are never written, reset or copied. The first migration to the stable path may need the user's permission once. Acceptance requires two consecutive installed updates with unchanged Node identity and no new Documents permission dialog, verified by macOS logs or the user's confirmation; unit tests alone cannot establish that outcome.
