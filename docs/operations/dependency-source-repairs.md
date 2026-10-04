# Unreleased dependency source repairs

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
implementations. A subsequent pnpm 11.10.0 run generated all three patch hashes
and completed the frozen installation command successfully. However, the same
21-case suite against the real Expo/Metro and Astro dependency paths passed only
14 cases: all seven Braces protections failed. Its resolved package directory
included the correct patch hash, but the loaded Braces source lacked the guards.
Dependency patch application remains an open delivery finding.

The actual consumer failure stopped that run before its production audit and
composed host checks. Those checks remain unexecuted on this generated lock;
the previous red production audit is retained and is not waived. No current
package or installed-product acceptance is established. The earlier 4ea9
diagnostic desktop package is not a package of these repairs.
