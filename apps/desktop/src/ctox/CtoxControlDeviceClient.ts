// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { createCtoxDeviceProofKey, restoreCtoxDeviceProofKey } from "./CtoxDeviceProofKey.ts";
import { normalizeCtoxManagedBaseUrl } from "./CtoxManagedDiscovery.ts";
import type { CtoxControlDeviceStatus } from "@workjet/contracts";

export const DEVICE_SECRET_NAME = "ctox-control-device-key";
const RecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  baseUrl: Schema.String,
  pkcs8: Schema.String,
  id: Schema.String,
  thumbprint: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  state: Schema.Literals(["active", "invalid", "disabled"]),
});
type DeviceRecord = typeof RecordSchema.Type;
const RecordJson = Schema.fromJsonString(RecordSchema);
const DeviceRow = Schema.Struct({
  id: Schema.String,
  thumbprint: Schema.String,
  created_at: Schema.String,
});
const Enrollment = Schema.Struct({ device: DeviceRow });
const Listing = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      created_at: Schema.String,
      last_used_at: Schema.NullOr(Schema.String),
      revoked_at: Schema.NullOr(Schema.String),
      expired: Schema.Boolean,
    }),
  ),
});
const Challenge = Schema.Struct({ nonce: Schema.String, expiresAt: Schema.String });
const Failure = Schema.Struct({
  error: Schema.Literals([
    "AUTH_REQUIRED",
    "DEVICE_AUTH_REQUIRED",
    "DEVICE_FRESH_LOGIN_REQUIRED",
    "DEVICE_SCOPE_DENIED",
    "DEVICE_THUMBPRINT_ALREADY_REGISTERED",
    "DEVICE_KEY_LIMIT_REACHED",
    "DEVICE_SERVICE_UNAVAILABLE",
    "DEVICE_TENANT_DENIED",
  ]),
});
const decodeRecord = Schema.decodeUnknownOption(RecordJson);
const encodeRecord = Schema.encodeSync(RecordJson);
const decodeFailure = Schema.decodeUnknownOption(Failure);
const decodeChallenge = Schema.decodeUnknownSync(Challenge);
const decodeListing = Schema.decodeUnknownSync(Listing);
const decodeEnrollment = Schema.decodeUnknownSync(Enrollment);
const DAY = 86_400_000;
export class CtoxControlDeviceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** No cookies, private keys, launch URLs or upstream text cross this owner's status boundary. */
export function makeControlDeviceClient(input: {
  readonly baseUrl: string;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}) {
  const baseUrl = normalizeCtoxManagedBaseUrl(input.baseUrl);
  if (baseUrl === undefined) throw new CtoxControlDeviceError("DEVICE_CONFIGURATION_INVALID");
  const now = input.now ?? (() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
  let notice: string | undefined;
  let recovery: Promise<Response | undefined> | undefined;
  let queue = Promise.resolve();
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const next = queue.then(operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const read = async () => {
    const bytes = await input.read();
    if (bytes === undefined) return undefined;
    const decoded = decodeRecord(new TextDecoder().decode(bytes));
    if (decoded._tag === "None") {
      notice = "DEVICE_SERVICE_UNAVAILABLE";
      return undefined;
    }
    const record = decoded.value;
    return record.baseUrl === baseUrl ? record : undefined;
  };
  const save = (record: DeviceRecord) =>
    input.write(new TextEncoder().encode(encodeRecord(record)));
  const expiry = (record: DeviceRecord) =>
    Math.min(
      Date.parse(record.createdAt) + 180 * DAY,
      Date.parse(record.lastUsedAt ?? record.createdAt) + 30 * DAY,
    );
  const active = (record: DeviceRecord | undefined): record is DeviceRecord =>
    record !== undefined && record.state === "active" && expiry(record) > now();
  const status = async (): Promise<CtoxControlDeviceStatus> => {
    const record = await read();
    return {
      state: active(record) ? "active" : "not_configured",
      ...(record === undefined
        ? {}
        : {
            createdAt: record.createdAt,
            lastUsedAt: record.lastUsedAt,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiry(record))),
          }),
      ...(notice === undefined ? {} : { notice }),
    };
  };
  const checked = async (response: Response) => {
    if (response.ok) return response;
    const decoded = decodeFailure(await response.json().catch(() => undefined));
    const code =
      decoded._tag === "Some"
        ? decoded.value.error === "AUTH_REQUIRED"
          ? "DEVICE_AUTH_REQUIRED"
          : decoded.value.error
        : "DEVICE_SERVICE_UNAVAILABLE";
    throw new CtoxControlDeviceError(code);
  };
  const request = (
    pathname: string,
    init: { readonly method: "GET" | "POST"; readonly body?: string },
  ) =>
    exclusive(async () => {
      if (
        !(
          (init.method === "GET" &&
            ["/api/desktop/discovery", "/api/desktop/session-package"].includes(pathname)) ||
          (init.method === "POST" && pathname === "/api/desktop/launch-token")
        )
      )
        throw new CtoxControlDeviceError("DEVICE_SCOPE_DENIED");
      const record = await read();
      if (!active(record)) throw new CtoxControlDeviceError("DEVICE_AUTH_REQUIRED");
      try {
        const response = await checked(
          await input.fetch(`${baseUrl}/api/desktop/device-keys/challenge`, {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(8_000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ thumbprint: record.thumbprint }),
          }),
        );
        const challenge = decodeChallenge(await response.json());
        if (Date.parse(challenge.expiresAt) <= now())
          throw new CtoxControlDeviceError("DEVICE_AUTH_REQUIRED");
        const body = init.body ?? "";
        const key = restoreCtoxDeviceProofKey(Redacted.make(record.pkcs8));
        const proof = key.signRequest({
          nonce: challenge.nonce,
          method: init.method,
          baseUrl,
          pathname,
          body,
        });
        const result = await checked(
          await input.fetch(baseUrl + pathname, {
            method: init.method,
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(8_000),
            headers: {
              "content-type": "application/json",
              "x-ctox-desktop-client": "ctox-business-os-desktop",
              "x-ctox-device-thumbprint": record.thumbprint,
              "x-ctox-device-nonce": challenge.nonce,
              "x-ctox-device-signature": proof,
            },
            ...(init.method === "POST" ? { body } : {}),
          }),
        );
        await save({ ...record, lastUsedAt: DateTime.formatIso(DateTime.makeUnsafe(now())) });
        notice = undefined;
        return result;
      } catch (error) {
        if (error instanceof CtoxControlDeviceError && error.code === "DEVICE_AUTH_REQUIRED")
          await save({ ...record, state: "invalid" });
        throw error;
      }
    });
  const enroll = (cookieFetch: typeof input.fetch, force = false) =>
    exclusive(async () => {
      const previous = await read();
      try {
        if (
          previous !== undefined &&
          previous.state !== "invalid" &&
          expiry(previous) > now() &&
          !force
        ) {
          const listed = await checked(
            await cookieFetch(baseUrl + "/api/desktop/device-keys", {
              credentials: "include",
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(8_000),
            }),
          );
          const devices = decodeListing(await listed.json()).devices;
          const same = devices.find((device) => device.id === previous.id);
          if (same !== undefined && same.revoked_at === null && !same.expired) {
            await save({
              ...previous,
              state: "active",
              createdAt: same.created_at,
              lastUsedAt: same.last_used_at,
            });
            notice = undefined;
            recovery = undefined;
            return;
          }
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const key = createCtoxDeviceProofKey();
          const response = await cookieFetch(baseUrl + "/api/desktop/device-keys", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(8_000),
            headers: {
              "content-type": "application/json",
              "x-ctox-desktop-client": "ctox-business-os-desktop",
            },
            body: JSON.stringify({ public_jwk: key.publicJwk, label: "Workjet Desktop" }),
          });
          try {
            const row = decodeEnrollment(await (await checked(response)).json()).device;
            if (row.thumbprint !== key.thumbprint || !Number.isFinite(Date.parse(row.created_at)))
              throw new CtoxControlDeviceError("DEVICE_SERVICE_UNAVAILABLE");
            await save({
              version: 1,
              baseUrl,
              pkcs8: Redacted.value(key.exportForStorage()),
              id: row.id,
              thumbprint: row.thumbprint,
              createdAt: row.created_at,
              lastUsedAt: null,
              state: "active",
            });
            if (force && previous !== undefined && previous.id !== row.id) {
              await cookieFetch(
                `${baseUrl}/api/desktop/device-keys/${encodeURIComponent(previous.id)}`,
                {
                  method: "DELETE",
                  credentials: "include",
                  cache: "no-store",
                  redirect: "error",
                  signal: AbortSignal.timeout(8_000),
                },
              ).catch(() => undefined);
            }
            notice = undefined;
            recovery = undefined;
            return;
          } catch (error) {
            if (
              !(
                error instanceof CtoxControlDeviceError &&
                error.code === "DEVICE_THUMBPRINT_ALREADY_REGISTERED" &&
                attempt === 0
              )
            )
              throw error;
          }
        }
      } catch (error) {
        notice =
          error instanceof CtoxControlDeviceError ? error.code : "DEVICE_SERVICE_UNAVAILABLE";
        // Account transitions must never fall back to a different account's old key.
        if (previous !== undefined) await save({ ...previous, state: "disabled" });
      }
    });
  return {
    status,
    enroll,
    request,
    recoverOnce: () => {
      recovery ??= (async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await request("/api/desktop/session-package", { method: "GET" });
          } catch (error) {
            if (
              error instanceof CtoxControlDeviceError &&
              ["DEVICE_AUTH_REQUIRED", "DEVICE_SCOPE_DENIED"].includes(error.code)
            )
              break;
          }
        }
        return undefined;
      })();
      return recovery.then(async (response) => (active(await read()) ? response : undefined));
    },
    suspend: () =>
      exclusive(async () => {
        const record = await read();
        if (record !== undefined) await save({ ...record, state: "disabled" });
        recovery = Promise.resolve(undefined);
      }),
  };
}
