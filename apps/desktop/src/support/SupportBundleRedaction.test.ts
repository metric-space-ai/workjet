// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { SUPPORT_BUNDLE_PLACEHOLDERS, SUPPORT_BUNDLE_MAX_FIELD_LENGTH } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  containsSupportCredentialShape,
  gateBoolean,
  gateCount,
  gateInteger,
  gateLabel,
  gateLogLine,
  gateText,
  makeSupportRedactionLedger,
  redactSupportText,
} from "./SupportBundleRedaction.ts";

/**
 * The canaries. Each entry is a synthesized secret of a DIFFERENT shape, plus
 * the substring that must never survive the gate. If a future change to the
 * substitution list lets one of these through, this table fails.
 */
const SECRET_CANARIES = [
  {
    name: "provider api key",
    raw: "gateway account configured with sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0Ps",
    forbidden: "sk-ant-api03",
  },
  {
    name: "bearer authorization header",
    raw: "request failed Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.7Qk2Lm4Rt8Wv6Yb1Nc3Kd5",
    forbidden: "eyJhbGciOiJIUzI1NiJ9",
  },
  {
    name: "pairing password assignment",
    raw: 'ssh prompt resolved pairingPassword="hunter2CorrectHorseBattery"',
    forbidden: "hunter2CorrectHorseBattery",
  },
  {
    name: "github token",
    raw: "clone failed for ghp_9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0PsQwEr",
    forbidden: "ghp_9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0PsQwEr",
  },
  {
    name: "absolute home path",
    raw: "opened workspace /Users/alice/Documents/acme-merger/notes.md",
    forbidden: "alice",
  },
  {
    name: "windows profile path",
    raw: "profile at C:\\Users\\alice\\AppData\\Roaming\\CTOX",
    forbidden: "alice",
  },
  {
    name: "email address",
    raw: "signed in as alice.smith@example.com",
    forbidden: "alice.smith@example.com",
  },
  {
    name: "url with credentials and query token",
    raw: "posting to https://bob:s3cr3tpass@relay.example.com/v1/push?access_token=9zQx4Lm2Rt8Wv6Yb1Nc3Kd5",
    forbidden: "s3cr3tpass",
  },
  {
    name: "opaque high-entropy blob",
    raw: "state 7Qk2Lm4Rt8Wv6Yb1Nc3Kd5Fg7Hj0PsQwErTyUi9zQx4Lm2",
    forbidden: "7Qk2Lm4Rt8Wv6Yb1Nc3Kd5Fg7Hj0PsQwErTyUi9zQx4Lm2",
  },
  /**
   * The four below close a gap this table itself had: the plan's invariant
   * names "provider, pairing, capability, sudo, or SSH secrets", but only the
   * first two had a canary, and the other three all leaked in full.
   *
   * The SSH cases are the interesting ones. An OpenSSH private-key body is
   * mostly letters and `A` padding, so its DIGIT DENSITY sits below the
   * generic entropy threshold — the heuristic that catches an opaque blob is
   * anti-correlated with real key material and waved these straight through.
   * They are caught by their fixed base64 magic instead, not by entropy.
   */
  {
    name: "ssh private key block",
    raw:
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n" +
      "-----END OPENSSH PRIVATE KEY-----",
    forbidden: "b3BlbnNzaC1rZXktdjE",
  },
  {
    name: "ssh private key body with no PEM markers",
    raw: "identity b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    forbidden: "b3BlbnNzaC1rZXktdjE",
  },
  {
    name: "sudo password answered at a prompt",
    raw: "[sudo] password for alice: Tr0ub4dor3xKlausW",
    forbidden: "Tr0ub4dor3xKlausW",
  },
  {
    name: "capability grant token in a compound key",
    raw: "capabilityToken=cap_9zQx4Lm2Rt8Wv6Yb1Nc3Kd5",
    forbidden: "cap_9zQx4Lm2Rt8Wv6Yb1Nc3Kd5",
  },
] as const;

