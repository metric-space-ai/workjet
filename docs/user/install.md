# Install Workjet

Workjet is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the Workjet server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Command-line Server

Use the `workjet` CLI supplied by your Workjet distribution. The examples in this guide
assume that executable is on your PATH. Do not install a similarly named package from a
registry as a substitute for the official distribution.

```bash
workjet --help
```

## Desktop App

Download the latest signed Workjet desktop app from
[GitHub Releases](https://github.com/metric-space-ai/workjet/releases). Package-manager entries
under the old product identity are intentionally no longer advertised.

## Building the Desktop App from Source on Linux

When no release build is available for your platform, you can build the Linux AppImage
yourself. These prerequisites are checked only when the build fails, so install them first.

| Requirement     | Version / package                                              | Fails without it                                       |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| Node.js         | exactly `24.13.1` (`engines.node` in `package.json`)           | install and build scripts                              |
| Vite+ (`vp`)    | `curl -fsSL https://vite.plus \| bash`                         | every `vp` command                                     |
| C/C++ toolchain | `build-essential` (`make`, `g++`) and `python3`                | `vp i`: `node-pty` with `gyp ERR! not found: make`     |
| Rust            | `rustc` 1.95 or newer (use rustup; distro Rust may be too old) | resource monitor: `sysinfo@0.39.3 requires rustc 1.95` |
| ImageMagick     | `imagemagick` (`convert` or `magick`)                          | Linux icon resize (`LinuxIconResizeError`)             |

The Vite+ installer reports success but does not change the current shell. Add its binary
directory to `PATH` (for example in `~/.bashrc`) before running `vp`:

```bash
export PATH="$HOME/.local/share/vite-plus/<version>/bin:$PATH"
```

On Debian or Ubuntu:

```bash
sudo apt-get install -y build-essential python3 imagemagick libfuse2
curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
nvm install 24.13.1 && nvm use 24.13.1
git clone https://github.com/metric-space-ai/workjet && cd workjet
vp i
WORKJET_DESKTOP_OUTPUT_DIR="$PWD/dist-desktop" vp run dist:desktop:linux
```

The AppImage needs `libfuse2` to start (`dlopen(): error loading libfuse.so.2`). Without it,
extract and run it instead:

```bash
./Workjet-<version>-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

Desktop stores instance credentials in the system keyring. On Linux this requires a Secret
Service provider (for example `gnome-keyring` or KWallet) in a running D-Bus session.

## Providers

Workjet drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
Workjet looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run the login command on the machine running the Workjet server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started Workjet.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
Workjet. You can install Workjet, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

After connecting an instance, select it in the instance dropdown to open its
Code workspace. Opening Business OS first is not required. Code loads that
instance's native project list and assigned computers independently; connection,
permission, and assignment errors still prevent the affected action. A selected
instance does not by itself confirm that its data connection is ready.

- [Permission modes](./permission-modes.md): how much Workjet asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping Workjet in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
