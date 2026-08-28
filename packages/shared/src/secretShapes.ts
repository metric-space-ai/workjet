/**
 * THE SECRET-SHAPE TABLE.
 *
 * ONE declaration of what a secret looks like, shared by every gate that has
 * to recognize one:
 *
 *  - `apps/desktop/src/support/SupportBundleRedaction.ts` — the redaction gate
 *    every support-bundle and crash-report field passes through. It consumes
 *    the individual patterns because it must SUBSTITUTE each shape with its
 *    own named placeholder, in a fixed order.
 *  - `scripts/check-tracked-secrets.ts` — the tracked-file gate over
 *    `git ls-files`. It consumes {@link SECRET_SHAPES}, restricted to the
 *    entries that declare `scansSourceTree`.
 *  - `apps/web/src/browserStorageSecretCanary.test.ts` — the browser-storage
 *    canary. It consumes {@link BROWSER_STORAGE_SECRET_SHAPES}, which differs
 *    from the source-tree subset by exactly one shape.
 *
 * The table lives here, in a dependency-free module every workspace package
 * can import, because a second and drifting definition of "what a secret looks
 * like" is worse than none: the gate that is not updated becomes the one that
 * leaks, and nobody notices until the shape it never learned shows up in a
 * bundle. Everything below is browser-safe — plain strings and regular
 * expressions, no Node builtins, no `effect` — so the renderer canary can
 * import exactly the same declarations the release gate runs.
 *
 * NOT every shape is usable over every input, and the table says so per entry
 * rather than leaving each consumer to guess. `scansSourceTree` and
 * `scansBrowserStorage` carry the decisions and `reason` carries the argument;
 * a new shape that omits them fails the set-equality check in
 * `scripts/check-tracked-secrets.test.ts`.
 */

/**
 * Shortest generic run treated as a credential. Deliberately long: shorter
 * thresholds swallow ordinary camel-case identifiers out of stack frames,
 * which makes a support bundle useless without making it safer.
 */
export const ENTROPY_RUN_LENGTH = 28;

/**
 * Generic credential shape: a long unbroken run of base64/hex characters.
 * `.`, `_` and `-` are NOT part of the class — including them turns every
 * dotted span name and every SCREAMING_SNAKE constant into a false positive —
 * so the well-known prefixes below carry the shapes that need them.
 */
export const ENTROPY_RUN = /[A-Za-z0-9+/=]{28,}/gu;

/**
 * A long alphanumeric run is only a credential when it actually carries
 * entropy. `resolveRemoteT3CliPackageSpec` is 29 characters with one digit;
 * a base64 token of the same length has five or more, and a hex digest more
 * still. Base64 padding and the `+`/`/` alphabet are decisive on their own.
 */
export const DIGIT_DENSITY_THRESHOLD = 0.15;

export const looksLikeCredentialRun = (run: string): boolean => {
  if (run.length < ENTROPY_RUN_LENGTH) return false;
  if (/[+/=]/u.test(run)) return true;
  const digitCount = (run.match(/[0-9]/gu) ?? []).length;
  return digitCount / run.length >= DIGIT_DENSITY_THRESHOLD;
};

/**
 * True when `value` still contains a generic credential-shaped run. This is
 * the POST-CONDITION a redaction gate holds itself to: an unknown credential
 * the table was never taught still looks like entropy.
 */
export const containsCredentialRun = (value: string): boolean => {
  for (const match of value.matchAll(ENTROPY_RUN)) {
    if (looksLikeCredentialRun(match[0])) return true;
  }
  return false;
};

/**
 * Credential shapes whose separators (`-`, `_`, `.`) would otherwise break
 * them below the generic run threshold: provider keys, VCS tokens, cloud
 * keys, and JWTs.
 */
