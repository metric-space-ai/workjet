// @effect-diagnostics nodeBuiltinImport:off - the wiring invariant is proved by reading the Web Stack's own source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

/**
 * THE WEB STACK SSRF WIRING GATE
 * (docs/workjet-plan.md → "Security invariants": "Preserve Web Stack SSRF,
 * redirect, content-size, and untrusted-content defenses").
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST.
 *
 * `native/web-stack/src/egress.rs` already proves the SSRF POLICY: its unit
 * tests drive `is_public_ip`, `assert_fetchable_url`, and the resolver itself
 * (`egress.rs` tests `blocks_loopback_private_and_metadata_v4`,
 * `rejects_non_http_schemes`, `resolver_blocks_loopback_but_honors_allowlist`).
 *
 * What no test anywhere proves is that the policy is INSTALLED. Every HTTP
 * fixture test in `web_search.rs` sets `config.egress_allow_hosts =
 * vec!["127.0.0.1"]` so the harness can serve from loopback — which means
 * deleting `.resolver(SsrfResolver::new(...))` from an agent builder leaves the
 * entire Rust suite green while that agent gains the ability to reach link-local
 * metadata endpoints and RFC1918 space. That is precisely an unguarded
 * invariant: true today, silently false tomorrow.
 *
 * So this reads the Rust source the way the cross-mode proof matrix reads the
 * cross-mode server path, and holds every PRODUCTION `ureq` agent to installing
 * the resolver. It runs in vitest rather than as a `#[test]` because a Rust test
 * would need the whole crate (headless-browser and scraper dependencies
 * included) to compile before it could assert anything about the text of a
 * file.
 *
 * THE DECLARED EXCEPTIONS ARE A FINDING, NOT A CONVENTION.
 *
 * `KNOWN_UNRESOLVED_AGENTS` below is not a list of agents that are fine without
 * the resolver. It is the list of agents that DO NOT HAVE IT TODAY, recorded so
 * the gap is enumerated instead of invisible, and so a NEW unguarded agent
 * fails this test instead of joining them unnoticed. Fixing one means deleting
 * its entry here — the test then requires it to stay fixed.
 *
 * It is now EMPTY, and that is the point of the mechanism: the three
 * `scholarly_search.rs` agents it enumerated on 2026-08-20
 * (`annas_archive_search`, `augment_results_with_open_access_pdfs`,
 * `fetch_json`) were fixed on 2026-08-20 and their entries deleted, so an empty
 * list is now the asserted state and any regression fails here.
 *
 * Mirrors the capability conformance gate's `HOST_POLICY_DIFFERENCES`: the
 * tolerated set is data this test owns, never an inference.
 */

const repoRoot = NodePath.resolve(
  NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  "../../../../../..",
);
const WEB_STACK_SRC = NodePath.join(repoRoot, "native/web-stack/src");

/** The resolver call that installs the SSRF policy on a `ureq` agent. */
const RESOLVER_INSTALL = ".resolver(crate::egress::SsrfResolver::new(";

/**
 * Production agents that DO NOT install the SSRF resolver. Each entry would be a
 * real defect with its reason, kept visible rather than silently tolerated.
 *
 * EMPTY since 2026-08-20. The three `scholarly_search.rs` agents that used to
 * live here now install `SsrfResolver` seeded from
 * `crate::egress::allow_hosts_from_context` — the public Crossref / OpenAlex /
 * Semantic Scholar / Unpaywall / Anna's Archive defaults are unaffected, and an
 * internally hosted mirror must be named in `CTOX_WEB_EGRESS_ALLOW`, the same
 * exemption `web_search.rs` grants a self-hosted SearXNG base. `fetch_json`,
 * which takes a caller-supplied URL, additionally runs
 * `crate::egress::assert_fetchable_url` before any I/O. Proved by
 * `scholarly_search.rs` → `annas_archive_refuses_loopback_link_local_and_private_bases`,
 * `unpaywall_agent_refuses_loopback_link_local_and_private_hosts`,
 * `open_access_augmentation_never_opens_a_connection_to_unlisted_loopback`, and
 * `fetch_json_refuses_loopback_link_local_private_and_non_http_urls`.
 *
 * Do not re-populate this list to make a red build green: an entry here is an
 * admission that an agent can reach internal address space.
 */
const KNOWN_UNRESOLVED_AGENTS: ReadonlyArray<{
  readonly file: string;
  readonly functionName: string;
  readonly reason: string;
}> = [];

interface AgentSite {
  readonly file: string;
  readonly line: number;
  readonly resolved: boolean;
}

