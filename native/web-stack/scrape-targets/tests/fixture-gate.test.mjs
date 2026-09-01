import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";

const testDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const targetsDir = NodePath.dirname(testDir);
const fixturesDir = NodePath.join(testDir, "fixtures");
const mockCtox = NodePath.join(testDir, "mock-ctox.mjs");
const sharedScript = NodePath.join(targetsDir, "_shared", "generic-prospect-v1.js");
const PROTECTED_TARGETS = [
  "dnbhoovers.com",
  "leadfeeder.com",
  "linkedin.com",
  "rocketreach.com",
  "xing.com",
];
const PUBLIC_UNLOCK_TARGETS = [
  "bundesanzeiger.de",
  "companyhouse.de",
  "handelsregister.de",
  "northdata.de",
];

const FIELD_KEYS = new Set([
  "firma_name",
  "firma_anschrift",
  "firma_plz",
  "firma_ort",
  "firma_email",
  "firma_domain",
  "firma_telefon",
  "firma_fax",
  "wz_code",
  "umsatz",
  "mitarbeiter",
  "crm_record_number",
  "person_geschlecht",
  "person_titel",
  "person_vorname",
  "person_nachname",
  "person_funktion",
  "person_position",
  "person_email",
  "person_email_validation",
  "person_telefon",
  "person_linkedin",
  "person_xing",
]);

function targetDirectories() {
  return NodeFS.readdirSync(targetsDir)
    .filter((name) => !name.startsWith("_") && name !== "tests")
    .filter((name) => NodeFS.statSync(NodePath.join(targetsDir, name)).isDirectory())
    .filter((name) =>
      NodeFS.statSync(NodePath.join(targetsDir, name, "target.json"), { throwIfNoEntry: false }),
    )
    .sort();
}

function loadJson(file) {
  return JSON.parse(NodeFS.readFileSync(file, "utf8"));
}

function resolvedScript(targetName) {
  const specialized = NodePath.join(targetsDir, targetName, "scripts", "v1.js");
  return NodeFS.statSync(specialized, { throwIfNoEntry: false }) ? specialized : sharedScript;
}

function executeFixture(targetName, fixturePath, mode, inputOverride) {
  const fixture = loadJson(fixturePath);
  const outputDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), `ctox-scrape-${targetName}-`),
  );
  const callLog = NodePath.join(outputDir, "ctox-calls.jsonl");
  try {
    const child = NodeChildProcess.spawnSync(process.execPath, [resolvedScript(targetName)], {
      cwd: targetsDir,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        CTOX_BIN: mockCtox,
        CTOX_SCRAPE_FIXTURE: fixturePath,
        CTOX_SCRAPE_FIXTURE_MODE: mode,
        CTOX_SCRAPE_CALL_LOG: callLog,
        CTOX_SCRAPE_INPUT_JSON: JSON.stringify(
          inputOverride === undefined ? fixture.input : inputOverride,
        ),
        CTOX_SCRAPE_OUTPUT_DIR: outputDir,
      },
    });
    NodeAssert.equal(child.signal, null, `${targetName}/${mode} timed out`);
    NodeAssert.equal(child.status, 0, `${targetName}/${mode}: ${child.stderr || child.stdout}`);
    NodeAssert.doesNotThrow(
      () => JSON.parse(child.stdout),
      `${targetName}/${mode} returned invalid JSON`,
    );
    const calls = NodeFS.statSync(callLog, { throwIfNoEntry: false })
      ? NodeFS.readFileSync(callLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).args)
      : [];
    return { result: JSON.parse(child.stdout), calls };
  } finally {
    NodeFS.rmSync(outputDir, { recursive: true, force: true });
  }
}

function runFixture(targetName, fixturePath, mode) {
  return executeFixture(targetName, fixturePath, mode).result;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function containsForbiddenSecretKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenSecretKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /^(?:password|passwd|token|api[_-]?key|secret_value|credential_value)$/i.test(key) ||
      containsForbiddenSecretKey(item),
  );
}

