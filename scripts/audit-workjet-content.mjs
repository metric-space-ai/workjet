import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Workjet's user-facing vocabulary guard.
 *
 * This is deliberately a content audit, not a source-wide word ban. The
 * scanner extracts JSX text, accessibility attributes, common UI copy
 * properties, and app/installer metadata. Runtime protocol names, code
 * symbols, and comments are not user-facing content and are never exempted by
 * a global ignore list.
 */

export const FORBIDDEN_TERMS = Object.freeze([
  "Guest",
  "WebContentsView",
  "Sidecar",
  "Native",
  "Binary",
  "Room",
  "Signaling",
  "RxDB",
  "WebRTC",
]);

export const PRODUCT_TERMS = Object.freeze(["Workjet", "Business OS", "CTOX Backend", "Backend"]);

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const METADATA_EXTENSIONS = new Set([".json", ".jsonc", ".yml", ".yaml"]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * These are the only reviewed source roots. Keeping the roots explicit makes
 * it impossible for this guard to drift into mobile, marketing, experiments,
 * contracts, generated output, or dependency trees.
 */
const AUDITED_SOURCE_ROOTS = Object.freeze([
  "apps/web/src",
  "apps/desktop/src",
  // Desktop launcher scripts register the app identity and inbound links.
  "apps/desktop/scripts",
]);

/**
 * The composer files from fe800e7d1 are owned by a separate stabilization
 * slice. Do not create a vocabulary diff in those files while the guard is
 * being introduced; a later composer change will be audited at its boundary.
 */
const EXCLUDED_SOURCE_FILES = new Set([
  "apps/web/src/components/chat/ChatComposer.tsx",
  "apps/web/src/components/chat/CompactComposerControlsMenu.test.tsx",
  "apps/web/src/components/chat/CompactComposerControlsMenu.tsx",
  "apps/web/src/components/chat/ComposerControl.tsx",
  "apps/web/src/components/chat/ComposerFooterControls.test.tsx",
  "apps/web/src/components/chat/ComposerFooterControls.tsx",
  "apps/web/src/components/chat/ComposerWorkjetTargetControls.tsx",
]);

/** App identity, installer, and packaged-release metadata are audited too. */
const AUDITED_METADATA_FILES = Object.freeze([
  "apps/desktop/package.json",
  "apps/desktop/resources/ctox/business-os-shell.manifest.json",
  "apps/desktop/resources/provider-gateway/host-release.pin.json",
]);

// The launcher writes this file locally, so audit it when present without
// making a clean checkout fail before the desktop runtime has been prepared.
const OPTIONAL_METADATA_FILES = Object.freeze(["apps/desktop/.electron-runtime/metadata.json"]);

/**
 * Candidate property names cover visible copy and assistive technology text.
 * They intentionally do not include generic implementation fields such as
 * `dataPlane`, `transport`, `status`, or `kind`.
 */
const USER_FACING_KEY_PATTERN =
  /(?<![A-Za-z0-9_$-])(?:aria-(?:label|description|roledescription|placeholder|valuetext|errormessage)|title|alt|placeholder|label|description|tooltip(?:Text)?|message|error|warning|success|notice|heading|caption|text|displayName|productName|appName|reason|pauseReason|requiredOperatorStep|emptyState|confirm|prompt|summary|details)\s*(?:=|:)/iu;

const USER_FACING_VARIABLE_PATTERN =
  /(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:label|title|description|tooltip|message|error|warning|notice|heading|caption|text|reason)\w*\s*=\s*$/iu;

const USER_FACING_CALL_PATTERN =
  /(?:return|throw\s+new\s+(?:Error|[A-Za-z_$][\w$]*Error)|toast(?:Manager)?\.(?:add|error|success|warning)|notify|set(?:Error|Warning|Notice|Message))\b[^\n]*$/iu;

const JSX_TEXT_PATTERN = /<([A-Za-z][\w.:/-]*)(?:\s[^>]*)?>\s*([^<>{}]*\p{L}[^<>{}]*)\s*<\/\1>/gu;

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function lineTextAt(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = source.indexOf("\n", offset);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
}

function decodeLiteral(raw) {
  // We only need to recognize the forbidden vocabulary. Decoding the common
  // escapes keeps reports useful without pulling a parser into the guard.
  return raw
    .replaceAll(/\\([\\'"`])/g, "$1")
    .replaceAll(/\\n/g, "\n")
    .replaceAll(/\\r/g, "\r")
    .replaceAll(/\\t/g, "\t");
}

function shouldStartRegex(previousCharacter) {
  return previousCharacter === "" || /[=(:,;!?&|{[\]]/u.test(previousCharacter);
}

export function scanStringLiterals(source) {
  const literals = [];
  let index = 0;
  let blockComment = false;

  const previousSignificantCharacter = (offset) => {
    for (let cursor = offset - 1; cursor >= 0; cursor -= 1) {
      if (!/\s/u.test(source[cursor])) return source[cursor];
    }
    return "";
  };

  const skipRegexLiteral = () => {
    let inCharacterClass = false;
    index += 1;
    while (index < source.length) {
      const current = source[index];
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === "[") inCharacterClass = true;
      if (current === "]") inCharacterClass = false;
      if (current === "/" && !inCharacterClass) {
        index += 1;
        while (/[A-Za-z]/u.test(source[index] ?? "")) index += 1;
        return;
      }
      if (current === "\n") return;
      index += 1;
    }
  };

  const skipTemplateExpression = () => {
    let depth = 1;
    let quote = null;
    while (index < source.length && depth > 0) {
      const current = source[index];
      if (quote !== null) {
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === quote) quote = null;
        index += 1;
        continue;
      }
      if (current === "'" || current === '"' || current === "`") {
        quote = current;
        index += 1;
        continue;
      }
      if (current === "{") depth += 1;
      if (current === "}") depth -= 1;
      index += 1;
    }
  };

  while (index < source.length) {
    if (blockComment) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 2;
      blockComment = false;
      continue;
    }

    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && shouldStartRegex(previousSignificantCharacter(index))) {
      skipRegexLiteral();
      continue;
    }
    if (char !== "'" && char !== '"' && char !== "`") {
      index += 1;
      continue;
    }

    const quote = char;
    const start = index;
    const startLine = lineNumberAt(source, start);
    index += 1;
    let value = "";
    while (index < source.length) {
      const current = source[index];
      if (current === "\\") {
        value += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (quote === "`" && current === "$" && source[index + 1] === "{") {
        index += 2;
        skipTemplateExpression();
        continue;
      }
      if (current === quote) {
        index += 1;
        break;
      }
      value += current;
      index += 1;
    }

    literals.push({
      value: decodeLiteral(value),
      start,
      end: index,
      line: startLine,
      before: source.slice(Math.max(0, start - 260), start),
      after: source.slice(index, Math.min(source.length, index + 120)),
    });
  }

  return literals;
}

function isUserFacingLiteral(literal, isMetadata) {
  if (isMetadata) return true;
  // Only inspect the immediately preceding lines. A key several lines above
  // an internal transport literal must not accidentally classify that
  // implementation value as UI copy.
  const nearbyBefore = literal.before.split("\n").slice(-3).join("\n");
  const currentLineBefore = literal.before.slice(literal.before.lastIndexOf("\n") + 1);
  if (USER_FACING_KEY_PATTERN.test(nearbyBefore)) return true;
  if (USER_FACING_VARIABLE_PATTERN.test(nearbyBefore)) return true;
  if (USER_FACING_CALL_PATTERN.test(currentLineBefore)) {
    // A one-word protocol/enum value after `return` is code, while a natural
    // language message is copy. Explicit keys above still catch one-word
    // labels such as `title: "Native"`.
    return /\s|[.!?…]/u.test(literal.value);
  }
  return false;
}

function findForbiddenTerms(value) {
  const findings = [];
  for (const term of FORBIDDEN_TERMS) {
    const pattern = new RegExp(`\\b${term}\\b`, "giu");
    for (const match of value.matchAll(pattern)) {
      findings.push({ term, offset: match.index ?? 0 });
    }
  }
  return findings;
}

/**
 * Every exception is path + context scoped. This list is intentionally kept
 * next to the scanner so a reviewer can see why a technical identifier is
 * safe without accidentally turning a forbidden product term into a global
 * ignore word.
 */
export const TECHNICAL_CONTEXT_ALLOWLIST = Object.freeze([
  {
    path: "apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx",
    context:
      /Waiting for the native process monitor|label=["']?Native|Live native counters|Native process monitor|label=["']?Sidecar|Native counters identify/iu,
    allowUserFacing: true,
    reason: "The resource monitor is the explicit extended-diagnostics surface.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxGuestManager.ts",
    context: /WebContentsView|\bguest(?:View|State|Window|Manager)?\b/iu,
    reason: "Electron host integration symbols are not renderer copy.",
  },
  {
    path: "apps/desktop/src/electron/desktopSchemes.ts",
    context: /(?:ctox-desktop(?:-dev)?|t3code(?:-dev)?):?\b/iu,
    reason: "Inbound legacy deep-link aliases remain for compatibility.",
  },
  {
    path: "apps/desktop/.electron-runtime/metadata.json",
    context: /appBundleId|appProtocolSchemes|(?:ctox-desktop-dev|t3code-dev)/iu,
    reason: "Bundle identity and protocol registration are packaged metadata.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxInstanceRegistry.ts",
    context: /(?:rxdb-webrtc|roompassword|signaling|dataPlane|transport)/iu,
    reason: "Registry transport fields are an internal sync contract.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxLaunchConfig.ts",
    context: /transport.*webrtc/iu,
    reason: "Launch configuration transport is an internal sync value.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxBusinessOsShell.ts",
    context: /(?:\/rxdb\/|transport:\s*["']?webrtc)/iu,
    reason: "The packaged shell loader uses an internal sync asset contract.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxGuestManager.ts",
    context: /(?:\/rxdb\/|ctox-guest-preload)/iu,
    reason: "Guest preload and shell paths are internal host integration values.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxLocalDaemonSource.ts",
    context: /(?:rxdb-webrtc|business-os\s+rxdb)/iu,
    reason: "The local daemon probe uses an internal sync status command.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxSshManagedSource.ts",
    context: /(?:rxdb-webrtc|business-os\s+rxdb|signaling)/iu,
    reason: "The SSH source uses internal transport and health fields.",
  },
  {
    path: "apps/desktop/src/backend/DesktopBackendConfiguration.ts",
    context: /native\/resource-monitor\/target\/(?:release|debug)/iu,
    reason: "Packaged resource-monitor paths are internal artifact locations.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxElectronSessions.ts",
    context: /rxdb-webrtc/iu,
    reason: "The Electron session descriptor carries an internal sync value.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxManagedDiscovery.ts",
    context: /dataPlane.*rxdb-webrtc/iu,
    reason: "Discovery health uses an internal data-plane value.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxManagedLaunch.ts",
    context: /(?:transport.*webrtc|webrtc.*http_bridge_available)/iu,
    reason: "Managed launch normalization uses an internal transport value.",
  },
  {
    path: "apps/desktop/src/ctox/CtoxShellFleet.ts",
    context: /business-os.*rxdb.*status/iu,
    reason: "The fleet probe invokes the internal sync status command.",
  },
  {
    path: "apps/desktop/src/ipc/channels.ts",
    context: /desktop:ctox-(?:set-guest-bounds|guest-state)/iu,
    reason: "IPC channel names are internal code symbols.",
  },
  {
    path: "apps/desktop/src/window/DesktopWindow.ts",
    context: /ctox-guest/iu,
    reason: "The window target name is an internal host symbol.",
  },
  {
    path: "apps/desktop/src/providerGateway/ProviderGatewayHostArtifact.ts",
    context: /NodePath\.join|provider-gateway-workjet-host|target.*release/iu,
    reason: "Artifact paths retain the native build directory name.",
  },
  {
    path: "apps/desktop/src/wsl/DesktopWslEnvironment.ts",
    context: /nodePath:%s|nodeVersion:%s|resolvedPath:%s|node-pty/iu,
    reason: "The WSL probe script is an internal installer implementation.",
  },
  {
    path: "apps/desktop/scripts/stage-resource-monitor.mjs",
    context: /NodePath\.join|resource-monitor/iu,
    reason: "The resource-monitor staging path is an internal installer location.",
  },
  {
    path: "apps/desktop/src/preview/FaviconCapture.ts",
    context: /(?:toString.*binary|binary\/octet-stream|atob|charCodeAt)/iu,
    reason: "Favicon decoding uses internal encoding and MIME literals.",
  },
  {
    path: "apps/web/src/components/ChatView.tsx",
    context: /workspace-native-controls-inset/iu,
    reason: "The CSS variable names the Electron title-bar inset.",
  },
  {
    path: "apps/web/src/components/NoActiveThreadState.tsx",
    context: /workspace-native-controls-inset/iu,
    reason: "The CSS variable names the Electron title-bar inset.",
  },
  {
    path: "apps/web/src/components/RightPanelTabs.tsx",
    context: /workspace-native-controls-inset/iu,
    reason: "The CSS variable names the Electron title-bar inset.",
  },
  {
    path: "apps/web/src/components/ctox/CtoxModeShell.tsx",
    context: /workspace-native-controls-inset/iu,
    reason: "The CSS variable names the Electron title-bar inset.",
  },
  {
    path: "apps/web/src/routes/_chat.pull-requests.tsx",
    context: /workspace-native-controls-inset/iu,
    reason: "The CSS variable names the Electron title-bar inset.",
  },
  {
    path: "apps/web/src/components/diffs/StyledDiffCodeView.tsx",
    context: /data-line(?:-annotation|-merge-conflict|-actions)?/iu,
    reason: "Diff selector names are internal DOM implementation symbols.",
  },
  {
    path: "apps/web/src/components/settings/WorkjetSettings.tsx",
    context: /binary-unavailable/iu,
    reason: "This is a persisted operation-reason code, not displayed copy.",
  },
]);

function matchingAllowlist(relativePath, context, { userFacing = false } = {}) {
  return TECHNICAL_CONTEXT_ALLOWLIST.find(
    (entry) =>
      entry.path === relativePath &&
      entry.context.test(context) &&
      (!userFacing || entry.allowUserFacing === true),
  );
}

/** Expose the contextual decision for tests and future release checks. */
export function isAllowlistedContext(relativePath, context, options = {}) {
  return matchingAllowlist(normalizeRelativePath(relativePath), context, options) !== undefined;
}

function makeFinding({ relativePath, source, start, term, context, kind, allowedBy }) {
  const termOffset = context.toLowerCase().indexOf(term.toLowerCase());
  const absoluteOffset = Math.max(0, start + termOffset);
  return {
    path: relativePath,
    line: lineNumberAt(source, absoluteOffset),
    term,
    kind,
    text: lineTextAt(source, absoluteOffset),
    allowedBy: allowedBy?.reason,
  };
}

/**
 * Audit one source document. Exported so focused tests can prove that an
 * allowlist entry is contextual rather than a blanket word exemption.
 */
export function auditSourceText(source, relativePath, { metadata = false } = {}) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const findings = [];

  for (const literal of scanStringLiterals(source)) {
    const forbidden = findForbiddenTerms(literal.value);
    if (forbidden.length === 0) continue;
    const userFacing = isUserFacingLiteral(literal, metadata);
    const context = `${literal.before.slice(-180)}${literal.value}${literal.after.slice(0, 80)}`;
    const allowedBy = matchingAllowlist(normalizedPath, context, { userFacing });
    for (const match of forbidden) {
      if (allowedBy !== undefined) continue;
      findings.push(
        makeFinding({
          relativePath: normalizedPath,
          source,
          start: literal.start,
          term: match.term,
          context: literal.value,
          kind: metadata ? "metadata" : userFacing ? "user-facing-literal" : "technical-literal",
        }),
      );
    }
  }

  // JSX text nodes have no quoted literal or property key. Keep this separate
  // so plain visible children and translated fragments cannot slip through.
  for (const match of source.matchAll(JSX_TEXT_PATTERN)) {
    const value = match[2] ?? "";
    const forbidden = findForbiddenTerms(value);
    if (forbidden.length === 0) continue;
    const matchStart = match.index ?? 0;
    const start = matchStart + Math.max(0, match[0].indexOf(value));
    const context = `${source.slice(Math.max(0, start - 180), start)}${value}`;
    const allowedBy = matchingAllowlist(normalizedPath, context, { userFacing: true });
    for (const match of forbidden) {
      if (allowedBy !== undefined) continue;
      findings.push(
        makeFinding({
          relativePath: normalizedPath,
          source,
          start,
          term: match.term,
          context: value,
          kind: "jsx-text",
        }),
      );
    }
  }

  return findings;
}

function shouldAuditSource(relativePath) {
  if (EXCLUDED_SOURCE_FILES.has(relativePath)) return false;
  if (/\.test\.(?:js|jsx|mjs|ts|tsx)$/u.test(relativePath)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(relativePath));
}

async function collectFiles(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vite-plus") {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, relativePath)));
    } else if (shouldAuditSource(relativePath)) {
      files.push(relativePath);
    }
  }
  return files;
}

/** Audit the bounded Workjet product surfaces from a repository root. */
export async function auditWorkjetContent(root = repoRoot) {
  const sourceFiles = (
    await Promise.all(AUDITED_SOURCE_ROOTS.map((directory) => collectFiles(root, directory)))
  ).flat();
  const files = [...sourceFiles, ...AUDITED_METADATA_FILES];
  for (const relativePath of OPTIONAL_METADATA_FILES) {
    try {
      await readFile(path.join(root, relativePath));
      files.push(relativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const findings = [];

  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const source = await readFile(absolutePath, "utf8");
    findings.push(
      ...auditSourceText(source, relativePath, {
        metadata: METADATA_EXTENSIONS.has(path.extname(relativePath)),
      }),
    );
  }

  return {
    filesAudited: files.length,
    findings,
    productTerms: PRODUCT_TERMS,
    forbiddenTerms: FORBIDDEN_TERMS,
  };
}

export function formatFindings(findings) {
  return findings
    .map(
      (finding) =>
        `${finding.path}:${finding.line} [${finding.term}] ${finding.text}${finding.allowedBy ? ` (allowed: ${finding.allowedBy})` : ""}`,
    )
    .join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await auditWorkjetContent();
  if (result.findings.length > 0) {
    console.error(
      `Workjet content guard found ${result.findings.length} forbidden UI/metadata term(s):`,
    );
    console.error(formatFindings(result.findings));
    process.exitCode = 1;
  } else {
    console.log(`Workjet content guard passed (${result.filesAudited} files audited).`);
  }
}
