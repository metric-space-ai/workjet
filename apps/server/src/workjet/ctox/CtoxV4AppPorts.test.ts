// Server-side V4 gate for slice C (E49): with a bound V4 app port the seams use it and never touch
// MCP/HTTP; without a binding (V3) they keep today's route. The port here is a minimal in-memory
// implementation of the kernel `CtoxAppApi` subset; the same shared functions run against the
// vendored fake core in apps/web/src/ctox/sliceC.test.ts.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type {
  CtoxV4AppPort,
  CtoxV4CommandState,
  CtoxV4Live,
} from "@workjet/shared/ctoxV4AppData";
import { bindCtoxV4AppPort } from "./CtoxV4AppPorts.ts";
import { makeCtoxLumaConfigurationClient } from "./CtoxLumaConfigurationClient.ts";
import { makeCtoxNativeSupervisorWorkers } from "./CtoxNativeSupervisorWorkers.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import {
  DecisionHubMcpClient,
  layer as decisionHubClientLayer,
} from "../decisionHub/DecisionHubMcpClient.ts";

const live = <T>(value: () => T): CtoxV4Live<T> => ({
  get: value,
  subscribe: (listener) => {
    listener(value());
    return () => {};
  },
});

function memoryPort(handlers: Record<string, (payload: object) => unknown>) {
  const rows = new Map<string, Record<string, unknown>>();
  const commands: Array<{ type: string; payload: object }> = [];
  const key = (collection: string, id: string) => `${collection}/${id}`;
  const accepted = { local: Promise.resolve(), result: Promise.resolve({ status: "accepted" }) };
  const port: CtoxV4AppPort = {
    actor: { id: "owner", role: "admin" },
    query: <T>(collection: string) =>
      live(
        () =>
          [...rows.entries()]
            .filter(([k]) => k.startsWith(`${collection}/`))
            .map(([, row]) => row) as T[],
      ),
    get: <T>(collection: string, id: string) =>
      live(() => (rows.get(key(collection, id)) ?? null) as T | null),
    put: (collection, doc) => {
      rows.set(key(collection, doc.id), { ...doc });
      return accepted;
    },
    patch: (collection, id, patch) => {
      rows.set(key(collection, id), { ...rows.get(key(collection, id)), ...patch });
      return accepted;
    },
    command: (type, payload) => {
      commands.push({ type, payload });
      const handler = handlers[type];
      const state: CtoxV4CommandState =
        handler === undefined
          ? { status: "rejected", error: "unknown_command: no route" }
          : { status: "done", result: handler(payload) };
      return {
        id: `cmd-${commands.length}`,
        status: live(() => state),
        local: Promise.resolve(),
        result: Promise.resolve(
          handler === undefined
            ? { status: "rejected", code: "unknown_command" }
            : { status: "accepted" },
        ),
      };
    },
  };
  return { port, rows, commands };
}

const forbiddenHttp = HttpClient.make(() => Effect.die("a V4 instance must not reach MCP/HTTP"));
let instanceSequence = 0;

