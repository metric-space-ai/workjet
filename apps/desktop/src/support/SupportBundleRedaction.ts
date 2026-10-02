// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * THE REDACTION GATE.
 *
 * Every value that reaches a support bundle or a crash report passes through
 * {@link redactSupportText} (or one of the typed helpers built on it). There
 * is no second path: `DesktopSupportBundle` and `DesktopCrashReporting` build
 * their documents exclusively out of gate results, and the bundle document's
 * schema (`@t3tools/contracts/supportBundle`) accepts only the bounded,
 * control-character-free strings the gate produces.
 *
 * The gate is deny-biased and works in four stages:
 *
 *  1. ADMISSION — a non-string, an oversized input, or PROSE (more than
 *     {@link SUPPORT_BUNDLE_MAX_WORDS} words) is refused outright and replaced
 *     by a named `[omitted:*]` placeholder. Nothing is truncated: a truncated
 *     secret is still a leaked prefix, and a truncated line is a lie about
 *     what it said. The prose rule is what keeps a PROMPT out: prompt text
 *     has no recognizable shape, so the gate refuses free prose by length
 *     instead of pretending it can spot one.
 *  2. SUBSTITUTION — recognized secret shapes are replaced in place by named
 *     `[redacted:*]` placeholders, so the surrounding, harmless text survives
 *     and stays diagnostic. In order: authorization headers, `key=secret`
 *     assignments, well-known credential prefixes, emails, URLs (reduced to
 *     scheme + authority), the home directory, filesystem paths, and finally
 *     generic high-entropy runs.
 *  3. RESIDUE CHECK — after substitution the result is re-inspected. If any
 *     high-entropy run survived, the WHOLE value is refused with
 *     `[omitted:unredactable]` rather than shipped partially cleaned. This is
 *     the stage that covers shapes the gate was never taught: an unknown
 *     credential still looks like entropy.
 *  4. BOUND — a result longer than {@link SUPPORT_BUNDLE_MAX_FIELD_LENGTH} is
 *     refused as `[omitted:oversized]`, never trimmed to fit.
 *
 * {@link gateLogLine} is stricter still. A raw log line is never admitted as
 * free text, because the desktop's child-process log carries whatever the
 * server wrote to stdout — the one place a prompt or a provider payload could
 * realistically appear. Instead the line is parsed as the structured NDJSON
 * record the desktop writes and only its *named* fields (timestamp, level,
 * component, message) are projected out, each through the gate. Everything
 * else in the record, `annotations.text` above all, is structurally dropped.
 *
 * The counters on {@link SupportRedactionLedger} exist so the bundle can say
 * how much it withheld. A bundle that hid twenty fields and says so is
 * useful; one that hid them silently is not.
 */
import {
  SUPPORT_BUNDLE_MAX_FIELD_LENGTH,
  SUPPORT_BUNDLE_MAX_RAW_LENGTH,
  SUPPORT_BUNDLE_PLACEHOLDERS,
  type SupportBundleRedactionPlaceholder,
} from "@t3tools/contracts";

/**
 * Most words a single gated value may contain. Diagnostics are short: a
 * version, a mode, a span name, a log message. Anything longer is prose, and
 * prose is where prompts, model output, and pasted secrets live.
 */
export const SUPPORT_BUNDLE_MAX_WORDS = 32;

/**
 * Shortest generic run treated as a credential. Deliberately long: shorter
 * thresholds swallow ordinary camel-case identifiers out of stack frames,
 * which makes the bundle useless without making it safer.
 */
const ENTROPY_RUN_LENGTH = 28;

/**
 * Generic credential shape: a long unbroken run of base64/hex characters.
 * `.`, `_` and `-` are NOT part of the class — including them turns every
 * dotted span name and every SCREAMING_SNAKE constant into a false positive —
 * so the well-known prefixes below carry the shapes that need them.
 */
const ENTROPY_RUN = /[A-Za-z0-9+/=]{28,}/gu;

/**
 * A long alphanumeric run is only a credential when it actually carries
 * entropy. `resolveRemoteT3CliPackageSpec` is 29 characters with one digit;
 * a base64 token of the same length has five or more, and a hex digest more
 * still. Base64 padding and the `+`/`/` alphabet are decisive on their own.
 */
