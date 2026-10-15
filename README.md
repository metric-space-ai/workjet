# Workjet

Workjet is the application through which people work with coding agents and
with CTOX. It runs as a desktop app on macOS, Windows, and Linux, as a web app
in the browser, and as a mobile app on iOS and Android. In Workjet you start and
follow agent threads in your projects, assign them to models, harnesses, and
computers, and open the Business OS of your CTOX instances.

## How Workjet relates to CTOX and ctox.dev

The product consists of three parts. Workjet, in this repository, is the
application for the user. [CTOX](https://github.com/metric-space-ai/ctox) is the
open-source backend underneath it, a Rust daemon with a command-line interface
that keeps durable work state, runs long-lived agent work, and serves Business
OS. Workjet installs CTOX on the computers it manages, keeps it up to date, and
connects to as many CTOX instances as you need, whether they run locally, over
SSH, or in your tailnet. [ctox.dev](https://ctox.dev) is the commercial service
around both, with accounts, team access, managed instances, and relays. Workjet
works without ctox.dev; signing in to ctox.dev additionally brings your managed
instances into the app.

All desktop and mobile releases of the product are built from this repository.
The CTOX repository ships only the backend.

## Installation

The signed desktop app is available on the
[releases page](https://github.com/metric-space-ai/workjet/releases), whose
notes state the platform, signing, and verification status of each build. The
mobile apps are currently distributed through TestFlight and the internal test
track of Google Play, and they connect to a running
Workjet server or desktop app on one of your computers. How a phone is paired
with a computer, either on the local network or through Tailscale, is explained
in the guide on [remote access](./docs/user/remote-access.md).

Workjet controls the agent CLIs you already use and does not bring its own. At
least one of them has to be installed and signed in on the computer that runs
the Workjet server. Codex is set up with the [Codex CLI](https://developers.openai.com/codex/cli)
and `codex login`, Claude with [Claude Code](https://claude.com/product/claude-code)
and `claude auth login`, Cursor with the [Cursor CLI](https://cursor.com/cli)
and `agent login`, Grok Build with the [Grok Build CLI](https://x.ai/cli) and
`grok login`, and OpenCode with [OpenCode](https://opencode.ai) and
`opencode auth login`. The [installation guide](./docs/user/install.md)
describes the details, including how Workjet finds these programs and what
happens when a provider is not signed in yet.

## Using Workjet

The user documentation lives in [docs/user](./docs/user). It explains how to
[add projects](./docs/user/adding-projects.md), how
[permission modes](./docs/user/permission-modes.md) limit what an agent may do,
and how [worker profiles](./docs/user/worker-profiles.md) and
[personalization](./docs/user/worker-personalization.md) shape the team of
workers. You will also find how CTOX instances are added and selected under
[instance settings](./docs/user/instance-settings.md), how
[source control](./docs/user/source-control.md) is connected, how the app and
server [stay in sync during updates](./docs/user/updating.md), and how Workjet
runs on Linux as a [background service](./docs/user/background-service.md).
Several accounts per provider are possible for [Codex](./docs/user/providers-codex.md)
and [Claude](./docs/user/providers-claude.md), and the
[keyboard shortcuts](./docs/user/keybindings.md) can be customized.

## Development

Workjet consists of a server and three clients. The server in `apps/server`
owns agent sessions, workspaces, and version control, and every provider
process, terminal, and file access runs there. The clients in `apps/web`,
`apps/desktop`, and `apps/mobile` talk to it over a single authenticated
WebSocket connection. The [architecture overview](./docs/internals/overview.md)
is the starting point for building from source and for any deeper change.

The repository uses Vite+, so you first need its global `vp` command. On macOS
and Linux it is installed with the first command below, on Windows with the
second in PowerShell, and afterwards `vp i` installs the dependencies of the
workspace. The [Vite+ guide](https://viteplus.dev/guide/) explains the tool
itself.

```bash
curl -fsSL https://vite.plus | bash
```

```powershell
irm https://vite.plus/ps1 | iex
```

```bash
vp i
```

Workjet is at an early stage, and we accept outside contributions only to a
limited extent. Small, focused fixes have a chance, while larger features will
not be merged. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before you open
an issue or a pull request, and report problems in the
[issue tracker of this repository](https://github.com/metric-space-ai/workjet/issues).

## License

Workjet is released under the [MIT License](LICENSE). Attribution for the
components it contains is recorded in [NOTICE.md](NOTICE.md), and the policy for
shared Metric Space AI components is described in
[LICENSE_POLICY.md](LICENSE_POLICY.md).