NodeTest.test("all DACH research scrape targets pass production-like fixture gates", async (t) => {
  const targets = targetDirectories();
  NodeAssert.equal(targets.length, 16, `expected 16 targets, found: ${targets.join(", ")}`);

  const seenKeys = new Set();
  for (const targetName of targets) {
    await t.test(targetName, () => {
      const manifest = loadJson(NodePath.join(targetsDir, targetName, "target.json"));
      const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
      const fixture = loadJson(fixturePath);
      const script = resolvedScript(targetName);

      NodeAssert.equal(manifest.status, "active");
      NodeAssert.equal(manifest.target_kind, "prospect-research");
      NodeAssert.ok(String(manifest.config?.expected_provider || "").trim());
      NodeAssert.ok(Array.isArray(manifest.config?.country_hints));
      NodeAssert.ok(manifest.config.country_hints.length > 0);
      NodeAssert.deepEqual(manifest.config?.record_key_fields, ["field", "source_url"]);
      NodeAssert.equal(manifest.output_schema?.schema_key, "prospect.v1");
      NodeAssert.deepEqual(manifest.output_schema?.record_key_fields, ["field", "source_url"]);
      NodeAssert.ok(
        !seenKeys.has(manifest.target_key),
        `duplicate target_key ${manifest.target_key}`,
      );
      seenKeys.add(manifest.target_key);
      NodeAssert.ok(script.endsWith("/scripts/v1.js") || script === sharedScript);
      NodeAssert.equal(fixture.input.source_id, targetName);

      const success = runFixture(targetName, fixturePath, "success");
      NodeAssert.ok(Array.isArray(success.records), `${targetName} must emit records[]`);
      NodeAssert.ok(success.records.length > 0, `${targetName} fixture produced no records`);
      for (const record of success.records) {
        NodeAssert.ok(
          FIELD_KEYS.has(record.field),
          `${targetName} emitted untyped field ${record.field}`,
        );
        NodeAssert.ok(
          String(record.value || "").trim(),
          `${targetName}/${record.field} has no value`,
        );
        NodeAssert.ok(["low", "medium", "high", "user_provided"].includes(record.confidence));
        NodeAssert.doesNotThrow(
          () => new URL(record.source_url),
          `${targetName}/${record.field} has invalid source_url`,
        );
      }
      for (const [field, expectedValue] of Object.entries(fixture.expected)) {
        NodeAssert.ok(
          success.records.some(
            (record) => record.field === field && record.value === expectedValue,
          ),
          `${targetName} missing ${field}=${expectedValue}: ${JSON.stringify(success.records)}`,
        );
      }

      for (const mode of ["identity_mismatch", "portal", "login"]) {
        const rejected = runFixture(targetName, fixturePath, mode);
        NodeAssert.deepEqual(rejected.records, [], `${targetName} accepted ${mode} evidence`);
      }
    });
  }
});