export const KNOWN_CREDENTIAL = new RegExp(
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
 * A PEM block, collapsed onto one line by a whitespace normalizer before the
 * substitutions run. Matched whole — including a TRUNCATED block whose `END`
 * marker never arrived, which is the usual shape in a log tail.
 */
export const PEM_PRIVATE_KEY =
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/gu;

/**
 * `[sudo] password for alice: hunter2` and bare `Password: hunter2`. The
 * assignment rule below cannot see these: the keyword is separated from the
 * `:` by " for <user>", and a typed password is usually far too short to reach
 * the generic entropy threshold. Everything after the colon goes.
 */
export const PASSWORD_PROMPT =
  /(?:\[sudo\]\s*)?\b(?:password|passphrase)\b(?:\s+for\s+\S+)?\s*:\s*\S+/giu;

/**
 * Words whose assigned value is a credential, matched against `word = value`,
 * `word: value`, and quoted JSON shapes, case-insensitively — these appear in
 * logs, in query strings, and in configuration dumps alike.
 */
export const SECRET_KEY_WORDS = [
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
] as const;

/**
 * The keyword may be the TAIL of a compound identifier: `capabilityToken`,
 * `sudoPassword`, `sshPassphrase`, `providerApiKey`. Without the prefix the
 * word boundary falls inside the identifier (`…yToken` has no `\b` before
 * `Token`), so every camel-cased secret name slipped through while the bare
 * word was caught — which is why the list above still spells out
 * `pairingtoken` by hand.
 */
export const SECRET_ASSIGNMENT = new RegExp(
  `\\b[A-Za-z0-9_]*(?:${SECRET_KEY_WORDS.join("|")})\\b["']?\\s*[:=]\\s*["']?[^\\s"',;)\\]}]+`,
  "giu",
);

/**
 * `Authorization: Bearer x`, `authorization=Basic y`, and a bare `Bearer z`.
 * The credential must be at least eight unbroken characters so the ordinary
 * English word "basic" followed by a short word is not mistaken for a header.
 */
export const AUTHORIZATION_HEADER =
  /(?:\bauthorization\b\s*["']?\s*[:=]\s*["']?)?\b(?:bearer|basic|digest)\s+[^\s"',;)\]}]{8,}/giu;

/**
 * The separators the prefixed shapes are built around. Stripped before the
 * entropy question is asked, so a provider key of the form
 * `sk` + `-ant-api03-` + a 21-character body is measured as the one
 * 33-character credential it is, rather than as four short fragments none of
 * which reaches {@link ENTROPY_RUN_LENGTH}. Line breaks count as separators
 * too: a PEM body arrives wrapped at 64 columns.
 *
 * The example above is spelled out in pieces on purpose. This module is
 * scanned by the gate it feeds (`scripts/check-tracked-secrets.ts`), and a
 * literal key in a comment here would have to be excused by an allow-list
 * entry — a hole in the one file that defines what a hole is.
 */
const CREDENTIAL_BODY_SEPARATOR = /[-_.\s]+/gu;

/**
 * True when a matched shape actually carries credential material, as opposed
 * to merely having the syntax of one.
 *
 * This is the difference between a REDACTOR and a SCANNER, and it is why the
 * table carries `bodyRequirement` rather than leaving each consumer
 * to invent its own filter. A redactor is deny-biased: a false positive costs
 * one diagnostic field, so `Bearer ${token}` may as well be redacted. A gate
 * over a source tree is the opposite — `task-flow-provider` contains
 * `sk-flow-provider`, `password: Option<String>` looks like a password
 * assignment, and a gate that reports hundreds of those gets switched off,
 * after which it guards nothing. So the scanner asks the table's OWN entropy
 * rule ({@link looksLikeCredentialRun}) about the matched body instead of
 * introducing a second opinion about what a secret looks like.
 */
export const carriesCredentialEntropy = (match: string): boolean => {
  const joined = match.replace(CREDENTIAL_BODY_SEPARATOR, "");
  for (const run of joined.matchAll(/[A-Za-z0-9+/=]+/gu)) {
    if (looksLikeCredentialRun(run[0])) return true;
  }
  return false;
};

