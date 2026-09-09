import * as Schema from "effect/Schema";
import {
  CTOX_BUSINESS_DATA_MAX_PAGE_DOCUMENTS,
  CTOX_BUSINESS_DATA_MAX_SNAPSHOT_BYTES,
  CTOX_BUSINESS_DATA_PROTOCOL_VERSION,
  NativeBusinessDataEventSchema,
  NativeBusinessDataRequestSchema,
  NativeBusinessDataResponseSchema,
  NativeBusinessDataSessionStateSchema,
  type NativeBusinessDataBinding,
  type NativeBusinessDataCommandState,
  type NativeBusinessDataEventPayload,
  type NativeBusinessDataOperation,
  type NativeBusinessDataRecord,
  type NativeBusinessDataSessionRef,
} from "@workjet/contracts/ctoxBusinessData";
import { CTOX_SYNC_IPC_MAX_FRAME_BYTES } from "@workjet/contracts/ctoxSync";

type Watch = Extract<NativeBusinessDataOperation, { type: "watch" }>;
export type BusinessDataPhase =
  | "awaitingSnapshot"
  | "snapshot"
  | "catchingUp"
  | "recovering"
  | "live"
  | "disconnected"
  | "closed"
  | "revoked"
  | "error";

export type BusinessDataApplied =
  | { readonly kind: "ignored" | "changed" }
  | {
      readonly kind: "liveChange";
      readonly payload: Extract<NativeBusinessDataEventPayload, { type: "upsert" | "remove" }>;
    }
  | { readonly kind: "command"; readonly state: NativeBusinessDataCommandState };

const options = { onExcessProperty: "error" } as const;
const decodeReady = Schema.decodeUnknownSync(NativeBusinessDataSessionStateSchema, options);
const decodeRequest = Schema.decodeUnknownSync(NativeBusinessDataRequestSchema, options);
const decodeResponse = Schema.decodeUnknownSync(NativeBusinessDataResponseSchema, options);
const decodeEvent = Schema.decodeUnknownSync(NativeBusinessDataEventSchema, options);
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid BusinessData subscription input.");
}
function validId(value: string) {
  return (
    value.length > 0 &&
    byteLength(value) <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}
function validCursor(value: string) {
  return value.length > 0 && byteLength(value) <= 4096;
}
function sameSession(a: NativeBusinessDataSessionRef, b: NativeBusinessDataSessionRef) {
  return a.handle === b.handle && a.generation === b.generation;
}
function bindingKey(binding: NativeBusinessDataBinding) {
  return JSON.stringify([binding.targetId, binding.instanceId, binding.userId]);
}
function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    requireValid(
      item !== undefined &&
        typeof item !== "function" &&
        typeof item !== "symbol" &&
        typeof item !== "bigint" &&
        (typeof item !== "number" || Number.isFinite(item)),
    );
    return item;
  });
  requireValid(typeof encoded === "string");
  return encoded;
}

/**
 * Ephemeral projection of one native-authorized subscription. It neither opens
 * an endpoint nor authenticates a session, writes business data or retries a
 * command. The host must supply actual native ready/watch/subscribed messages.
 * Documents still require their existing domain validation before UI use.
 */
export class BusinessDataSubscription {
  readonly #session: NativeBusinessDataSessionRef;
  readonly #binding: NativeBusinessDataBinding;
  readonly #queryKey: string;
  readonly #subscriptionId: string;
  #phase: BusinessDataPhase = "awaitingSnapshot";
  #sequence = 0;
  #snapshotId: string | null = null;
  #cursor: string | null = null;
  #records = new Map<string, { encoded: string; bytes: number }>();
  #bytes = 0;
  #reason: string | null = null;

  private constructor(
    session: NativeBusinessDataSessionRef,
    binding: NativeBusinessDataBinding,
    query: Watch["query"],
    subscriptionId: string,
  ) {
    this.#session = { ...session };
    this.#binding = { ...binding };
    this.#queryKey = encodeJson(query);
    this.#subscriptionId = subscriptionId;
  }