const DIGIT_DENSITY_THRESHOLD = 0.15;

const looksLikeCredentialRun = (run: string): boolean => {
  if (run.length < ENTROPY_RUN_LENGTH) return false;
  if (/[+/=]/u.test(run)) return true;
  const digitCount = (run.match(/[0-9]/gu) ?? []).length;
  return digitCount / run.length >= DIGIT_DENSITY_THRESHOLD;
};

const replaceCredentialRuns = (value: string): string =>
  value.replace(ENTROPY_RUN, (run) =>
    looksLikeCredentialRun(run) ? SUPPORT_BUNDLE_PLACEHOLDERS.token : run,
  );

/**
 * The gate's POST-CONDITION: no value it returns may still contain a
 * credential-shaped run. Exported so the canary tests can assert the
 * post-condition directly on every gate output rather than trusting the
 * substitution list to have been exhaustive.
 */
export const containsSupportCredentialShape = (value: string): boolean => {
  for (const match of value.replace(PLACEHOLDER_TOKEN, " ").matchAll(ENTROPY_RUN)) {
    if (looksLikeCredentialRun(match[0])) return true;
  }
  return false;
};

/**
 * Credential shapes whose separators (`-`, `_`, `.`) would otherwise break
 * them below the generic run threshold: provider keys, VCS tokens, cloud
 * keys, and JWTs.
 */
const KNOWN_CREDENTIAL = new RegExp(
  [
    "sk-[A-Za-z0-9_-]{12,}",
    "sk_[A-Za-z0-9]{12,}",
    "gh[pousr]_[A-Za-z0-9]{12,}",
    "glpat-[A-Za-z0-9_-]{12,}",
    "npm_[A-Za-z0-9]{12,}",
    "xox[baprs]-[A-Za-z0-9-]{12,}",
    "AKIA[0-9A-Z]{12,}",
    "AIza[0-9A-Za-z_-]{12,}",
    "eyJ[A-Za-z0-9_-]{8,}(?:\\.[A-Za-z0-9_-]+){1,2}",
    // Private-key BODIES, by their fixed base64 magic. The generic entropy run
    // cannot see these: an OpenSSH key body is mostly letters and `A` padding,
    // so its digit density sits far BELOW the threshold — the heuristic is
    // anti-correlated with exactly this shape. `b3BlbnNzaC1rZXktdjE` is
    // base64("openssh-key-v1"); `MII` opens every base64 DER key and cert.
    "b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*",
    "MII[A-Za-z0-9+/=]{16,}",
  ].join("|"),
  "gu",
);

/**
 * A PEM block, collapsed onto one line by the whitespace normalizer before the
 * substitutions run. Matched whole — including a TRUNCATED block whose `END`
 * marker never arrived, which is the usual shape in a log tail.
 */
const PEM_PRIVATE_KEY =
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/gu;

/**
 * `[sudo] password for alice: hunter2` and bare `Password: hunter2`. The
 * assignment rule below cannot see these: the keyword is separated from the
 * `:` by " for <user>", and a typed password is usually far too short to reach
 * the generic entropy threshold. Everything after the colon goes.
 */
const PASSWORD_PROMPT = /(?:\[sudo\]\s*)?\b(?:password|passphrase)\b(?:\s+for\s+\S+)?\s*:\s*\S+/giu;

/**
 * Words whose assigned value is a credential, matched against `word = value`,
 * `word: value`, and quoted JSON shapes, case-insensitively — these appear in
 * logs, in query strings, and in configuration dumps alike.
 */
const SECRET_KEY_WORDS = [
  "password",
  "passwd",
  "passphrase",
  "pairing",
  "pairingpassword",
  "pairingtoken",
  "pairing_token",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "cookie",
  "sessionid",
  "session_id",
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
];

