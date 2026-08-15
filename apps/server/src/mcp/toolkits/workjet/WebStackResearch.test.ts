import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NativeProcess from "./WebStackNativeProcess.ts";
import * as WebStackResearch from "./WebStackResearch.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface CapturedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly shell?: boolean | string };
}

interface HandleResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

const makeSpawner = (handler: (command: CapturedCommand, index: number) => HandleResult) => {
  const commands: Array<CapturedCommand> = [];
  const stdin: Array<Array<string>> = [];
  const service = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const captured = command as unknown as CapturedCommand;
      const index = commands.length;
      commands.push(captured);
      const written: Array<string> = [];
      stdin.push(written);
      const result = handler(captured, index);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(index + 1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => written.push(decoder.decode(chunk, { stream: true }))),
        ),
        stdout: Stream.make(encoder.encode(result.stdout ?? "")),
        stderr: Stream.make(encoder.encode(result.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    commands,
    stdin,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
  };
};

const readResponse = JSON.stringify({
  ok: true,
  operation: "read",
  requestedUrl: "https://example.test/requested",
  canonicalUrl: "https://example.test/canonical",
  title: "Example",
  pageTextExcerpt: "Evidence",
  evidenceEligible: true,
});

const researchResponse = JSON.stringify({
  ok: true,
  operation: "deepResearch",
  query: "bounded research",
  depth: "standard",
  evidenceStatus: "verified_sources_available",
  verifiedSources: [{ title: "Source", canonicalUrl: "https://example.test/source" }],
  workspacePersisted: true,
  workspaceId: "research-1234",
});

const makeService = (input?: {
  readonly stateDir?: string;
  readonly candidates?: ReadonlyArray<string>;
  readonly isExecutable?: (candidate: string) => Promise<boolean>;
  readonly makeDirectory?: (path: string) => Promise<void>;
  readonly handler?: (command: CapturedCommand, index: number) => HandleResult;
}) => {
  const directories: Array<string> = [];
  const spawner = makeSpawner(
    input?.handler ??
      ((command) => ({
        stdout:
          command.args[0] === "--research-surface-version"
            ? WebStackResearch.WEB_STACK_RESEARCH_SURFACE_VERSION
            : command.args[0] === "read"
              ? readResponse
              : researchResponse,
      })),
  );
  const service = WebStackResearch.__testing
    .make({
      stateDir: input?.stateDir ?? "/server/state",
      runtime: {
        executableCandidates: input?.candidates ?? ["/opt/workjet-web-stack"],
        isExecutable: input?.isExecutable ?? (async () => true),
        makeDirectory:
          input?.makeDirectory ??
          (async (path) => {
            directories.push(path);
          }),
      },
      probeTimeout: Duration.seconds(1),
      readTimeout: Duration.seconds(1),
      researchTimeouts: {
        quick: Duration.seconds(1),
        standard: Duration.seconds(2),
        exhaustive: Duration.seconds(3),
      },
    })
    .pipe(Effect.provide(spawner.layer));
  return { ...spawner, directories, service };
};

