# Web Stack upstream boundary

## Immutable source identities

The external checkouts below are inspection inputs under Workjet-owned ignored
dependency storage. They are not repository content and are not modified by
this package.

| Component       | Canonical source                                                | Inspected checkout                            | Immutable revision                                               | Package/license identity                                    |
| --------------- | --------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| CloakBrowser    | `https://github.com/CloakHQ/CloakBrowser.git`                   | `/Volumes/tmp/workjet/deps/cloakbrowser`      | commit `0437a3f1f533b6c883e864b7730be1121da51348`                | MIT                                                         |
| puppeteer-extra | `https://github.com/berstend/puppeteer-extra.git`               | `/Volumes/tmp/workjet/deps/puppeteer-extra`   | commit `39248f1f5deeb21b1e7eb6ae07b8ef73f1231ab9`                | MIT                                                         |
| google-search   | `https://github.com/web-agent-master/google-search.git`         | `/Volumes/tmp/workjet/deps/google-search`     | commit `367aa01922e6d071f1900443eeae94d5f7a9b833`                | `google-search-cli` `1.0.0`; author `web-agent-master`; ISC |
| Patchright Node | `https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs.git` | `/Volumes/tmp/workjet/deps/patchright-nodejs` | tag `v1.55.0`; commit `aabc60cdfbd6fccaaa1f24e4f9008cc85ff8fd4f` | npm `patchright@1.55.0`; Apache-2.0                         |

The google-search pin declares ISC in `package.json` and has no standalone
license file. The local ISC text is therefore a standard grant associated with
the metadata author, not a byte-identical upstream file. It deliberately does
not invent a copyright year.

## Exact license and package checksums

| Evidence                                     | SHA-256 or integrity                                                                              | Local retained copy                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| CloakBrowser upstream `LICENSE`              | `93a9c5b5542faf5ff6c7956406b56930fde10bd4d3e8dc7b89f01a88a8d2b29b`                                | `licenses/CloakBrowser-MIT.txt` (byte-identical)            |
| puppeteer-extra upstream `LICENSE`           | `f43f8e731aa2548019ed6714511d9e412bf48dd809d1b0d7e83d7dbf8a5683d1`                                | `licenses/puppeteer-extra-MIT.txt` (byte-identical)         |
| Patchright upstream `LICENSE`                | `65beda85bd1b4a30c2681314352c8aeeafd772dcefd554a05322afcc1297368a`                                | `licenses/Patchright-Apache-2.0.txt` (byte-identical)       |
| Metric Space AI canonical MIT text           | `3ba36e96da4f77cb87053bf9165d1832a25c19c3e08f5caa3997854acae5522b`                                | `LICENSE.MIT`                                               |
| Metric Space AI canonical AGPL-3.0-only text | `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`                                | `LICENSE.AGPL-3.0-only`                                     |
| npm `patchright@1.55.0` package              | `sha512-4h+e7APbnoH29wkStdJ/ENF4cJfIN0XJbqzMP5kAGpMcLIiGfo5OnTNavq79/nCbPlLFNLet3DSBPAPY2u5FIA==` | Installed separately at runtime; not vendored in this crate |

## Local-to-upstream file-family map

All upstream paths are relative to the pinned repositories above.

| Local file                         | Upstream source family                                                                                                                                                                                                                                                                               | Downstream boundary                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets/humanlike.mjs`             | CloakBrowser `cloakbrowser/human/**` and `js/src/human/**` at `0437a3f1f533b6c883e864b7730be1121da51348`                                                                                                                                                                                             | Reimplemented and adapted into a self-contained JavaScript module for Playwright/Patchright. The patched CloakBrowser Chromium binary is not used. CloakBrowser-derived material remains MIT; Metric Space AI-owned adaptations use the owner choice.                                                                 |
| `assets/stealth_init.js`           | puppeteer-extra `packages/puppeteer-extra-plugin-stealth/evasions/**` at `39248f1f5deeb21b1e7eb6ae07b8ef73f1231ab9`                                                                                                                                                                                  | Distilled and modified into one self-contained init-script IIFE. puppeteer-extra-derived material remains MIT; Metric Space AI-owned adaptations use the owner choice.                                                                                                                                                |
| `assets/google_browser_runner.mjs` | google-search `src/search.ts`, with the package behavior documented in `README.md` and metadata in `package.json`, at `367aa01922e6d071f1900443eeae94d5f7a9b833`; CloakBrowser launch-wrapper rules from `cloakbrowser/human/**` and `js/src/human/**` at `0437a3f1f533b6c883e864b7730be1121da51348` | Reworked into the bounded stdin/stdout runner, persistent-context flow, local consent handling, result projection/deduplication, and Patchright integration used here. google-search-derived portions remain ISC, CloakBrowser-derived portions remain MIT, and Metric Space AI-owned additions use the owner choice. |

The browser asset bodies are downstream implementations, not verbatim copies of
the mapped source families. Their file-top notices identify the conjunction of
terms applicable to each mixed file; those notices do not relicense upstream
material.

## Aggregate source boundary

Metric Space AI-owned source is offered, at the recipient's choice, under MIT
or AGPL-3.0-only. MIT- and ISC-derived browser assets retain their upstream
terms. The crate's aggregate Cargo SPDX expression is therefore:

```text
MIT AND ISC AND (MIT OR AGPL-3.0-only)
```

This is an aggregate statement for the packaged source, not a claim that every
file is wholly dual-licensed.

Patchright is a separate Node runtime dependency. `src/browser.rs` installs
exactly `patchright@1.55.0`; its Apache-2.0 terms and exact notice are recorded
in `THIRD_PARTY.md` and `licenses/Patchright-Apache-2.0.txt`. Patchright is not
vendored source and Apache-2.0 is intentionally not added to the crate source
expression.

## Fixture exclusion and public-history gate

`fixtures/sources/**` is test-only third-party/web-response fixture history with
unresolved redistribution evidence. It is outside all grants described above.
Cargo packaging excludes that path, so no file beneath it belongs to the crate
artifact. Its continued presence in Git history is not a claim that the history
is publishable. Public Git history remains blocked until every fixture has
source-specific rights or a synthetic replacement and any required history
sanitization is complete.