describe("V4 bound: seams use the kernel client, never MCP", () => {
  it.effect("Luma/preset configuration reads and saves Workjet app data", () =>
    Effect.gen(function* () {
      const endpoint = `https://v4-luma-${++instanceSequence}.invalid/mcp/instance`;
      const { port, rows } = memoryPort({});
      const release = bindCtoxV4AppPort({ instanceId: `luma-${instanceSequence}`, endpoint }, port);
      try {
        const client = makeCtoxLumaConfigurationClient(forbiddenHttp);
        const target = { endpoint, token: "" };
        assert.deepStrictEqual(yield* client.read(target), {
          revision: 0,
          configuration: null,
          updatedAtMs: null,
        });
        assert.deepStrictEqual(yield* client.save(target, 0, { managedSystemPrompt: "x" }), {
          status: "saved",
          revision: 1,
        });
        assert.deepStrictEqual(yield* client.save(target, 0, { managedSystemPrompt: "y" }), {
          status: "conflict",
          revision: 1,
        });
        assert.strictEqual(rows.get("workjet_luma_state/instance")?.managedSystemPrompt, "x");
      } finally {
        release();
      }
    }),
  );

  it.effect("decision_hub request/get map to threads.ctox_approval.request and its projection", () =>
    Effect.gen(function* () {
      const endpoint = `https://v4-decision-${++instanceSequence}.invalid/mcp/instance`;
      const { port, rows, commands } = memoryPort({
        "threads.ctox_approval.request": () => ({ status: "completed" }),
      });
      const release = bindCtoxV4AppPort({ instanceId: `dh-${instanceSequence}`, endpoint }, port);
      try {
        const client = yield* DecisionHubMcpClient.pipe(
          Effect.provide(
            decisionHubClientLayer.pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, forbiddenHttp)),
            ),
          ),
        );
        const target = { endpoint, token: "" };
        yield* client.probe(target);
        const requested = yield* client.requestDecision(target, {
          decision_key: "k",
          title: "Freigabe",
          question: "Weiter?",
          options: [{ id: "approve", label: "Ja" }],
          source: { thread_id: "t-1", environment_id: "env" },
        });
        assert.deepStrictEqual(requested, { decisionId: "workjet-decision:k", status: "open" });
        assert.strictEqual(commands[0]?.type, "threads.ctox_approval.request");
        rows.set("ctox_task_approval_requests/workjet-decision:k", {
          id: "workjet-decision:k",
          status: "rejected",
          updated_at_ms: 9,
        });
        const resolved = yield* client.getDecision(target, "workjet-decision:k");
        assert.deepStrictEqual(resolved, {
          decisionId: "workjet-decision:k",
          status: "resolved",
          selectedOptionId: "reject",
          comment: null,
          resolutionVersion: 9,
        });
      } finally {
        release();
      }
    }),
  );

  it.effect("worker dispatch is the Workjet app command, not the MCP tool", () =>
    Effect.gen(function* () {
      const instanceId = `dispatch-${++instanceSequence}`;
      const { port, commands } = memoryPort({
        "workjet.worker.dispatch": (payload) => ({ echoed: payload }),
      });
      const release = bindCtoxV4AppPort({ instanceId }, port);
      try {
        const workers = makeCtoxNativeSupervisorWorkers({
          connections: {
            resolveReadyTarget: () => Effect.die("V4 must not resolve an MCP target"),
            probe: () => Effect.die("V4 must not probe MCP"),
          },
          transport: {
            probe: () => Effect.die("V4 must not probe MCP"),
            callTool: () => Effect.die("V4 must not call MCP"),
          } as unknown as ReturnType<typeof makeCtoxMcpTransport>,
        });
        const registration = yield* workers
          .register(
            { connectionId: "c" as never, instanceId },
            {
              sourceEnvironmentId: "desktop" as never,
              sourceSupervisorThreadId: "supervisor" as never,
              projectId: "project" as never,
            },
          )
          .pipe(Effect.flip);
        // The memory handler echoes instead of a registration receipt: the decode fails typed,
        // which proves the answer came from the V4 command and not from MCP.
        assert.strictEqual(registration._tag, "RemoteWorkerDispatchError");
        assert.strictEqual(commands[0]?.type, "workjet.worker.dispatch");
        assert.strictEqual((commands[0]?.payload as { action?: string }).action, "register_source");
      } finally {
        release();
      }
    }),
  );
});

describe("V3 (no binding): seams keep today's MCP route", () => {
  it.effect("Luma read goes through the MCP tool", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          urls.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              jsonrpc: "2.0",
              result: {
                content: [{ type: "text", text: "Receipt" }],
                structuredContent: {
                  ok: true,
                  revision: 4,
                  configuration: null,
                  updated_at_ms: null,
                },
              },
            }),
          );
        }),
      );
      const client = makeCtoxLumaConfigurationClient(http);
      const document = yield* client.read({
        endpoint: "https://v3-luma.invalid/mcp/instance",
        token: "synthetic-token",
      });
      assert.strictEqual(document.revision, 4);
      assert.isTrue(urls.length > 0);
    }),
  );

  it.effect("worker dispatch calls the MCP tool", () =>
    Effect.gen(function* () {
      const tools: string[] = [];
      const workers = makeCtoxNativeSupervisorWorkers({
        connections: {
          resolveReadyTarget: () =>
            Effect.succeed({ endpoint: "https://v3.invalid/mcp", token: "t" }) as never,
          probe: () => Effect.void as never,
        },
        transport: {
          probe: () => Effect.void,
          callTool: (_target: unknown, name: string) =>
            Effect.sync(() => {
              tools.push(name);
              return { isError: true };
            }),
        } as unknown as ReturnType<typeof makeCtoxMcpTransport>,
      });
      yield* workers
        .register(
          { connectionId: "c" as never, instanceId: "v3-instance" },
          {
            sourceEnvironmentId: "desktop" as never,
            sourceSupervisorThreadId: "supervisor" as never,
            projectId: "project" as never,
          },
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(tools, ["business_os.workjet_worker_dispatch"]);
    }),
  );
});
