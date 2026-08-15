# Web Stack third-party notices

This package contains modified, derived browser assets and uses one separately
installed browser runtime. Metric Space AI's `MIT OR AGPL-3.0-only` choice
applies only to material it owns or controls; it does not replace the terms
listed here.

## CloakHQ/CloakBrowser

- Upstream: `https://github.com/CloakHQ/CloakBrowser.git`
- Commit: `0437a3f1f533b6c883e864b7730be1121da51348`
- Local derived asset: `assets/humanlike.mjs`
- Source family: `cloakbrowser/human/**` and `js/src/human/**`
- License: MIT
- Retained text: `licenses/CloakBrowser-MIT.txt`, byte-identical to the pinned
  upstream `LICENSE`
- Upstream license SHA-256:
  `93a9c5b5542faf5ff6c7956406b56930fde10bd4d3e8dc7b89f01a88a8d2b29b`

Retain the CloakHQ copyright and MIT permission notice when redistributing
substantial portions of the derived asset.

## berstend/puppeteer-extra

- Upstream: `https://github.com/berstend/puppeteer-extra.git`
- Commit: `39248f1f5deeb21b1e7eb6ae07b8ef73f1231ab9`
- Local derived asset: `assets/stealth_init.js`
- Source family: `packages/puppeteer-extra-plugin-stealth/evasions/**`
- License: MIT
- Retained text: `licenses/puppeteer-extra-MIT.txt`, byte-identical to the
  pinned upstream `LICENSE`
- Upstream license SHA-256:
  `f43f8e731aa2548019ed6714511d9e412bf48dd809d1b0d7e83d7dbf8a5683d1`

Retain the berstend copyright and MIT permission notice when redistributing
substantial portions of the derived asset.

## web-agent-master/google-search

- Upstream: `https://github.com/web-agent-master/google-search.git`
- Commit: `367aa01922e6d071f1900443eeae94d5f7a9b833`
- Package metadata: `google-search-cli` version `1.0.0`, author
  `web-agent-master`, license `ISC`
- Local derived asset: portions of `assets/google_browser_runner.mjs`
- Source family: `src/search.ts` plus package behavior documented by the pinned
  `README.md` and metadata in `package.json`
- Local text: `licenses/google-search-ISC.txt`

At this pin, upstream ships the `ISC` identifier in `package.json` but no
standalone license text. The local file records the standard ISC grant with the
metadata author and no invented year. It is not claimed to be byte-identical to
an upstream file, and no nonexistent upstream checksum is asserted.

## Patchright Node runtime

- Upstream: `https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs.git`
- Tag/commit: `v1.55.0` /
  `aabc60cdfbd6fccaaa1f24e4f9008cc85ff8fd4f`
- Runtime package: npm `patchright@1.55.0`
- License: Apache-2.0
- Retained text: `licenses/Patchright-Apache-2.0.txt`, byte-identical to the
  pinned upstream `LICENSE`
- Upstream license SHA-256:
  `65beda85bd1b4a30c2681314352c8aeeafd772dcefd554a05322afcc1297368a`
- npm integrity:
  `sha512-4h+e7APbnoH29wkStdJ/ENF4cJfIN0XJbqzMP5kAGpMcLIiGfo5OnTNavq79/nCbPlLFNLet3DSBPAPY2u5FIA==`

Patchright is installed separately by the browser preparation path and is not
vendored into the Rust crate source. The existing runtime code pins exactly
version `1.55.0`. Apache-2.0 governs that runtime dependency and its
redistribution; it is documented and noticed separately rather than added to
the crate's aggregate source expression.

## Excluded fixture history

`fixtures/sources/**` is excluded from Cargo packaging and from the license
grants described by this package. It contains test-only third-party/web-response
fixture history with unresolved redistribution evidence. Do not publish that
Git history unless source-specific rights are established or synthetic
replacements and any required history sanitization are complete.
