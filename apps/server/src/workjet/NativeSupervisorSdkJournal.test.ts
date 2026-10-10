// @effect-diagnostics nodeBuiltinImport:off -- Actual owned Node child fixtures, not actual SDK/model/authority evidence.
import * as NodeChildProcess from "node:child_process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MODEL } from "@workjet/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  NativeSupervisorSdkJournal,
  type NativeSupervisorSdkObservation,
} from "./NativeSupervisorSdkJournal.ts";

const fixtureChild = Effect.fn("NativeSupervisorSdkJournal.fixtureChild")(function* () {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", 'process.stdin.once("data", () => process.exit(0));'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    }),
  );
  return { child, closed, finish: () => child.stdin.end("finish") };
});

it.effect(
  "joins nonempty actual child close, stream/query callbacks and serialized sink; no DTO stop claims",
  () =>
    Effect.gen(function* () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observations: Array<NativeSupervisorSdkObservation> = [];
      const journal = new NativeSupervisorSdkJournal(async (record) => {
        await gate;
        observations.push(record);
      });
      const { child, closed, finish } = yield* fixtureChild();
      journal.captureOwnedSdkChild(child);
      const stream = journal.sdkStreamJoined();
      const query = journal.sdkQueryCloseReturned();
      let drained = false;
      const signal = new AbortController();
      const done = journal.drain(signal.signal).then(() => {
        drained = true;
      });
      finish();
      yield* Effect.promise(() => closed);
      expect(drained).toBe(false);
      expect(observations).toEqual([]);
      release();
      yield* Effect.promise(() => Promise.all([stream, query, done]));
      expect(observations.map((record) => [record.sequence, record.kind])).toEqual([
        [0, "child-spawned"],
        [1, "sdk-stream-joined"],
        [2, "sdk-query-close-returned"],
        [3, "child-closed"],
      ]);
      expect(observations[0]).toMatchObject({ pid: child.pid });
      expect(observations[3]).toMatchObject({ pid: child.pid, exitCode: 0, signal: null });
      expect(journal.currentSdkSessionId()).toBeUndefined();
    }).pipe(Effect.scoped),
);
it.effect(
  "does not drain an empty captured process set even when close callbacks are reported",
  () =>
    Effect.gen(function* () {
      const records: Array<NativeSupervisorSdkObservation> = [];
      const journal = new NativeSupervisorSdkJournal(async (record) => {
        records.push(record);
      });
      yield* Effect.promise(() => journal.sdkStreamJoined());
      yield* Effect.promise(() => journal.sdkQueryCloseReturned());
      const abort = new AbortController();
      const stopped = journal.drain(abort.signal).then(
        () => "unexpected-success",
        () => "aborted",
      );
      abort.abort(new Error("fixture-empty-process-set"));
      expect(yield* Effect.promise(() => stopped)).toBe("aborted");
      expect(records.map((record) => record.kind)).toEqual([
        "sdk-stream-joined",
        "sdk-query-close-returned",
      ]);
    }).pipe(Effect.scoped),
);
it.effect("waits for every actually captured child and refuses duplicate capture", () =>
  Effect.gen(function* () {
    const journal = new NativeSupervisorSdkJournal(async () => {});
    const first = yield* fixtureChild();
    const second = yield* fixtureChild();
    journal.captureOwnedSdkChild(first.child);
    journal.captureOwnedSdkChild(second.child);
    yield* Effect.promise(() => journal.sdkStreamJoined());
    yield* Effect.promise(() => journal.sdkQueryCloseReturned());
    let drained = false;
    const signal = new AbortController();
    const stopped = journal.drain(signal.signal).then(() => {
      drained = true;
    });
    first.finish();
    yield* Effect.promise(() => first.closed);
    expect(drained).toBe(false);
    second.finish();
    yield* Effect.promise(() => stopped);
    expect(drained).toBe(true);
    expect(() => journal.captureOwnedSdkChild(first.child)).toThrow("already captured");
  }).pipe(Effect.scoped),
);
it.effect("sink failure cannot become a successful observed drain", () =>
  Effect.gen(function* () {
    const journal = new NativeSupervisorSdkJournal(async () => {
      throw new Error("fixture durable sink unavailable");
    });
    const fixture = yield* fixtureChild();
    journal.captureOwnedSdkChild(fixture.child);
    const query = journal.sdkQueryCloseReturned().catch(() => undefined);
    fixture.finish();
    yield* Effect.promise(() => fixture.closed);
    yield* Effect.promise(() => query);
    const signal = new AbortController();
    const outcome = yield* Effect.promise(() =>
      journal.drain(signal.signal).then(
        () => "unexpected-success",
        () => "sink-failed",
      ),
    );
    expect(outcome).toBe("sink-failed");
    expect(journal.currentSdkSessionId()).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect(
  "abort bounds a sink that has not returned after the captured child/query have closed",
  () =>
    Effect.gen(function* () {
      const never = new Promise<void>(() => {});
      const journal = new NativeSupervisorSdkJournal(() => never);
      const fixture = yield* fixtureChild();
      journal.captureOwnedSdkChild(fixture.child);
      void journal.sdkStreamJoined().catch(() => {});
      void journal.sdkQueryCloseReturned().catch(() => {});
      fixture.finish();
      yield* Effect.promise(() => fixture.closed);
      const abort = new AbortController();
      const pending = journal.drain(abort.signal).then(
        () => "unexpected-success",
        () => "aborted",
      );
      abort.abort(new Error("fixture-sink-deadline"));
      expect(yield* Effect.promise(() => pending)).toBe("aborted");
    }).pipe(Effect.scoped),
);

const initFixture = (sessionId: string) =>
  ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: "init-observation",
    model: DEFAULT_MODEL,
  }) as unknown as SDKMessage;
const assistantFixture = (sessionId: string, parentToolUseId: string | null = null) =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid: "assistant-observation",
    parent_tool_use_id: parentToolUseId,
    message: {
      id: "upstream-message-observation",
      model: DEFAULT_MODEL,
      content: [{ type: "text", text: "fixture body excluded from metadata" }],
    },
  }) as unknown as SDKMessage;

