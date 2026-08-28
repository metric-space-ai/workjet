# Workjet license policy

Workjet contains code from multiple origins. Licensing is applied per file and
per component; a repository checkout is not permission to remove upstream
notices.

## Workjet and T3-derived code

The T3-derived Workjet application remains available under the MIT License in
[`LICENSE`](LICENSE). The original T3 Tools copyright and license notice must
remain intact.

New Workjet code that is not marked otherwise is MIT-licensed.

## CTOX-owned components

CTOX-owned code moved into or newly shared with Workjet is dual-licensed at the
recipient's option under:

```text
MIT OR AGPL-3.0-only
```

Such files must carry this SPDX expression:

```text
SPDX-License-Identifier: MIT OR AGPL-3.0-only
```

This additional MIT option applies only to code for which Metric Space AI owns
or controls the necessary copyright. It does not relicense third-party code or
remove third-party conditions.

The CTOX project may continue to be distributed under AGPL-3.0-only. Sharing a
canonical source package with Workjet does not merge their runtime state or
require both product repositories to use the same top-level license.

## Third-party code

- T3 Code notices remain MIT.
- The upstream CLIProxyAPI portions remain under their upstream MIT terms.
- CTOX-authored Rust-port modifications shared with Workjet use
  `MIT OR AGPL-3.0-only`.
- Greppy notices remain Apache-2.0.
- Other dependencies retain their own licenses and notices.

Before importing a component, record its source repository, source commit,
upstream license, Workjet destination, and any modified-file license expression
in the tracked provenance inventory. Generated release notices must be derived
from that inventory.

## Distribution

A Workjet release may choose the MIT option for dual-licensed CTOX-owned
components while retaining every applicable copyright, attribution, and
third-party notice. An AGPL distribution may instead choose the AGPL option.

This policy does not change trademarks, service marks, signing identities, or
the licensing of code whose copyright is not owned or controlled by Metric
Space AI.
