# Adding an SSH computer from Workjet Desktop

In Settings → Computers, choose Add environment → SSH and enter the host,
user and optional port. Workjet uses the existing SSH key, agent or interactive
password prompt. Verify the host fingerprint before accepting a new host.

A packaged desktop release carries server archives for Linux and macOS on x64
and ARM64. Workjet selects the host's archive, transfers it over SSH, verifies
its SHA-256 digest and stores it under `~/.workjet/ssh-server/<digest>`.
The archive includes the terminal, resource monitor and provider gateway host.
Repeated connections reuse the verified installation.

If the required Node runtime is unavailable, Workjet downloads Node 24.13.1
from nodejs.org and verifies a pinned SHA-256 digest before extraction. The
private runtime lives under `~/.workjet/runtime/node`. System Node installations
are preserved. The exact Node version matches the archive's native modules.
The host needs curl, tar, a SHA-256 utility and outbound HTTPS to nodejs.org.
No global npm CLI installation is required.

The separate Install on a computer wizard manages CTOX. Adding a computer
reuses an existing installation only after `ctox status` reports a running
daemon. Otherwise the wizard downloads the verified bootstrap from the
`ctox-install-bootstrap-v1` release. Repair remains an explicit reinstall.
A connection to the Workjet server and a paired CTOX instance are distinct:
adding an SSH environment does not silently grant access to an existing CTOX
instance's data.

Release verification must cover the visible desktop workflow against a host
with an older system Node: add the host, open a project there, run a terminal
command, reconnect and restart the app. A terminal-only bootstrap or a mocked
SSH test is insufficient acceptance evidence.