describe("WebStackResearch", () => {
  it("strictly decodes read inputs with Unicode character bounds", () => {
    assert.deepEqual(
      WebStackResearch.decodeWebReadInput({
        url: `https://example.test/${"😀".repeat(7_979)}`,
        query: " evidence ",
        find: ["needle"],
        country: "DE",
      }),
      {
        url: `https://example.test/${"😀".repeat(7_979)}`,
        query: " evidence ",
        find: ["needle"],
        country: "DE",
      },
    );
    for (const invalid of [
      { url: "   " },
      { url: "https://example.test", query: "\n\t" },
      { url: "https://example.test", query: null },
      { url: "https://example.test", find: [" "] },
      { url: "https://example.test", find: Array.from({ length: 33 }, () => "x") },
      { url: "https://example.test", country: "US" },
      { url: "https://example.test", workspace: "/tmp" },
      { url: "https://example.test", path: "/tmp" },
      { url: "https://example.test", config: { SECRET: "value" } },
    ]) {
      assert.isUndefined(WebStackResearch.decodeWebReadInput(invalid));
    }
  });

  it("strictly decodes research inputs and applies only adapter-owned defaults", () => {
    assert.deepEqual(WebStackResearch.decodeWebDeepResearchInput({ query: "research" }), {
      query: "research",
      depth: "standard",
      maxSources: 16,
      excludeUrls: [],
      includePapers: true,
      includeAnnasArchive: false,
    });
    assert.equal(
      Array.from(WebStackResearch.decodeWebDeepResearchInput({ query: "😀".repeat(4_000) })!.query)
        .length,
      4_000,
    );
    for (const invalid of [
      { query: "   " },
      { query: "research", focus: "\t" },
      { query: "research", focus: null },
      { query: "research", depth: "deep" },
      { query: "research", maxSources: 2 },
      { query: "research", maxSources: 101 },
      { query: "research", maxSources: 3.5 },
      { query: "research", excludeUrls: [" "] },
      { query: "research", excludeUrls: Array.from({ length: 101 }, () => "https://x.test") },
      { query: "research", includePapers: "yes" },
      { query: "research", workspace: "/tmp" },
      { query: "research", persistWorkspace: true },
      { query: "research", executable: "/tmp/tool" },
    ]) {
      assert.isUndefined(WebStackResearch.decodeWebDeepResearchInput(invalid));
    }
    assert.deepEqual(
      ["quick", "standard", "exhaustive"].map((depth) =>
        Duration.toMillis(
          WebStackResearch.researchTimeoutForDepth(depth as WebStackResearch.WebDeepResearchDepth),
        ),
      ),
      [300_000, 900_000, 1_800_000],
    );
  });

  it.effect("shares one lazy exact probe and uses the absolute server-owned root", () => {
    const test = makeService({ stateDir: "/server-owned/state" });
    return Effect.gen(function* () {
      assert.equal(test.commands.length, 0);
      const service = yield* test.service;
      const read = yield* service.read({ url: "https://example.test/" });
      const research = yield* service.deepResearch({
        query: "bounded research",
        depth: "standard",
        maxSources: 16,
        excludeUrls: [],
        includePapers: true,
        includeAnnasArchive: false,
      });

      assert.equal(read.operation, "read");
      assert.equal(research.operation, "deepResearch");
      assert.deepEqual(test.directories, [
        "/server-owned/state/web-stack",
        "/server-owned/state/web-stack",
      ]);
      assert.deepEqual(
        test.commands.map(({ args }) => args),
        [
          ["--research-surface-version"],
          ["read", "--root", "/server-owned/state/web-stack"],
          ["deep-research", "--root", "/server-owned/state/web-stack"],
        ],
      );
      assert.isTrue(test.commands.every(({ options }) => options.shell === false));
      assert.equal(
        test.stdin[1]?.join(""),
        '{"request":{"url":"https://example.test/"},"config":{}}',
      );
      assert.equal(
        test.stdin[2]?.join(""),
        '{"request":{"query":"bounded research","depth":"standard","maxSources":16,"excludeUrls":[],"includePapers":true,"includeAnnasArchive":false},"config":{}}',
      );
    });
  });

  it.effect("retries failed probes, caches success only, and returns finite safe failures", () => {
    let available = false;
    const retry = makeService({
      candidates: ["/late/workjet-web-stack"],
      isExecutable: async () => available,
    });
    const secret = "SENSITIVE_QUERY_STDOUT_STDERR_PATH";
    const exited = makeService({
      handler: (command) =>
        command.args[0] === "--research-surface-version"
          ? { stdout: WebStackResearch.WEB_STACK_RESEARCH_SURFACE_VERSION }
          : { code: 7, stdout: secret, stderr: `/private/${secret}` },
    });
    const oversized = makeService({
      handler: (command) => ({
        stdout:
          command.args[0] === "--research-surface-version"
            ? WebStackResearch.WEB_STACK_RESEARCH_SURFACE_VERSION
            : "x".repeat(NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES + 1),
      }),
    });
    return Effect.gen(function* () {
      const retried = yield* retry.service;
      const unavailable = yield* retried.read({ url: "https://example.test/" }).pipe(Effect.flip);
      assert.equal(unavailable.reason, "binary-unavailable");
      available = true;
      yield* retried.read({ url: "https://example.test/" });
      yield* retried.read({ url: "https://example.test/again" });
      assert.deepEqual(
        retry.commands.map(({ args }) => args),
        [
          ["--research-surface-version"],
          ["read", "--root", "/server/state/web-stack"],
          ["read", "--root", "/server/state/web-stack"],
        ],
      );

      const exitError = yield* (yield* exited.service)
        .read({ url: `https://example.test/${secret}` })
        .pipe(Effect.flip);
      assert.equal(exitError.reason, "process-exit");
      assert.notInclude(JSON.stringify(exitError), secret);

      const oversizedError = yield* (yield* oversized.service)
        .read({ url: "https://example.test/" })
        .pipe(Effect.flip);
      assert.equal(oversizedError.reason, "oversized-response");
    });
  });

  it.effect("rejects malformed native envelopes without forwarding native fields", () => {
    const secret = "/private/raw-workspace";
    const test = makeService({
      handler: (command) => ({
        stdout:
          command.args[0] === "--research-surface-version"
            ? WebStackResearch.WEB_STACK_RESEARCH_SURFACE_VERSION
            : JSON.stringify({ ok: true, operation: "wrong", path: secret, body: secret }),
      }),
    });
    return Effect.gen(function* () {
      const error = yield* (yield* test.service)
        .read({ url: "https://example.test/" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "malformed-response");
      assert.notInclude(JSON.stringify(error), secret);
    });
  });
});