  static open(
    readyInput: unknown,
    requestInput: unknown,
    responseInput: unknown,
    previous?: BusinessDataSubscription,
  ): BusinessDataSubscription {
    try {
      const ready = decodeReady(readyInput);
      const request = decodeRequest(requestInput);
      const response = decodeResponse(responseInput);
      requireValid(
        ready.type === "ready" &&
          request.operation.type === "watch" &&
          response.result.type === "subscribed",
      );
      requireValid(
        request.version === CTOX_BUSINESS_DATA_PROTOCOL_VERSION &&
          response.version === request.version &&
          validId(request.requestId) &&
          response.requestId === request.requestId,
      );
      requireValid(byteLength(encodeJson(request)) <= CTOX_SYNC_IPC_MAX_FRAME_BYTES);
      const watch = request.operation;
      requireValid(
        sameSession(ready.session, watch.session) &&
          sameSession(ready.session, response.result.session),
      );
      requireValid(
        validId(ready.session.handle) &&
          Number.isSafeInteger(ready.session.generation) &&
          ready.session.generation > 0 &&
          validId(response.result.subscriptionId),
      );
      requireValid(Object.values(ready.binding).every(validId));
      requireValid(
        validId(watch.query.collection) &&
          Number.isInteger(watch.query.pageSize) &&
          watch.query.pageSize > 0 &&
          watch.query.pageSize <= CTOX_BUSINESS_DATA_MAX_PAGE_DOCUMENTS,
      );
      requireValid(
        watch.query.query !== null &&
          typeof watch.query.query === "object" &&
          !Array.isArray(watch.query.query),
      );
      if (watch.query.scope.type !== "instance") {
        requireValid(validId(watch.query.scope.projectId));
        if (watch.query.scope.type === "thread") requireValid(validId(watch.query.scope.threadId));
      }
      const next = new BusinessDataSubscription(
        ready.session,
        ready.binding,
        watch.query,
        response.result.subscriptionId,
      );
      if (watch.resumeCursor != null) {
        requireValid(
          validCursor(watch.resumeCursor) &&
            previous &&
            (previous.#phase === "live" || previous.#phase === "disconnected") &&
            previous.#cursor === watch.resumeCursor &&
            bindingKey(previous.#binding) === bindingKey(next.#binding) &&
            previous.#queryKey === next.#queryKey &&
            (!sameSession(previous.#session, next.#session) ||
              previous.#subscriptionId !== next.#subscriptionId),
        );
        next.#records = new Map(previous.#records);
        next.#bytes = previous.#bytes;
        next.#cursor = previous.#cursor;
        next.#phase = "recovering";
      }
      return next;
    } catch {
      // Schema diagnostics may contain private document/request contents.
      throw new Error("Invalid BusinessData subscription binding or resume checkpoint.");
    }
  }

  /** Only a caught-up projection is visible. A read cannot mutate our resume baseline. */
  read() {
    return {
      phase: this.#phase,
      session: { ...this.#session },
      binding: { ...this.#binding },
      subscriptionId: this.#subscriptionId,
      sequence: this.#sequence,
      snapshotId: this.#snapshotId,
      cursor: this.#phase === "live" ? this.#cursor : null,
      reason: this.#reason,
      records:
        this.#phase === "live"
          ? Array.from(
              this.#records.values(),
              ({ encoded }) => JSON.parse(encoded) as NativeBusinessDataRecord,
            )
          : [],
    };
  }

  /** Hide data immediately. A complete in-memory baseline may be resumed only
   * after a new native ready binding and subscribed acknowledgement match it. */
  disconnect() {
    if (this.#phase === "closed" || this.#phase === "revoked" || this.#phase === "error") return;
    if (this.#phase !== "live") this.#clear();
    this.#phase = "disconnected";
  }

  close() {
    this.#clear();
    this.#phase = "closed";
  }

  apply(input: unknown): BusinessDataApplied {
    if (["closed", "disconnected", "revoked", "error"].includes(this.#phase)) {
      return { kind: "ignored" };
    }
    try {
      const event = decodeEvent(input);
      if (
        !sameSession(event.session, this.#session) ||
        event.subscriptionId !== this.#subscriptionId
      )
        return { kind: "ignored" };
      requireValid(
        event.version === CTOX_BUSINESS_DATA_PROTOCOL_VERSION &&
          Number.isSafeInteger(event.sequence) &&
          event.sequence === this.#sequence + 1,
      );
      this.#sequence = event.sequence;
      const payload = event.payload;
      switch (payload.type) {
        case "snapshotStart":
          requireValid(this.#phase === "awaitingSnapshot" && validId(payload.snapshotId));
          this.#snapshotId = payload.snapshotId;
          this.#phase = "snapshot";
          break;
        case "snapshotPage":
          requireValid(
            this.#phase === "snapshot" &&
              payload.snapshotId === this.#snapshotId &&
              payload.records.length <= CTOX_BUSINESS_DATA_MAX_PAGE_DOCUMENTS,
          );
          for (const record of payload.records) this.#put(record, true);
          break;
        case "snapshotEnd":
          requireValid(
            this.#phase === "snapshot" &&
              payload.snapshotId === this.#snapshotId &&
              validCursor(payload.cursor),
          );
          this.#phase = "catchingUp";
          break;
        case "caughtUp":
          requireValid(
            (this.#phase === "catchingUp" || this.#phase === "recovering") &&
              validCursor(payload.cursor),
          );
          this.#cursor = payload.cursor;
          this.#phase = "live";
          break;
        case "upsert":
        case "remove": {
          requireValid(
            validCursor(payload.cursor) &&
              ((this.#phase === "live" && !payload.recovery) ||
                (this.#phase === "recovering" && payload.recovery)),
          );
          if (payload.type === "upsert") this.#put(payload.record, false);
          else {
            requireValid(validId(payload.documentId));
            const old = this.#records.get(payload.documentId);
            if (old) {
              this.#bytes -= old.bytes;
              this.#records.delete(payload.documentId);
            }
          }
          this.#cursor = payload.cursor;
          return payload.recovery ? { kind: "changed" } : { kind: "liveChange", payload };
        }
        case "reset":
          this.#clear();
          this.#phase = "awaitingSnapshot";
          break;
        case "revoked":
          this.#clear();
          this.#phase = "revoked";
          this.#reason = "revoked";
          break;
        case "error":
          this.#clear();
          this.#phase = "error";
          this.#reason = payload.code;
          break;
        case "command":
          requireValid(validId(payload.state.commandId));
          return { kind: "command", state: payload.state };
      }
      return { kind: "changed" };
    } catch {
      this.#clear();
      this.#phase = "error";
      this.#reason = "invalidEvent";
      return { kind: "changed" };
    }
  }

  #clear() {
    this.#records.clear();
    this.#bytes = 0;
    this.#cursor = null;
    this.#snapshotId = null;
  }

  #put(record: NativeBusinessDataRecord, initial: boolean) {
    requireValid(validId(record.documentId) && record.document !== undefined);
    const old = this.#records.get(record.documentId);
    requireValid(!initial || !old);
    const encoded = encodeJson(record);
    const bytes = byteLength(encoded);
    const total = this.#bytes - (old?.bytes ?? 0) + bytes;
    const count = this.#records.size + (old ? 0 : 1);
    requireValid(total + Math.max(0, count - 1) + 2 <= CTOX_BUSINESS_DATA_MAX_SNAPSHOT_BYTES);
    this.#records.set(record.documentId, { encoded, bytes });
    this.#bytes = total;
  }
}
