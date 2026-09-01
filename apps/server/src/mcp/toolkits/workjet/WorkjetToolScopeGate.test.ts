// @effect-diagnostics nodeBuiltinImport:off - the scoping invariant is proved by reading this directory's own source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

/**
 * THE WORKJET TOOL SCOPE GATE
 * (docs/workjet-plan.md → "Security invariants": "Scope T3 MCP tools to the
 * current session/thread and capability grants").
 *
 * WHAT IS ALREADY PROVED ELSEWHERE, AND WHAT IS NOT.
 *
 * The BEHAVIOUR of each existing tool's scope check is well covered:
 * `McpInvocationContext.test.ts` drives `requireWorkjetOrchestrator` and
 * `requireActiveWorkjetMcpCapability`; `WorkerTool.test.ts` and
 * `MailboxTool.test.ts` assert every tool denies standard, worker, and missing
 * roles; `McpHttpServer.test.ts` asserts `tools/list` is filtered by the
 * authoritative bearer scope.
 *
 * Every one of those tests names a tool that exists today. None of them says
 * anything about the NEXT tool. A new `server.addTool` whose handler simply
 * never calls a scope helper is reachable by any bearer that can reach the
 * toolkit, and the entire existing suite stays green — the tool is not in it.
 * That is the unguarded half of this invariant, and it is the half that a
 * growing toolkit actually loses.
 *
 * So this scans the registrations themselves: every tool registered in this
 * directory must consult the invocation scope before it acts, and the set of
 * registered tools must equal a declared inventory. Adding a tool is then a
 * deliberate edit here, not a silent one.
 *
 * Mirrors the support bundle's declared field inventory (set equality against
 * what the code actually produces) and the cross-mode proof matrix's source
 * scans.
 */

const TOOLKIT_DIR = import.meta.dirname;

/**
 * Reading the invocation scope is not the same as ENFORCING it: every handler
 * pulls the scope off the fiber to re-provide it, so `McpInvocationContext`
 * alone proves nothing. Only these actually refuse.
 */
const SCOPE_ENFORCERS = [
  "requireWorkjetMember",
  "requireWorkjetOrchestrator",
  "requireActiveWorkjetMcpCapability",
  "requireMcpCapability",
] as const;

/**
 * Every tool registered in this directory, and the enforcement each one is
 * expected to apply. Set equality below means a new registration fails until
 * it is listed — with an enforcer that the scan then confirms is really there.
 */
const DECLARED_TOOL_REGISTRATIONS: ReadonlyArray<{
  readonly file: string;
  readonly enforcer: (typeof SCOPE_ENFORCERS)[number];
}> = [
  { file: "CollectiveTool.ts", enforcer: "requireWorkjetMember" },
  { file: "WorkBlockTool.ts", enforcer: "requireWorkjetMember" },
  { file: "ManagerTool.ts", enforcer: "requireWorkjetMember" },
  { file: "DecisionHubTool.ts", enforcer: "requireActiveWorkjetMcpCapability" },
  { file: "GreppyTool.ts", enforcer: "requireActiveWorkjetMcpCapability" },
  { file: "MailboxTool.ts", enforcer: "requireWorkjetOrchestrator" },
  { file: "MailboxTool.ts", enforcer: "requireWorkjetOrchestrator" },
  { file: "MailboxTool.ts", enforcer: "requireWorkjetOrchestrator" },
  { file: "MailboxTool.ts", enforcer: "requireWorkjetOrchestrator" },
  { file: "MailboxTool.ts", enforcer: "requireWorkjetOrchestrator" },
  { file: "WebStackTool.ts", enforcer: "requireActiveWorkjetMcpCapability" },
  { file: "WebStackTool.ts", enforcer: "requireActiveWorkjetMcpCapability" },
  { file: "WebStackTool.ts", enforcer: "requireActiveWorkjetMcpCapability" },
  { file: "WebStackTool.ts", enforcer: "requireActiveWorkjetMcpCapability" },
  { file: "WebStackTool.ts", enforcer: "requireActiveWorkjetMcpCapability" },
  { file: "WorkerTool.ts", enforcer: "requireWorkjetOrchestrator" },
];