/**
 * True when the match wraps an actual base64 BODY — a run of at least
 * {@link ENTROPY_RUN_LENGTH} base64 characters, unbroken by whitespace.
 *
 * This is the length half of the entropy rule WITHOUT the density half, and
 * the distinction is load-bearing rather than a shortcut. An OpenSSH key body
 * is mostly letters and `A` padding: its digit density sits below
 * {@link DIGIT_DENSITY_THRESHOLD}, so {@link carriesCredentialEntropy} would
 * call a genuine private key clean — the exact anti-correlation that made a
 * committed OpenSSH key invisible to the support-bundle gate until it was
 * given its own rule. A PEM block does not need the density test: the BEGIN
 * and END markers already establish what it is, and the only thing left to
 * decide is whether a body sits between them or whether the two markers are a
 * pair of string literals in a test assertion.
 */
export const containsBase64Body = (match: string): boolean =>
  new RegExp(`[A-Za-z0-9+/=]{${ENTROPY_RUN_LENGTH},}`, "u").test(match);

/**
 * What a scanner requires of a match beyond its syntax.
 *
 * - `none` — the shape is only used where a false positive is cheap.
 * - `base64-body` — the match must wrap real base64 material.
 * - `credential-entropy` — the match's body must look random.
 */
export type SecretShapeBodyRequirement = "none" | "base64-body" | "credential-entropy";

export const satisfiesBodyRequirement = (
  requirement: SecretShapeBodyRequirement,
  match: string,
): boolean => {
  switch (requirement) {
    case "none":
      return true;
    case "base64-body":
      return containsBase64Body(match);
    case "credential-entropy":
      return carriesCredentialEntropy(match);
  }
};

/** The stable name of every shape in {@link SECRET_SHAPES}. */
export const SECRET_SHAPE_NAMES = [
  "pem-private-key",
  "known-credential",
  "password-prompt",
  "authorization-header",
  "secret-assignment",
  "entropy-run",
] as const;

export type SecretShapeName = (typeof SECRET_SHAPE_NAMES)[number];

export interface SecretShape {
  readonly name: SecretShapeName;
  /** Global-flagged; consumers must not rely on its `lastIndex`. */
  readonly pattern: RegExp;
  /**
   * Whether a scanner may run this shape over an arbitrary source tree.
   * `false` does NOT mean the shape is weak — it means it is a residue
   * heuristic tuned for one short field, and over a repository it matches
   * ordinary code often enough that the gate would be turned off.
   */
  readonly scansSourceTree: boolean;
  /**
   * Whether the browser-storage canary runs this shape over a dump of
   * `localStorage` and IndexedDB. The two answers differ for `entropy-run`:
   * persisted state contains no changelog hashes, lockfile digests, or image
   * blobs, so the residue heuristic that is unusable over a repository is the
   * single most valuable rule over storage — an opaque pairing token carries
   * no prefix for any other shape to recognize.
   */
  readonly scansBrowserStorage: boolean;
  /**
   * What a match must carry beyond its syntax before a scanner counts it. The
   * prefixed shapes need one, because their syntax alone is reachable by
   * ordinary identifiers.
   */
  readonly bodyRequirement: SecretShapeBodyRequirement;
  /** Why this shape does or does not belong in a source-tree scan. */
  readonly reason: string;
}

/**
 * The table. Order matters for a redactor (the PEM block must be replaced
 * before its own body is picked apart by the narrower rules), so it is kept
 * in the order `redactSupportText` applies them.
 */