NodeTest.test(
  "protected research adapters use secret references and Browser-App handoff",
  async (t) => {
    for (const targetName of PROTECTED_TARGETS) {
      await t.test(targetName, () => {
        const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
        const fixture = loadJson(fixturePath);
        NodeAssert.equal(
          containsForbiddenSecretKey(fixture),
          false,
          `${targetName} fixture contains a credential value`,
        );
        NodeAssert.match(fixture.input.credential_ref, /^ctox-secret:\/\/credentials\/[A-Z0-9_]+$/);

        const { result, calls } = executeFixture(targetName, fixturePath, "auth_required");
        NodeAssert.deepEqual(
          result.records,
          [],
          `${targetName} fabricated records without a login`,
        );
        NodeAssert.equal(result.failure_mode, "authorization_required");
        NodeAssert.equal(result.browser_assist_requested, true);

        const reauthorization = result.reauthorization;
        NodeAssert.ok(reauthorization, `${targetName} did not persist a reauthorization action`);
        NodeAssert.equal(reauthorization.kind, "auth-assist-request");
        NodeAssert.equal(reauthorization.source_id, targetName);
        NodeAssert.equal(reauthorization.login_url, fixture.login_url);
        for (const domain of fixture.browser_allowed_domains) {
          NodeAssert.ok(
            reauthorization.allowed_domains.some(
              (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
            ),
            `${targetName} reauthorization allow-list ${JSON.stringify(reauthorization.allowed_domains)} does not cover ${domain}`,
          );
        }
        NodeAssert.equal(reauthorization.credential_ref, fixture.input.credential_ref);
        NodeAssert.equal(reauthorization.reason, "session_expired_or_invalid");
        NodeAssert.equal(reauthorization.secret_value_in_payload, false);
        NodeAssert.equal(
          containsForbiddenSecretKey(result),
          false,
          `${targetName} result contains a credential value`,
        );

        const handoff = calls.find(
          (args) => args[0] === "business-os" && args.includes("auth-assist-request"),
        );
        NodeAssert.ok(handoff, `${targetName} did not open a Browser-App authorization request`);
        NodeAssert.equal(flagValue(handoff, "--credential-ref"), fixture.input.credential_ref);
        NodeAssert.equal(flagValue(handoff, "--target-url"), fixture.login_url);
        NodeAssert.equal(flagValue(handoff, "--task-id"), fixture.input.task_id);
        NodeAssert.ok(!calls.flat().some((arg) => /(?:password|passwd)=/i.test(String(arg))));
      });
    }
  },
);

NodeTest.test(
  "expired-session login landing stays distinguishable from genuine portal drift",
  async (t) => {
    for (const targetName of PROTECTED_TARGETS) {
      await t.test(targetName, () => {
        const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
        // Genuine drift/input failure: no usable input at all. The script must
        // NOT cry reauthorization without evidence of a login landing; the
        // native executor upgrades this to authorization_required only when the
        // portal probe actually lands on the source's own login page.
        const { result, calls } = executeFixture(targetName, fixturePath, "success", {});
        NodeAssert.equal(result.failure_mode, "portal_drift");
        NodeAssert.deepEqual(result.records, []);
        NodeAssert.equal(result.reauthorization, undefined);
        NodeAssert.equal(result.browser_assist_requested, undefined);
        NodeAssert.ok(
          !calls.some((args) => args[0] === "business-os" && args.includes("auth-assist-request")),
          `${targetName} emitted an auth handoff without a login landing`,
        );
      });
    }
  },
);

NodeTest.test("public sources without credentials never emit auth handoffs", async (t) => {
  for (const targetName of ["zefix.ch", "experte.de", "bundesanzeiger.de"]) {
    await t.test(targetName, () => {
      const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
      for (const mode of ["success", "blocked", "auth_required"]) {
        const { result, calls } = executeFixture(targetName, fixturePath, mode);
        NodeAssert.equal(
          result.reauthorization,
          undefined,
          `${targetName}/${mode} emitted a reauthorization action`,
        );
        NodeAssert.notEqual(
          result.failure_mode,
          "authorization_required",
          `${targetName}/${mode} claimed reauthorization`,
        );
        NodeAssert.ok(
          !calls.some((args) => args[0] === "business-os" && args.includes("auth-assist")),
          `${targetName}/${mode} opened an auth-assist handoff without a protected config`,
        );
      }
    });
  }
});

NodeTest.test(
  "protected providers resume capture after secret-backed Browser-App login",
  async (t) => {
    for (const targetName of PROTECTED_TARGETS) {
      await t.test(targetName, () => {
        const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
        const fixture = loadJson(fixturePath);
        const { result, calls } = executeFixture(targetName, fixturePath, "auth_recovery");
        for (const [field, expectedValue] of Object.entries(fixture.expected)) {
          NodeAssert.ok(
            result.records.some(
              (record) => record.field === field && record.value === expectedValue,
            ),
          );
        }
        const login = calls.find(
          (args) => args[0] === "business-os" && args.includes("auth-assist-login"),
        );
        NodeAssert.ok(login, `${targetName} did not run the native secret-backed login`);
        NodeAssert.equal(flagValue(login, "--credential-ref"), fixture.input.credential_ref);
        const captures = calls.filter(
          (args) => args[0] === "business-os" && args.includes("source-capture"),
        );
        NodeAssert.equal(captures.length, 2);
        NodeAssert.match(flagValue(captures[1], "--session-id"), /^browser_session_fixture_/);
      });
    }
  },
);

NodeTest.test(
  "protected captures retry transient provider failures after secret-backed login",
  () => {
    const targetName = "dnbhoovers.com";
    const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
    const fixture = loadJson(fixturePath);
    const { result, calls } = executeFixture(targetName, fixturePath, "capture_retry");
    NodeAssert.ok(
      result.records.some(
        (record) => record.field === "firma_name" && record.value === fixture.expected.firma_name,
      ),
    );
    NodeAssert.ok(
      calls.some((args) => args[0] === "business-os" && args.includes("auth-assist-login")),
    );
    NodeAssert.equal(
      calls.filter((args) => args[0] === "business-os" && args.includes("source-capture")).length,
      2,
    );
  },
);

NodeTest.test(
  "RocketReach keeps exact public provider evidence while protected fields await authorization",
  () => {
    const targetName = "rocketreach.com";
    const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
    const fixture = loadJson(fixturePath);
    const { result, calls } = executeFixture(targetName, fixturePath, "provider_page_blocked");
    NodeAssert.ok(
      result.records.some(
        (record) => record.field === "firma_name" && record.value === fixture.expected.firma_name,
      ),
    );
    NodeAssert.equal(result.partial, true);
    NodeAssert.equal(result.protected_fields_require_authorization, true);
    NodeAssert.equal(result.browser_assist_requested, true);
    NodeAssert.ok(
      calls.some((args) => args[0] === "business-os" && args.includes("auth-assist-request")),
    );
  },
);

NodeTest.test(
  "blocked protected adapters record Web-Unlock evidence and stay non-green",
  async (t) => {
    for (const targetName of PROTECTED_TARGETS) {
      await t.test(targetName, () => {
        const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
        const { result, calls } = executeFixture(targetName, fixturePath, "blocked");
        NodeAssert.deepEqual(result.records, []);
        NodeAssert.equal(result.failure_mode, "blocked");
        NodeAssert.equal(result.browser_assist_requested, true);
        const unlock = calls.find(
          (args) =>
            args[0] === "web" &&
            args[1] === "unlock" &&
            args[2] === "signals" &&
            args[3] === "record",
        );
        NodeAssert.ok(unlock, `${targetName} did not record a Web-Unlock signal`);
        const evidence = JSON.parse(flagValue(unlock, "--evidence"));
        NodeAssert.equal(evidence.source_id, targetName);
        NodeAssert.equal(evidence.secret_value_in_payload, false);
        NodeAssert.ok(
          calls.some((args) => args[0] === "business-os" && args.includes("auth-assist-request")),
        );
      });
    }
  },
);

NodeTest.test(
  "blocked public adapters record Web-Unlock evidence and stay non-green",
  async (t) => {
    for (const targetName of PUBLIC_UNLOCK_TARGETS) {
      await t.test(targetName, () => {
        const fixturePath = NodePath.join(fixturesDir, `${targetName}.json`);
        const { result, calls } = executeFixture(targetName, fixturePath, "blocked");
        NodeAssert.deepEqual(result.records, [], `${targetName} fabricated records while blocked`);
        NodeAssert.notEqual(result.failure_mode, "succeeded");

        const unlock = calls.find(
          (args) => args[0] === "web" && args.includes("unlock") && args.includes("record"),
        );
        NodeAssert.ok(unlock, `${targetName} did not record a Web-Unlock signal`);
        const evidence = JSON.parse(flagValue(unlock, "--evidence"));
        NodeAssert.equal(evidence.source_id, targetName);
        NodeAssert.equal(evidence.secret_value_in_payload, false);
      });
    }
  },
);