const rustSources = (): ReadonlyArray<{ readonly name: string; readonly body: string }> => {
  const files: Array<{ readonly name: string; readonly body: string }> = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (entry.name.endsWith(".rs")) {
        files.push({ name: relative, body: NodeFS.readFileSync(full, "utf8") });
      }
    }
  };
  walk(WEB_STACK_SRC, "");
  return files;
};

/**
 * Everything from the trailing `#[cfg(test)] mod tests` onwards is test code;
 * an agent built inside one never carries production traffic. The marker must
 * be the test MODULE specifically — these files also carry `#[cfg(test)]` on
 * individual imports and helper functions (`web_search.rs` has one on line 16),
 * and cutting at the first of those would discard the whole file.
 */
const TEST_MODULE = /^#\[cfg\(test\)\]\r?\nmod tests\b/m;

const productionPortion = (body: string): string => {
  const testModule = TEST_MODULE.exec(body);
  return testModule === null ? body : body.slice(0, testModule.index);
};

/** The nearest `fn name(` above an offset — the agent's owning function. */
const enclosingFunction = (body: string, offset: number): string => {
  const declarations = [
    ...body.slice(0, offset).matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/g),
  ];
  return declarations.at(-1)?.[1] ?? "<unknown>";
};

const agentSites = (): ReadonlyArray<AgentSite> => {
  const sites: Array<AgentSite> = [];
  for (const file of rustSources()) {
    const production = productionPortion(file.body);
    for (const match of production.matchAll(/ureq::AgentBuilder::new\(\)/g)) {
      const start = match.index;
      // The builder chain ends at `.build()`; the resolver must appear in it.
      const chainEnd = production.indexOf(".build()", start);
      const chain = production.slice(start, chainEnd < 0 ? start + 600 : chainEnd);
      sites.push({
        file: file.name,
        line: production.slice(0, start).split("\n").length,
        resolved: chain.includes(RESOLVER_INSTALL),
      });
    }
  }
  return sites;
};

describe("Web Stack SSRF wiring", () => {
  it("finds the Web Stack sources at all", () => {
    const files = rustSources();
    assert.isAtLeast(files.length, 10, "the Web Stack source tree should not have vanished");
    assert.isTrue(
      files.some((file) => file.name === "egress.rs"),
      "egress.rs, which owns the SSRF policy, is missing",
    );
  });

  it("installs the SSRF resolver on every production ureq agent but the declared exceptions", () => {
    const sites = agentSites();
    assert.isAtLeast(
      sites.length,
      8,
      "the agent builders vanished; this scan stopped proving anything",
    );

    const unresolved = sites
      .filter((site) => !site.resolved)
      .map((site) => {
        const body = rustSources().find((file) => file.name === site.file)?.body ?? "";
        const offset = body.split("\n").slice(0, site.line).join("\n").length;
        return {
          file: NodePath.basename(site.file),
          functionName: enclosingFunction(body, offset),
        };
      })
      .sort((left, right) => left.functionName.localeCompare(right.functionName));

    const declared = KNOWN_UNRESOLVED_AGENTS.map(({ file, functionName }) => ({
      file,
      functionName,
    })).sort((left, right) => left.functionName.localeCompare(right.functionName));

    assert.deepEqual(
      unresolved,
      declared,
      "a production ureq agent gained or lost the SSRF resolver; fix the agent or update KNOWN_UNRESOLVED_AGENTS deliberately",
    );
  });

  it("keeps the resolver on the agents that carry model-directed traffic", () => {
    // These are the paths a model can point at an arbitrary host, so they are
    // asserted BY NAME rather than only by the aggregate count above.
    // `scholarly_search.rs` joined the list on 2026-08-20 when its three agents
    // were fixed: `fetch_json` fetches a caller-assembled URL.
    const mustResolve = [
      "web_search.rs",
      "deep_research.rs",
      "scholarly_search.rs",
      "sources/linkedin.rs",
      "sources/xing.rs",
    ];
    const sources = rustSources();
    for (const name of mustResolve) {
      const file = sources.find((candidate) => candidate.name === name);
      assert.isDefined(file, `${name} is missing`);
      assert.include(
        productionPortion(file.body),
        RESOLVER_INSTALL,
        `${name} builds HTTP traffic without installing the SSRF resolver`,
      );
    }
  });

  it("keeps the scheme allow-list and the address policy in egress.rs", () => {
    const egress = rustSources().find((file) => file.name === "egress.rs");
    assert.isDefined(egress);
    const body = egress.body;
    // The policy the resolver enforces. A rewrite that dropped any of these
    // would leave the wiring above intact and the protection gone.
    for (const marker of [
      "fn assert_fetchable_url",
      "fn is_public_v4",
      "fn is_public_v6",
      "169.254",
      "impl ureq::Resolver for SsrfResolver",
    ]) {
      assert.include(body, marker, `egress.rs no longer contains ${marker}`);
    }
  });
});
