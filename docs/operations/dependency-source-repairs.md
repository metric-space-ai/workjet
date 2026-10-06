# Dependency security repairs

The current dependency graph includes three high severity advisories with no
published patched version. These patches retain the real upstream package
versions; they do not exclude advisories, disable the audit, or claim a clean
upstream release.

| Package                    | Current path                                       | Source repair                                                                                                                                       |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| node-forge 1.4.0           | Mobile Expo CLI and Expo code-signing certificates | Validate the nested RSA PKCS#1 v1.5 AlgorithmIdentifier element count and empty NULL parameters.                                                    |
| http-cache-semantics 4.2.0 | Marketing Astro                                    | Refuse cached-response hits for non-storable, no-cache, wildcard-Vary, and shared non-public cookie responses, before considering client max-stale. |
| braces 3.0.3               | Mobile Expo/Metro via micromatch                   | Bound parser nesting and all recursive AST entry points, including caller-supplied ASTs.                                                            |

The source patches are configured through the workspace's existing
patchedDependencies mechanism. Their hashes must be generated into the
pnpm lockfile and a frozen install must succeed before delivery.

The Node regression suite in scripts/security-dependency-patches.test.mjs
exercises valid signatures, malformed nested signatures, cache-policy
serialization, ordinary cache behavior, valid globs, excessive mixed nesting,
and caller-supplied ASTs. An isolated pristine-versus-patched comparison is
required; simply finding a patch file is not acceptance. The same suite must
also pass against the actual installed dependency paths after lock generation.

The required production dependency audit remains unchanged. pnpm's registry
audit evaluates published versions, so source patches alone do not prove a
clean audit or authorize a release. A remaining red audit stays an explicit
release finding until its normal reviewed disposition. No false patched
version, advisory suppression, or protection bypass is permitted.

Primary advisories:

- https://github.com/advisories/GHSA-86w9-cpqp-85rv
- https://github.com/advisories/GHSA-ch52-4w7c-c8xp
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm

The isolated comparison exercised all 21 cases: pristine packages produced
4 passes and 17 failures; the patched copies passed all 21. Each patch applied
successfully. Normal package installation and dependency routing still need
separate verification; this fixture result is not installed-product acceptance.

The published devalue 5.9.3 repair from existing PR79 commit 9a88e8db146fceba5e35b8338458e5ee6c179564 is also composed. Previously integrated fast-uri,
undici and brace-expansion repairs are retained.

The independent source review found no blocking defect in the three patch
implementations. The first real-consumer run passed only 14 of 21 cases:
the Braces package resolved with its patch hash but lacked the source guards.
That failed receipt remains preserved. After a corrected frozen import, all
21 tests passed against the actual Expo/Metro and Astro paths on October 4,
and again on source 71b904c3d0 on October 6. The unchanged guard and raw audit
still failed; passing consumer tests do not make the registry audit green.

The October 6 audit also reported five additional high or critical advisories.
The workspace now pins four published upstream repairs, whose package versions
were verified directly in the registry:

| Package       | Pinned repair | Actual consumer                  |
| ------------- | ------------- | -------------------------------- |
| seroval       | 1.6.3         | Web TanStack router              |
| source-map-js | 1.2.2         | Astro/Magicast and Metro/PostCSS |
| proxy-addr    | 2.0.8         | Server Claude SDK/MCP/Express    |
| compression   | 1.8.2         | Mobile Expo CLI                  |

The added `scripts/security-upstream-repairs.test.mjs` exercises the actual
consumer imports: malformed typed-array buffers, plugin-produced thenables in
fulfilled Promises, indexed source-map offsets,
mapped IPv6 proxy trust and stream cleanup on premature response close.
The fixtures stay bounded even before a fix is installed. Lock generation,
frozen import and these new regressions must pass before packaging; an override
declaration alone does not establish an installed repair.

Primary advisories for the additional repairs:

- https://github.com/advisories/GHSA-p6vx-979v-rg4c
- https://github.com/advisories/GHSA-jp82-f5mq-hwhp
- https://github.com/advisories/GHSA-68fv-2mgg-jv7q
- https://github.com/advisories/GHSA-jqcg-44mw-7w3h
- https://github.com/advisories/GHSA-vc2v-76pw-4v95

The original three requested patched versions (node-forge 1.4.1,
http-cache-semantics 4.2.1 and braces 3.0.4) returned registry 404 on October 6.
A later `/latest` registry read found http-cache-semantics 4.3.0. Its verified
npm tarball matches Git commit b1d4bd682fbab0252985de45219f4e7497c0067c, but
`evaluateRequest` still admits client `max-stale` without the existing
non-storable, no-cache and shared-cookie guards. Publication alone is not a
security repair, so the reviewed 4.2.0 source patch and all cache regressions
remain in place. No 4.3.0 consumer test or installed repair is claimed.

Their existing reviewed source patches remain in place. No unavailable package
version, advisory suppression or protection bypass is accepted. Package and
installed-product acceptance remain separate from dependency verification.
