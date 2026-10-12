/**
 * UI-Vertrag §8 – Wächter-Collector (gemeinsam für Test und Baseline).
 *
 * Schlägt fehl bei:
 * (a) DialogDescription, EmptyDescription oder SettingsRow `description`
 *     mit einem Satz über 12 Wörter;
 * (b) `hover:underline` bzw. `underline` auf button/a mit onClick;
 * (c) verbotenen Icon-Zuordnungen aus §5;
 * (d) englischen Literal-Strings in JSX der Einstellungen, Dialoge und
 *     Leerzustände (Allowlist für Eigennamen).
 *
 * Schlüsselformat: `rule|datei|normalisierter Text` – ohne Zeilennummer,
 * damit Verschiebungen nicht als neue Verstöße zählen.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_STATUS_WORDS = 12;

const PROPER_NOUNS =
  /\b(Workjet|CTOX|Business OS|Lumas?|Instanz(en)?|Rechner(n)?|Projekt(e|en)?|Regeltermin(e|en)?|Einstellungen|Modell(e|en)?|Harness(es)?|Tailscale|SSH|GPU|VRAM|CPU|RAM|OAuth|API|CLI|URL|IDs?|JSON|OpenCode|Claude|Codex|Kimi|Grok|Gemini|GPT|Nightly|Dev|Latest|PR|PRs|Git|GitHub|GitLab|Slack|Discord|macOS|Windows|Linux|WSL|Chrome|Safari|Firefox|Electron|Vite|React|TypeScript|Postgres|SQLite|Docker|Kubernetes|Token|WebSocket|HTTP|HTTPS|DNS|IP|TLS|SSL|CRT|FFmpeg|Grok|Anthropic|OpenAI|Google|Microsoft|Apple|X|v\d+\.\d+[\w.]*)\b/g;

const ENGLISH_MARKERS =
  /\b(the|and|with|your|you|are|is|to|of|for|when|this|that|these|those|will|would|can|could|should|not|no|yes|new|add|edit|delete|remove|save|cancel|back|close|open|show|hide|loading|loaded|failed|error|settings|connect|connected|disconnect|create|created|update|updated|select|selected|choose|search|filter|name|description|status|version|available|unavailable|enabled|disabled|on|off|in|out|all|none|any|each|every|from|into|over|under|again|retry|try|click|press|enter|type|here|there|now|later|never|always)\b/i;

function* walk(dir) {
  for (const entry of NodeFS.readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = NodePath.join(dir, entry);
    const stat = NodeFS.statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function staticText(jsxInner) {
  // JSX-Ausdrücke durch ihre String-Literale ersetzen, Rest stehen lassen.
  return jsxInner
    .replace(/\{[^{}]*\}/g, (expr) => {
      const literals = [...expr.matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
      return literals.join(" ");
    })
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGermanOrNeutral(text) {
  const stripped = text.replace(PROPER_NOUNS, " ");
  return !ENGLISH_MARKERS.test(stripped);
}

function clean(text) {
  return text.replace(/\|/g, "/");
}

function pushWordViolation(out, rule, file, text) {
  const count = words(text).length;
  if (count > MAX_STATUS_WORDS) {
    out.push(`${rule}|${file}|${clean(text.slice(0, 120))}`);
  }
}

function checkStatusBlocks(out, rule, file, source, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  for (const match of source.matchAll(re)) {
    const text = staticText(match[1]);
    if (text) pushWordViolation(out, rule, file, text);
  }
  // Einzeilige Self-Closing-/Attributform: <DialogDescription>…</…> oben,
  // hier zusätzlich description="…"-Props für SettingsRow.
}

function checkSettingsRowDescription(out, file, source) {
  if (!/SettingsRow/.test(source)) return;
  for (const match of source.matchAll(/description=\{?\s*["'`]([^"'`]+)["'`]/g)) {
    const text = match[1];
    if (text) pushWordViolation(out, "a", file, text);
  }
}

function checkUnderlineActions(out, file, source) {
  for (const match of source.matchAll(/[^\n]*hover:underline[^\n]*/g)) {
    out.push(`b|${file}|${clean(match[0].trim().slice(0, 120))}`);
  }
  for (const match of source.matchAll(/variant="link"/g)) {
    out.push(`b|${file}|variant="link"`);
  }
}

function checkIcons(out, file, source) {
  const lines = source.split("\n");
  const fileMentionsModels = /modell|model/i.test(file);
  for (const line of lines) {
    if (
      /\bSparklesIcon\b|\bSparkles\b/.test(line) &&
      (fileMentionsModels || /modell|model/i.test(line))
    ) {
      out.push(`c|${file}|${clean(line.trim().slice(0, 120))}`);
    }
    if (/\bWrench(Icon)?\b/.test(line) && /luma|worker/i.test(line)) {
      out.push(`c|${file}|${clean(line.trim().slice(0, 120))}`);
    }
    if (/✨/.test(line)) {
      out.push(`c|${file}|${clean(line.trim().slice(0, 120))}`);
    }
  }
}

const ENGLISH_SCAN_TARGETS = (file) =>
  /components\/settings\//.test(file) ||
  /components\/ui\/(dialog|empty|banner|row)\.tsx$/.test(file) ||
  /Dialog\.tsx$|Empty\.tsx$/.test(file);

function checkEnglishLiterals(out, file, source) {
  if (!ENGLISH_SCAN_TARGETS(file)) return;
  // JSX-Textknoten
  for (const match of source.matchAll(/>\s*([^<>{}\n][^<>{}]*?)\s*</g)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    if (words(text).length >= 2 && /[a-zA-Z]/.test(text) && !isGermanOrNeutral(text)) {
      out.push(`d|${file}|${clean(text.slice(0, 120))}`);
    }
  }
  // Sichtbare String-Props
  for (const match of source.matchAll(
    /(?:title|label|placeholder|aria-label|children)=\{?\s*"([^"]+)"/g,
  )) {
    const text = match[1];
    if (words(text).length >= 2 && !isGermanOrNeutral(text)) {
      out.push(`d|${file}|${clean(text.slice(0, 120))}`);
    }
  }
}

export function collectUiContractViolations(srcRoot) {
  const out = [];
  for (const file of walk(srcRoot)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    if (/\.test\.(ts|tsx)$/.test(file)) continue;
    if (/uiContract/.test(file)) continue;
    const rel = NodePath.relative(srcRoot, file).split("\\").join("/");
    const source = NodeFS.readFileSync(file, "utf8");
    checkStatusBlocks(out, "a", rel, source, "DialogDescription");
    checkStatusBlocks(out, "a", rel, source, "EmptyDescription");
    checkSettingsRowDescription(out, rel, source);
    checkUnderlineActions(out, rel, source);
    checkIcons(out, rel, source);
    checkEnglishLiterals(out, rel, source);
  }
  return out.sort();
}