/**
 * The keyword may be the TAIL of a compound identifier: `capabilityToken`,
 * `sudoPassword`, `sshPassphrase`, `providerApiKey`. Without the prefix the
 * word boundary falls inside the identifier (`…yToken` has no `\b` before
 * `Token`), so every camel-cased secret name slipped through while the bare
 * word was caught — which is why the list previously had to spell out
 * `pairingtoken` by hand.
 */
const SECRET_ASSIGNMENT = new RegExp(
  `\\b[A-Za-z0-9_]*(?:${SECRET_KEY_WORDS.join("|")})\\b["']?\\s*[:=]\\s*["']?[^\\s"',;)\\]}]+`,
  "giu",
);

/**
 * `Authorization: Bearer x`, `authorization=Basic y`, and a bare `Bearer z`.
 * The credential must be at least eight unbroken characters so the ordinary
 * English word "basic" followed by a short word is not mistaken for a header.
 */
const AUTHORIZATION_HEADER =
  /(?:\bauthorization\b\s*["']?\s*[:=]\s*["']?)?\b(?:bearer|basic|digest)\s+[^\s"',;)\]}]{8,}/giu;

const EMAIL =
  /[^\s<>@,;:"'()[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/gu;

/** Any URL. Kept as scheme + authority; userinfo, path, query, fragment go. */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/giu;

/**
 * POSIX absolute paths (`/Users/alice/...`, `/home/bob/...`) and Windows ones
 * (`C:\Users\alice\...`, `\\server\share\x`). A path is personally
 * identifying — it usually contains the account name — and often names a
 * project the user never agreed to disclose, so the whole path goes.
 */
const POSIX_PATH = /(?<![A-Za-z0-9_])\/(?:[A-Za-z0-9._~%+-]+\/)+[A-Za-z0-9._~%+-]*/gu;
const WINDOWS_PATH = /(?:[A-Za-z]:|\\)\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/gu;

const WHITESPACE_RUN = /\s+/gu;
/** A bundle field must be one printable line, so every control character goes. */
const CONTROL_CHARACTER = /\p{Cc}/gu;

/** Every placeholder, so the residue check ignores what the gate itself wrote. */
const PLACEHOLDER_TOKEN = /\[(?:redacted|omitted):[a-z]+\]/gu;

export interface SupportRedactionLedger {
  /** Values that survived with at least one substitution applied. */
  redactedFieldCount: number;
  /** Values refused outright and replaced by an `[omitted:*]` placeholder. */
  omittedFieldCount: number;
  /** Values that passed through untouched. */
  cleanFieldCount: number;
}

export const makeSupportRedactionLedger = (): SupportRedactionLedger => ({
  redactedFieldCount: 0,
  omittedFieldCount: 0,
  cleanFieldCount: 0,
});

export interface SupportRedactionOutcome {
  readonly value: string;
  /** True when a substitution ran: the value survived but is not verbatim. */
  readonly redacted: boolean;
  /** True when the whole value was refused; `value` is an `[omitted:*]`. */
  readonly omitted: boolean;
}

export interface SupportRedactionOptions {
  /**
   * Redacted before the generic path rules run, so a relocated home (an
   * `XDG_CONFIG_HOME` or `T3_HOME` override) is caught even when it is not
   * shaped like a home directory.
   */
  readonly homeDirectory?: string;
}

const omit = (placeholder: SupportBundleRedactionPlaceholder): SupportRedactionOutcome => ({
  value: placeholder,
  redacted: false,
  omitted: true,
});

/**
 * Reduces a URL to `scheme://host[:port]`, dropping userinfo (a credential
 * outright), path, query, and fragment (tokens, project names, prompts). An
 * unparseable URL is refused wholesale.
 */
const reduceUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    return url.host === "" ? SUPPORT_BUNDLE_PLACEHOLDERS.url : `${url.protocol}//${url.host}`;
  } catch {
    return SUPPORT_BUNDLE_PLACEHOLDERS.url;
  }
};

/**
 * The gate. Returns the value a bundle field may carry, plus whether it was
 * altered — never the original.
 */
