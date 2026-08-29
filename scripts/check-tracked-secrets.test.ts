import { assert, describe, it } from "@effect/vitest";
import {
  BROWSER_STORAGE_SECRET_SHAPES,
  SECRET_SHAPE_NAMES,
  SECRET_SHAPES,
  SOURCE_TREE_SECRET_SHAPES,
} from "@t3tools/shared/secretShapes";

import {
  applyAllowlist,
  scanTrackedFileText,
  shapesForPath,
  TRACKED_SECRET_ALLOWLIST,
} from "./check-tracked-secrets.ts";

/**
 * A fake OpenAI-shaped key and a fake OpenSSH key body. Both are invented here
 * and match nothing that exists; they are the mutation the gate has to see.
 */
const FAKE_PROVIDER_KEY = "sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0Ps";
const FAKE_PEM_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "QyNTUxOQAAACD9Xk4mQ2Rt8Wv6Yb1Nc3Kd5Fg7Hj0PsQwErTyUiOpAAAAJj4Qk2Lm4Rt8W",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

describe("the secret-shape table this gate reuses", () => {
  /**
   * The gate must not grow its own opinion of what a secret looks like. It
   * consumes `@t3tools/shared/secretShapes`, which is the same table
   * `apps/desktop/src/support/SupportBundleRedaction.ts` redacts with. This
   * set equality is what makes a new shape impossible to add without deciding
   * whether the tracked-file scan uses it.
   */
  it("makes every shape declare which scans use it, and why", () => {
    assert.deepStrictEqual(
      SECRET_SHAPES.map((shape) => shape.name).sort(),
      [...SECRET_SHAPE_NAMES].sort(),
      "SECRET_SHAPE_NAMES and SECRET_SHAPES must describe the same set of shapes",
    );
    for (const shape of SECRET_SHAPES) {
      assert.isTrue(
        shape.reason.trim().length > 40,
        `shape "${shape.name}" must carry a reason for its scansSourceTree decision`,
      );
      assert.isTrue(shape.pattern.flags.includes("g"), `shape "${shape.name}" must be global`);
    }
    assert.deepStrictEqual(
      SOURCE_TREE_SECRET_SHAPES.map((shape) => shape.name),
      ["pem-private-key", "known-credential", "authorization-header"],
      "changing which shapes scan the source tree is a deliberate act; update the reasons with it",
    );
    assert.deepStrictEqual(
      BROWSER_STORAGE_SECRET_SHAPES.map((shape) => shape.name),
      ["pem-private-key", "known-credential", "authorization-header", "entropy-run"],
      "the browser-storage canary adds exactly one shape: persisted state has no changelog hashes or lockfile digests, so the residue heuristic is usable there and is the only rule that sees a prefix-less opaque token",
    );
  });
});