const withoutComments = (body: string): string =>
  body.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/(^|\s)\/\/[^\n]*/g, " ");

const toolkitSources = (): ReadonlyArray<{ readonly name: string; readonly body: string }> =>
  NodeFS.readdirSync(TOOLKIT_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => ({
      name,
      body: withoutComments(NodeFS.readFileSync(NodePath.join(TOOLKIT_DIR, name), "utf8")),
    }));

/**
 * Each registration's own span: from its `addTool` to the next one in the same
 * file, or to the end. A file-wide search would let one guarded tool vouch for
 * four unguarded siblings — exactly the case MailboxTool's five tools make
 * possible.
 */
const registrationSpans = (): ReadonlyArray<{
  readonly file: string;
  readonly enforcer: string | undefined;
}> => {
  const spans: Array<{ readonly file: string; readonly enforcer: string | undefined }> = [];
  for (const file of toolkitSources()) {
    const starts = [...file.body.matchAll(/server\.addTool\(\{/g)].map((match) => match.index);
    for (const [index, start] of starts.entries()) {
      const end = starts[index + 1] ?? file.body.length;
      const span = file.body.slice(start, end);
      spans.push({
        file: file.name,
        enforcer: SCOPE_ENFORCERS.find((candidate) => span.indexOf(`${candidate}(`) >= 0),
      });
    }
  }
  return spans;
};

describe("Workjet MCP tool scope gate", () => {
  it("registers exactly the declared tools, each enforcing the declared scope check", () => {
    const spans = registrationSpans();

    const unenforced = spans.filter((span) => span.enforcer === undefined);
    assert.deepEqual(
      unenforced,
      [],
      "a Workjet MCP tool is registered without any scope enforcement in its handler",
    );

    assert.deepEqual(
      spans.map(({ file, enforcer }) => ({ file, enforcer })),
      [...DECLARED_TOOL_REGISTRATIONS],
      "the Workjet tool registrations changed; update DECLARED_TOOL_REGISTRATIONS deliberately",
    );
  });

  it("keeps the scope enforcers refusing rather than merely reading the scope", () => {
    const contextSource = NodeFS.readFileSync(
      NodePath.join(TOOLKIT_DIR, "../../McpInvocationContext.ts"),
      "utf8",
    );
    // Each enforcer must be able to FAIL. One rewritten to return the scope
    // unconditionally would keep every call site above intact and grant
    // everything.
    for (const enforcer of SCOPE_ENFORCERS) {
      const start = contextSource.indexOf(`export const ${enforcer} =`);
      assert.isAtLeast(start, 0, `${enforcer} is gone from McpInvocationContext`);
      // Bounded at the NEXT export, not by a character count: a fixed window
      // runs past the end of a short function and finds the next one's
      // refusal, which would make this assertion unfalsifiable.
      const next = contextSource.indexOf("\nexport const ", start + 1);
      const body = contextSource.slice(start, next < 0 ? undefined : next);
      assert.match(
        body,
        /return yield\* new \w*(?:Unavailable|Denied|Unauthorized)\w*Error/,
        `${enforcer} no longer refuses anything`,
      );
    }
  });

  it("binds every scope to a thread and a provider session", () => {
    // The scope the enforcers read is minted per session and carries the
    // thread; a scope without them could not be session-scoped at all.
    const contextSource = NodeFS.readFileSync(
      NodePath.join(TOOLKIT_DIR, "../../McpInvocationContext.ts"),
      "utf8",
    );
    const scope = contextSource.slice(
      contextSource.indexOf("export interface McpInvocationScope"),
      contextSource.indexOf("}", contextSource.indexOf("export interface McpInvocationScope")),
    );
    assert.isNotEmpty(scope, "McpInvocationScope is gone");
    for (const field of ["threadId", "providerSessionId", "capabilities", "environmentId"]) {
      // Anchored on the field NAME: a substring check would accept a renamed
      // `threadIdentifier` as proof that `threadId` is still there.
      assert.match(
        scope,
        new RegExp(`^\\s*readonly ${field}\\??:`, "m"),
        `the MCP invocation scope no longer carries ${field}`,
      );
    }
  });
});