export const SECRET_SHAPES: ReadonlyArray<SecretShape> = [
  {
    name: "pem-private-key",
    pattern: PEM_PRIVATE_KEY,
    scansSourceTree: true,
    scansBrowserStorage: true,
    bodyRequirement: "base64-body",
    reason:
      'A `-----BEGIN … PRIVATE KEY-----` block wrapped around a base64 body is key material by construction, and nothing in ordinary source needs one. The entropy check is what separates the body from a bare marker: `assert!(output.starts_with("-----BEGIN RSA PRIVATE KEY-----"))` puts two markers in one file with only Rust between them.',
  },
  {
    name: "known-credential",
    pattern: KNOWN_CREDENTIAL,
    scansSourceTree: true,
    scansBrowserStorage: true,
    bodyRequirement: "credential-entropy",
    reason:
      "Provider, VCS, and cloud key prefixes plus the two private-key base64 magics. The prefixes alone are not enough over a source tree — `task-flow-provider` contains `sk-flow-provider` and `sk-plaintext-must-not-be-accepted` is a test name — so a hit also has to carry an entropic body.",
  },
  {
    name: "password-prompt",
    pattern: PASSWORD_PROMPT,
    scansSourceTree: false,
    scansBrowserStorage: false,
    bodyRequirement: "none",
    reason:
      "Unscannable over a source tree, in both directions. A real typed password is eight low-entropy characters, which no shape can tell from `password: Option<String>`; and the rule as written matches every `password:` field declaration in the Rust and TypeScript trees. It stays in the table because a captured `[sudo] password for alice:` line reaching a support bundle is exactly the leak it was added for.",
  },
  {
    name: "authorization-header",
    pattern: AUTHORIZATION_HEADER,
    scansSourceTree: true,
    scansBrowserStorage: true,
    bodyRequirement: "credential-entropy",
    reason:
      "A `Bearer <token>` header carries a live credential whenever the token is real. The eight-character floor is not enough over a source tree — `Bearer ${accessToken}` and `Bearer test-token` clear it — so the body has to be entropic as well.",
  },
  {
    name: "secret-assignment",
    pattern: SECRET_ASSIGNMENT,
    scansSourceTree: false,
    scansBrowserStorage: false,
    bodyRequirement: "none",
    reason:
      '`<anything>token: <anything>` is the right rule for one short log line and the wrong one for anything larger. Over a repository every `token: Schema.String` field declaration matches it; over serialized state every JSON key does, so `"credential":{"_tag":…` reads as a leak. A gate that reports thousands of structural matches gets disabled, and a disabled gate guards nothing. Both scanners cover assigned credentials through `known-credential` and, over storage, `entropy-run` — rules that look at the VALUE.',
  },
  {
    name: "entropy-run",
    pattern: ENTROPY_RUN,
    scansSourceTree: false,
    scansBrowserStorage: true,
    bodyRequirement: "none",
    reason:
      "The residue heuristic, and the split case. Over a source tree it matches every 40-character Git hash in a changelog, every sha512 in a lockfile, and every base64 data URI, all committed on purpose — so the tracked-file gate cannot use it. Over `localStorage` and IndexedDB none of those exist, and it becomes the most valuable rule there: an opaque pairing or capability token carries no prefix that any other shape would recognize.",
  },
];

export interface SecretShapeMatch {
  readonly shape: SecretShapeName;
  /** The matched text, verbatim. Callers must not log it. */
  readonly match: string;
  /** Zero-based offset of the match in the scanned text. */
  readonly index: number;
}

/**
 * Finds every occurrence of every supplied shape in `text`.
 *
 * A FRESH `RegExp` is built per scan from each shape's source. The table's
 * patterns are global and therefore stateful; sharing one live object between
 * a redactor and a scanner would let one consumer's `lastIndex` silently skip
 * the other's first match.
 */
export function findSecretShapeMatches(
  text: string,
  shapes: ReadonlyArray<SecretShape> = SECRET_SHAPES,
): ReadonlyArray<SecretShapeMatch> {
  const found: Array<SecretShapeMatch> = [];
  for (const shape of shapes) {
    const pattern = new RegExp(shape.pattern.source, shape.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (value.length === 0) continue;
      if (shape.name === "entropy-run" && !looksLikeCredentialRun(value)) continue;
      if (!satisfiesBodyRequirement(shape.bodyRequirement, value)) continue;
      found.push({ shape: shape.name, match: value, index: match.index });
    }
  }
  return found;
}

/** The subset a scanner may run over an arbitrary source tree. */
export const SOURCE_TREE_SECRET_SHAPES: ReadonlyArray<SecretShape> = SECRET_SHAPES.filter(
  (shape) => shape.scansSourceTree,
);

/** The subset the browser-storage canary runs over a dump of persisted state. */
export const BROWSER_STORAGE_SECRET_SHAPES: ReadonlyArray<SecretShape> = SECRET_SHAPES.filter(
  (shape) => shape.scansBrowserStorage,
);