/**
 * The plan's invariant enumerates the secret KINDS that must never reach a
 * bundle. Set equality against the canary table's own coverage labels makes a
 * newly named kind fail here rather than silently shipping unguarded — the
 * failure mode this table just had for sudo, SSH, and capability secrets.
 */
const DECLARED_SECRET_KINDS = ["provider", "pairing", "capability", "sudo", "ssh"] as const;

const CANARY_KIND_COVERAGE: Readonly<Record<(typeof DECLARED_SECRET_KINDS)[number], string>> = {
  provider: "provider api key",
  pairing: "pairing password assignment",
  capability: "capability grant token in a compound key",
  sudo: "sudo password answered at a prompt",
  ssh: "ssh private key block",
};

/**
 * A prompt has no recognizable shape, so the gate refuses prose by length
 * rather than pretending it can spot one. This is the canary for that rule.
 */
const PROMPT_CANARY =
  "Please refactor the billing reconciliation module so that the nightly settlement job " +
  "retries failed charges against the merchant of record, and make sure the customer " +
  "named in the escalation ticket is never double charged for the annual plan renewal.";

describe("SupportBundleRedaction gate", () => {
  for (const canary of SECRET_CANARIES) {
    it(`removes a ${canary.name}`, () => {
      const outcome = redactSupportText(canary.raw);
      assert.isFalse(
        outcome.value.includes(canary.forbidden),
        `gate leaked ${canary.name}: ${outcome.value}`,
      );
      assert.isTrue(
        outcome.redacted || outcome.omitted,
        `gate reported ${canary.name} as clean: ${outcome.value}`,
      );
    });
  }

  it("carries a canary for every secret kind the plan's invariant names", () => {
    const canaryNames = new Set(SECRET_CANARIES.map((canary) => canary.name));
    for (const kind of DECLARED_SECRET_KINDS) {
      const name = CANARY_KIND_COVERAGE[kind];
      assert.isTrue(
        canaryNames.has(name),
        `secret kind "${kind}" claims coverage by a canary named "${name}", which no longer exists`,
      );
    }
    assert.deepEqual(
      Object.keys(CANARY_KIND_COVERAGE).sort(),
      [...DECLARED_SECRET_KINDS].sort(),
      "every declared secret kind must name the canary that covers it",
    );
  });

  it("holds its post-condition on every canary output", () => {
    for (const canary of SECRET_CANARIES) {
      const outcome = redactSupportText(canary.raw);
      assert.isFalse(
        containsSupportCredentialShape(outcome.value),
        `credential-shaped residue survived ${canary.name}: ${outcome.value}`,
      );
    }
  });

  it("refuses a prompt rather than shipping prose", () => {
    const outcome = redactSupportText(PROMPT_CANARY);
    assert.strictEqual(outcome.value, SUPPORT_BUNDLE_PLACEHOLDERS.oversized);
    assert.isTrue(outcome.omitted);
    assert.isFalse(outcome.value.includes("reconciliation"));
  });

  it("redacts an explicitly supplied home directory even when it is relocated", () => {
    const outcome = redactSupportText("state dir /var/data/ctoxhome/userdata/logs", {
      homeDirectory: "/var/data/ctoxhome",
    });
    assert.isFalse(outcome.value.includes("ctoxhome"));
    assert.isTrue(outcome.value.includes(SUPPORT_BUNDLE_PLACEHOLDERS.path));
  });

  it("omits rather than truncates an oversized value", () => {
    const outcome = redactSupportText("x".repeat(SUPPORT_BUNDLE_MAX_FIELD_LENGTH + 1));
    assert.strictEqual(outcome.value, SUPPORT_BUNDLE_PLACEHOLDERS.oversized);
    assert.isTrue(outcome.omitted);
  });

  it("omits a non-string", () => {
    assert.strictEqual(
      redactSupportText({ token: "secret" }).value,
      SUPPORT_BUNDLE_PLACEHOLDERS.unredactable,
    );
  });

  it("keeps ordinary diagnostics verbatim", () => {
    for (const benign of [
      "0.0.33",
      "darwin",
      "local-only",
      "desktop.appIdentity.resolveUserDataPath",
      "resolveRemoteT3CliPackageSpec",
      "DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES",
      "bootstrap resolved backend endpoint",
      "a1b2c3d4e5f6",
    ]) {
      const outcome = redactSupportText(benign);
      assert.strictEqual(outcome.value, benign, `gate mangled a benign value: ${benign}`);
      assert.isFalse(outcome.redacted);
      assert.isFalse(outcome.omitted);
    }
  });
});