export function redactSupportText(
  raw: unknown,
  options: SupportRedactionOptions = {},
): SupportRedactionOutcome {
  if (typeof raw !== "string") {
    return omit(SUPPORT_BUNDLE_PLACEHOLDERS.unredactable);
  }
  if (raw.length > SUPPORT_BUNDLE_MAX_RAW_LENGTH) {
    return omit(SUPPORT_BUNDLE_PLACEHOLDERS.oversized);
  }

  const normalized = raw.replace(CONTROL_CHARACTER, " ").replace(WHITESPACE_RUN, " ").trim();
  if (normalized.length === 0) {
    return { value: "", redacted: false, omitted: false };
  }
  if (normalized.split(" ").length > SUPPORT_BUNDLE_MAX_WORDS) {
    return omit(SUPPORT_BUNDLE_PLACEHOLDERS.oversized);
  }

  let working = normalized;

  const home = options.homeDirectory?.trim();
  if (home !== undefined && home.length > 2) {
    working = working.split(home).join(SUPPORT_BUNDLE_PLACEHOLDERS.path);
  }

  // Before the assignment rule: a PEM block's own body must not be picked
  // apart by the narrower rules first.
  working = working.replace(PEM_PRIVATE_KEY, SUPPORT_BUNDLE_PLACEHOLDERS.secret);
  working = working.replace(PASSWORD_PROMPT, SUPPORT_BUNDLE_PLACEHOLDERS.secret);
  working = working.replace(AUTHORIZATION_HEADER, SUPPORT_BUNDLE_PLACEHOLDERS.authorization);
  working = working.replace(SECRET_ASSIGNMENT, (match) => {
    const separatorIndex = match.search(/[:=]/u);
    const key =
      separatorIndex > 0 ? match.slice(0, separatorIndex).replace(/["']/gu, "").trim() : "";
    return key === ""
      ? SUPPORT_BUNDLE_PLACEHOLDERS.secret
      : `${key}=${SUPPORT_BUNDLE_PLACEHOLDERS.secret}`;
  });
  working = working.replace(KNOWN_CREDENTIAL, SUPPORT_BUNDLE_PLACEHOLDERS.token);
  working = working.replace(EMAIL, SUPPORT_BUNDLE_PLACEHOLDERS.email);
  working = working.replace(URL_LIKE, reduceUrl);
  working = working.replace(WINDOWS_PATH, SUPPORT_BUNDLE_PLACEHOLDERS.path);
  working = working.replace(POSIX_PATH, SUPPORT_BUNDLE_PLACEHOLDERS.path);
  working = replaceCredentialRuns(working);

  // Stage 3. Placeholders are not entropy; strip them before looking so
  // `[redacted:authorization]` cannot re-trigger the check.
  if (containsSupportCredentialShape(working)) {
    return omit(SUPPORT_BUNDLE_PLACEHOLDERS.unredactable);
  }

  if (working.length > SUPPORT_BUNDLE_MAX_FIELD_LENGTH) {
    return omit(SUPPORT_BUNDLE_PLACEHOLDERS.oversized);
  }

  return { value: working, redacted: working !== normalized, omitted: false };
}

/** Records one gate result on the ledger and returns the safe value. */
export function gateText(
  ledger: SupportRedactionLedger,
  raw: unknown,
  options: SupportRedactionOptions = {},
): string {
  const outcome = redactSupportText(raw, options);
  if (outcome.omitted) ledger.omittedFieldCount += 1;
  else if (outcome.redacted) ledger.redactedFieldCount += 1;
  else ledger.cleanFieldCount += 1;
  return outcome.value;
}

/**
 * A closed label: admitted verbatim only when it is one of the values this
 * build knows. Anything else is `[omitted:unredactable]`, because an
 * unrecognized "label" is by definition unvalidated text.
 */
export function gateLabel<T extends string>(
  ledger: SupportRedactionLedger,
  raw: unknown,
  allowed: ReadonlyArray<T>,
): string {
  if (typeof raw === "string" && (allowed as ReadonlyArray<string>).includes(raw)) {
    ledger.cleanFieldCount += 1;
    return raw;
  }
  ledger.omittedFieldCount += 1;
  return SUPPORT_BUNDLE_PLACEHOLDERS.unredactable;
}

/** An absent value, named rather than blank. */
export function gateUnavailable(ledger: SupportRedactionLedger): string {
  ledger.omittedFieldCount += 1;
  return SUPPORT_BUNDLE_PLACEHOLDERS.unavailable;
}

/**
 * A bounded non-negative integer. Non-finite, negative, and non-numeric
 * inputs collapse to `0` and count as omitted rather than riding along as
 * `NaN`, which JSON would silently turn into `null`.
 */
export function gateCount(ledger: SupportRedactionLedger, raw: unknown, max = 1_000_000): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    ledger.omittedFieldCount += 1;
    return 0;
  }
  const clamped = Math.min(Math.floor(raw), max);
  if (clamped !== raw) ledger.redactedFieldCount += 1;
  else ledger.cleanFieldCount += 1;
  return clamped;
}