describe("scanTrackedFileText", () => {
  it("finds a provider key, a bearer header, and a private key block", () => {
    const findings = scanTrackedFileText(
      "docs/example.md",
      [
        "# Notes",
        `Run with ANTHROPIC_API_KEY=${FAKE_PROVIDER_KEY}`,
        `curl -H "Authorization: Bearer ${FAKE_PROVIDER_KEY}" https://example.test`,
        FAKE_PEM_KEY,
      ].join("\n"),
    );
    const shapes = new Set(findings.map((finding) => finding.shape));
    assert.isTrue(shapes.has("known-credential"), "the provider key must be found");
    assert.isTrue(shapes.has("authorization-header"), "the bearer header must be found");
    assert.isTrue(shapes.has("pem-private-key"), "the private key block must be found");
  });

  it("never carries the matched secret out of the scanner", () => {
    const findings = scanTrackedFileText("docs/example.md", `key=${FAKE_PROVIDER_KEY}`);
    assert.isTrue(findings.length > 0);
    for (const finding of findings) {
      assert.strictEqual(finding.prefix.length, 4, "only a four-character prefix may escape");
      assert.isFalse(
        JSON.stringify(finding).includes(FAKE_PROVIDER_KEY),
        "a gate that echoes the credential into a CI log has moved the leak, not closed it",
      );
      assert.isTrue(finding.line > 0);
    }
  });

  /**
   * These are the shapes that made a naive scan useless: they are all real
   * lines from this repository. If the gate reports them it gets switched off,
   * and a switched-off gate guards nothing.
   */
  it("stays quiet on the ordinary code that looks like a secret", () => {
    const ordinary = [
      'const target = "task-flow-provider";', // contains sk-flow-provider
      "token: Schema.String,",
      "password: Option<String>,",
      "headers: { Authorization: `Bearer ${accessToken}` },",
      'assert!(output.starts_with("-----BEGIN RSA PRIVATE KEY-----"));',
      'assert!(output.ends_with("-----END RSA PRIVATE KEY-----"));',
      'it("rejects sk-plaintext-must-not-be-accepted", () => {});',
      "// see commit 812fb850a9c1e4d3b7f60a2e5c8d94716fa3b0e2",
    ].join("\n");
    assert.deepStrictEqual(scanTrackedFileText("apps/server/src/example.ts", ordinary), []);
  });

  it("escalates a file whose name declares it holds credentials", () => {
    assert.deepStrictEqual(
      shapesForPath(".env").map((shape) => shape.name),
      SECRET_SHAPES.map((shape) => shape.name),
      "a committed .env is scanned with the whole table, residue heuristics included",
    );
    assert.deepStrictEqual(
      shapesForPath("docs/example.env").map((shape) => shape.name),
      SOURCE_TREE_SECRET_SHAPES.map((shape) => shape.name),
      "a documented template holds placeholders, so it is scanned like documentation",
    );
    assert.isTrue(
      scanTrackedFileText(".env", "T3CODE_PAIRING_TOKEN=Qx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0PsQwEr").length >
        0,
      "the escalation is what catches an opaque pairing token with no recognizable prefix",
    );
    assert.deepStrictEqual(
      scanTrackedFileText(".env.example", "T3CODE_PAIRING_TOKEN=Qx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0PsQwEr"),
      [],
    );
  });
});

describe("the allow-list", () => {
  it("excuses only the declared file and only the declared shapes", () => {
    const entry = TRACKED_SECRET_ALLOWLIST[0];
    assert.isDefined(entry);
    const excused = applyAllowlist([
      { path: entry.path, shape: "known-credential", line: 1, length: 44, prefix: "sk-a" },
    ]);
    assert.deepStrictEqual(excused.failures, []);

    const wrongShape = applyAllowlist([
      { path: entry.path, shape: "known-credential", line: 1, length: 44, prefix: "sk-a" },
      { path: entry.path, shape: "entropy-run", line: 2, length: 40, prefix: "aaaa" },
    ]);
    assert.strictEqual(
      wrongShape.failures.length,
      1,
      "an allow-listed file is excused for its declared shapes only",
    );

    const otherFile = applyAllowlist([
      {
        path: "apps/web/src/other.test.ts",
        shape: "known-credential",
        line: 1,
        length: 44,
        prefix: "sk-a",
      },
    ]);
    assert.strictEqual(
      otherFile.failures.length,
      1,
      "the allow-list does not generalize by folder",
    );
  });

  it("reports an entry that no longer excuses anything", () => {
    const stale = applyAllowlist([]);
    assert.deepStrictEqual(
      [...stale.staleAllowlistPaths].sort(),
      TRACKED_SECRET_ALLOWLIST.map((entry) => entry.path).sort(),
      "an allow-list that cannot go stale rots into holes nobody remembers opening",
    );
  });

  it("carries a reason for every entry", () => {
    for (const entry of TRACKED_SECRET_ALLOWLIST) {
      assert.isTrue(
        entry.reason.trim().length > 40,
        `allow-list entry ${entry.path} must say why its material is benign`,
      );
      assert.isTrue(entry.shapes.length > 0, `allow-list entry ${entry.path} must name its shapes`);
      assert.isFalse(
        entry.path.includes("*"),
        "entries are enumerated files, never globs: a glob excuses the next real key too",
      );
    }
  });
});