it.effect(
  "keeps actual parent message/result anchors and omits requested model, bodies and subagent replies",
  () =>
    Effect.gen(function* () {
      const records: Array<NativeSupervisorSdkObservation> = [];
      const journal = new NativeSupervisorSdkJournal(async (record) => {
        records.push(record);
      });
      const fixture = yield* fixtureChild();
      journal.captureOwnedSdkChild(fixture.child);
      yield* Effect.promise(() =>
        journal.observeSdkMessage(initFixture("original-session"), undefined),
      );
      expect(journal.currentSdkSessionId()).toBe("original-session");
      yield* Effect.promise(() => journal.turnSubmitted("original-turn"));
      yield* Effect.promise(() =>
        journal.observeSdkMessage(
          assistantFixture("original-session", "subagent-tool"),
          "original-turn",
        ),
      );
      yield* Effect.promise(() =>
        journal.observeSdkMessage(assistantFixture("original-session"), "another-turn"),
      );
      yield* Effect.promise(() =>
        journal.observeSdkMessage(assistantFixture("original-session"), "original-turn"),
      );
      yield* Effect.promise(() =>
        journal.observeSdkMessage(
          {
            type: "result",
            subtype: "success",
            session_id: "original-session",
            uuid: "result-observation",
            is_error: false,
          } as unknown as SDKMessage,
          "original-turn",
        ),
      );
      expect(records.slice(1)).toEqual([
        {
          version: 1,
          sequence: 1,
          kind: "sdk-init",
          sessionId: "original-session",
          initId: "init-observation",
        },
        { version: 1, sequence: 2, kind: "turn-submitted", turnId: "original-turn" },
        {
          version: 1,
          sequence: 3,
          kind: "parent-assistant",
          sessionId: "original-session",
          turnId: "original-turn",
          messageId: "upstream-message-observation",
          messageModel: DEFAULT_MODEL,
          assistantId: "assistant-observation",
        },
        {
          version: 1,
          sequence: 4,
          kind: "sdk-result",
          sessionId: "original-session",
          turnId: "original-turn",
          resultId: "result-observation",
          subtype: "success",
          isError: false,
        },
      ]);
      expect(records.every(record => !("content" in record))).toBe(true);
      fixture.finish();
      yield* Effect.promise(() => fixture.closed);
      yield* Effect.promise(() => journal.sdkStreamJoined());
      yield* Effect.promise(() => journal.sdkQueryCloseReturned());
      yield* Effect.promise(() => journal.drain(new AbortController().signal));
    }).pipe(Effect.scoped),
);
it.effect("invalidates a replaced SDK session and never drains it successfully", () =>
  Effect.gen(function* () {
    const journal = new NativeSupervisorSdkJournal(async () => {});
    const fixture = yield* fixtureChild();
    journal.captureOwnedSdkChild(fixture.child);
    yield* Effect.promise(() =>
      journal.observeSdkMessage(initFixture("original-session"), undefined),
    );
    const failed = yield* Effect.promise(() =>
      journal.observeSdkMessage(initFixture("replaced-session"), undefined).then(
        () => undefined,
        (cause) => cause,
      ),
    );
    expect(failed).toBeInstanceOf(Error);
    expect(yield* Effect.promise(() => journal.failure)).toBe(failed);
    expect(journal.currentSdkSessionId()).toBeUndefined();
    const outcome = yield* Effect.promise(() =>
      journal.drain(new AbortController().signal).then(
        () => "unexpected-success",
        () => "invalid-session",
      ),
    );
    expect(outcome).toBe("invalid-session");
    fixture.finish();
    yield* Effect.promise(() => fixture.closed);
  }).pipe(Effect.scoped),
);
it.effect(
  "rejects an init without an actual child and a parent reply without the original init",
  () =>
    Effect.gen(function* () {
      const empty = new NativeSupervisorSdkJournal(async () => {});
      const missingChild = yield* Effect.promise(() =>
        empty.observeSdkMessage(initFixture("original-session"), undefined).then(
          () => undefined,
          (cause) => cause,
        ),
      );
      expect(missingChild).toBeInstanceOf(Error);
      const journal = new NativeSupervisorSdkJournal(async () => {});
      const fixture = yield* fixtureChild();
      journal.captureOwnedSdkChild(fixture.child);
      yield* Effect.promise(() => journal.turnSubmitted("original-turn"));
      const missingInit = yield* Effect.promise(() =>
        journal.observeSdkMessage(assistantFixture("original-session"), "original-turn").then(
          () => undefined,
          (cause) => cause,
        ),
      );
      expect(missingInit).toBeInstanceOf(Error);
      expect(journal.currentSdkSessionId()).toBeUndefined();
      fixture.finish();
      yield* Effect.promise(() => fixture.closed);
    }).pipe(Effect.scoped),
);
it.effect(
  "bounds observations at the native sequence limit without throwing from child-close callbacks",
  () =>
    Effect.gen(function* () {
      const records: Array<NativeSupervisorSdkObservation> = [];
      const journal = new NativeSupervisorSdkJournal(async (record) => {
        records.push(record);
      });
      const fixture = yield* fixtureChild();
      journal.captureOwnedSdkChild(fixture.child);
      yield* Effect.promise(() => journal.observeSdkMessage(initFixture("original-session"), undefined));
      yield* Effect.promise(() => journal.turnSubmitted("original-turn"));
      yield* Effect.promise(async () => {
        for (let index = 3; index < 512; index++)
          await journal.observeSdkMessage(assistantFixture("original-session"), "original-turn");
      });
      expect(records).toHaveLength(512);
      expect(records.at(-1)?.sequence).toBe(511);
      fixture.finish();
      yield* Effect.promise(() => fixture.closed);
      const failure = yield* Effect.promise(() => journal.failure);
      expect(failure.message).toContain("observation limit");
      expect(records).toHaveLength(512);
      const outcome = yield* Effect.promise(() =>
        journal.drain(new AbortController().signal).then(
          () => "unexpected-success",
          () => "bounded-failure",
        ),
      );
      expect(outcome).toBe("bounded-failure");
    }).pipe(Effect.scoped),
);