/** A bounded signed integer, for priority-style values. */
export function gateInteger(
  ledger: SupportRedactionLedger,
  raw: unknown,
  bound = 1_000_000,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    ledger.omittedFieldCount += 1;
    return 0;
  }
  const clamped = Math.max(-bound, Math.min(Math.trunc(raw), bound));
  if (clamped !== raw) ledger.redactedFieldCount += 1;
  else ledger.cleanFieldCount += 1;
  return clamped;
}

/** A boolean. Anything that is not one is `false` and counts as omitted. */
export function gateBoolean(ledger: SupportRedactionLedger, raw: unknown): boolean {
  if (typeof raw !== "boolean") {
    ledger.omittedFieldCount += 1;
    return false;
  }
  ledger.cleanFieldCount += 1;
  return raw;
}

/** Log levels the projection recognizes. Anything else is dropped. */
const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL"] as const;

const readRecordString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Projects one raw log line into a bounded, gated summary.
 *
 * A log line is NOT free text this bundle may carry. `server-child.log`
 * records the backend child's stdout verbatim under `annotations.text`, which
 * is exactly where a prompt, a provider payload, or a pasted credential would
 * appear. So the line is parsed as the NDJSON record the desktop writes and
 * only four named fields are projected out — timestamp, level, component,
 * message — each of them through {@link redactSupportText}. Every other key,
 * `annotations.text` included, is dropped by construction rather than by a
 * pattern that might miss.
 *
 * A line that is not such a record is refused with a named placeholder.
 */
export function gateLogLine(
  ledger: SupportRedactionLedger,
  rawLine: string,
  options: SupportRedactionOptions = {},
): string {
  if (rawLine.length > SUPPORT_BUNDLE_MAX_RAW_LENGTH) {
    ledger.omittedFieldCount += 1;
    return SUPPORT_BUNDLE_PLACEHOLDERS.oversized;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    ledger.omittedFieldCount += 1;
    return SUPPORT_BUNDLE_PLACEHOLDERS.unredactable;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    ledger.omittedFieldCount += 1;
    return SUPPORT_BUNDLE_PLACEHOLDERS.unredactable;
  }

  const record = parsed as Record<string, unknown>;
  const message = readRecordString(record, "message") ?? readRecordString(record, "name");
  if (message === undefined) {
    ledger.omittedFieldCount += 1;
    return SUPPORT_BUNDLE_PLACEHOLDERS.unredactable;
  }

  const annotations = record.annotations;
  const componentSource =
    typeof annotations === "object" && annotations !== null && !Array.isArray(annotations)
      ? readRecordString(annotations as Record<string, unknown>, "component")
      : undefined;

  const levelRaw = readRecordString(record, "level")?.toUpperCase();
  const level =
    levelRaw !== undefined && (LOG_LEVELS as ReadonlyArray<string>).includes(levelRaw)
      ? levelRaw
      : undefined;

  // The four named parts are joined RAW and gated once, so the ledger sees a
  // single honest verdict for the line instead of one verdict per fragment.
  const projected = [readRecordString(record, "timestamp"), level, componentSource, message]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");

  const outcome = redactSupportText(projected, options);
  if (outcome.omitted) ledger.omittedFieldCount += 1;
  else if (outcome.redacted) ledger.redactedFieldCount += 1;
  else ledger.cleanFieldCount += 1;
  return outcome.value;
}