describe("SupportBundleRedaction ledger", () => {
  it("counts clean, redacted, and omitted values separately", () => {
    const ledger = makeSupportRedactionLedger();
    gateText(ledger, "darwin");
    gateText(ledger, "signed in as alice@example.com");
    gateText(ledger, 42);
    assert.deepStrictEqual(ledger, {
      cleanFieldCount: 1,
      redactedFieldCount: 1,
      omittedFieldCount: 1,
    });
  });

  it("admits only known labels", () => {
    const ledger = makeSupportRedactionLedger();
    assert.strictEqual(gateLabel(ledger, "latest", ["latest", "nightly"]), "latest");
    assert.strictEqual(
      gateLabel(ledger, "my private channel", ["latest", "nightly"]),
      SUPPORT_BUNDLE_PLACEHOLDERS.unredactable,
    );
  });

  it("bounds numbers and refuses non-numbers", () => {
    const ledger = makeSupportRedactionLedger();
    assert.strictEqual(gateCount(ledger, 12), 12);
    assert.strictEqual(gateCount(ledger, -1), 0);
    assert.strictEqual(gateCount(ledger, Number.NaN), 0);
    assert.strictEqual(gateCount(ledger, 5_000_000, 100), 100);
    assert.strictEqual(gateInteger(ledger, -7), -7);
    assert.strictEqual(gateInteger(ledger, "9"), 0);
    assert.isTrue(gateBoolean(ledger, true));
    assert.isFalse(gateBoolean(ledger, "true"));
  });
});

describe("SupportBundleRedaction log projection", () => {
  it("drops the raw child-process output a log record carries", () => {
    const ledger = makeSupportRedactionLedger();
    const line = JSON.stringify({
      message: "backend child process output",
      level: "ERROR",
      timestamp: "2026-08-20T09:41:02.500Z",
      fiberId: "#backend-child",
      annotations: {
        component: "desktop-backend-child",
        stream: "stdout",
        text: `user prompt: ${PROMPT_CANARY} apiKey=sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5`,
      },
      spans: {},
    });

    const projected = gateLogLine(ledger, line);
    assert.isTrue(projected.includes("backend child process output"));
    assert.isTrue(projected.includes("desktop-backend-child"));
    assert.isTrue(projected.includes("ERROR"));
    assert.isFalse(projected.includes("reconciliation"));
    assert.isFalse(projected.includes("sk-ant-api03"));
    assert.isFalse(projected.includes("stdout"));
  });

  it("refuses a line that is not a structured record", () => {
    const ledger = makeSupportRedactionLedger();
    assert.strictEqual(
      gateLogLine(ledger, "plain stdout line with a token sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5"),
      SUPPORT_BUNDLE_PLACEHOLDERS.unredactable,
    );
    assert.strictEqual(
      gateLogLine(ledger, JSON.stringify({ annotations: { text: "no message key" } })),
      SUPPORT_BUNDLE_PLACEHOLDERS.unredactable,
    );
    assert.strictEqual(ledger.omittedFieldCount, 2);
  });

  it("still redacts a path interpolated into a log message", () => {
    const ledger = makeSupportRedactionLedger();
    const projected = gateLogLine(
      ledger,
      JSON.stringify({
        message: "runtime logging configured /Users/alice/.t3/userdata/logs",
        level: "INFO",
      }),
    );
    assert.isFalse(projected.includes("alice"));
    assert.isTrue(projected.includes(SUPPORT_BUNDLE_PLACEHOLDERS.path));
  });
});
