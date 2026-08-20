// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxManagedInstance } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Session } from "electron";

import { normalizeCtoxManagedBaseUrl } from "./CtoxManagedDiscovery.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";

const DEFAULT_CTOX_DEV_BASE_URL = "https://ctox.dev";
const DESKTOP_CLIENT = "ctox-business-os-desktop";
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeUnknownSync(UnknownJson);

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export interface CtoxManagedLaunchOptions {
  readonly baseUrl?: string;
}

export interface CtoxManagedLaunchConfig {
  /** Transient secret-bearing URL. This value must stay in the main process. */
  readonly launchUrl: string;
  readonly launchOrigin: string;
}

const CtoxManagedLaunchOperation = Schema.Literals([
  "configuration",
  "account-session",
  "launch-token",
  "launch-config",
  "launch-contract",
]);

export class CtoxManagedLaunchError extends Schema.TaggedErrorClass<CtoxManagedLaunchError>()(
  "CtoxManagedLaunchError",
  { operation: CtoxManagedLaunchOperation },
) {
  override get message(): string {
    return "The managed CTOX launch exchange failed.";
  }
}

export class CtoxManagedLaunch extends Context.Service<
  CtoxManagedLaunch,
  {
    readonly launch: (
      descriptor: CtoxManagedInstance,
    ) => Effect.Effect<CtoxManagedLaunchConfig, CtoxManagedLaunchError>;
  }
>()("@t3tools/desktop/ctox/CtoxManagedLaunch") {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is FetchResponse {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    typeof value.json === "function"
  );
}

function tenantIdOf(descriptor: CtoxManagedInstance): string | undefined {
  if (descriptor.source !== "ctox_dev" || !descriptor.id.startsWith("managed:")) return undefined;
  const tenantId = descriptor.id.slice("managed:".length);
  return tenantId.length <= 256 && TENANT_ID_PATTERN.test(tenantId) ? tenantId : undefined;
}

function safeLaunchUrl(rawValue: unknown): URL | undefined {
  if (typeof rawValue !== "string" || rawValue.trim() === "") return undefined;
  try {
    const url = new URL(rawValue);
    if (url.username !== "" || url.password !== "") return undefined;
    if (url.protocol === "https:") return url;
    const hostname = url.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "[::1]" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    return url.protocol === "http:" && loopback ? url : undefined;
  } catch {
    return undefined;
  }
}

function containsRedactedPairingSecret(config: Record<string, unknown>): boolean {
  const signalingUrls = Array.isArray(config.signaling_urls)
    ? config.signaling_urls
    : Array.isArray(config.signalingUrls)
      ? config.signalingUrls
      : [];
  return [
    config.sync_room,
    config.syncRoom,
    config.signaling_room_password,
    config.signalingRoomPassword,
    config.room_password,
    config.roomPassword,
    ...signalingUrls,
  ].some((entry) => /<redacted>|\[redacted\]/i.test(String(entry ?? "")));
}

function packedConfigFromLaunchUrl(launchUrl: URL): Record<string, unknown> | undefined {
  let packed =
    launchUrl.searchParams.get("ctox_config") ?? launchUrl.searchParams.get("ctoxConfig");
  if (packed === null) {
    const hash = launchUrl.hash.replace(/^#/, "");
    const queryStart = hash.indexOf("?");
    if (queryStart >= 0) {
      const parameters = new URLSearchParams(hash.slice(queryStart + 1));
      packed = parameters.get("ctox_config") ?? parameters.get("ctoxConfig");
    }
  }
  if (packed === null || packed === "") return undefined;
  try {
    const decoded = decodeUnknownJson(Buffer.from(packed, "base64url").toString("utf8"));
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function forceWebRtc(config: Record<string, unknown>): Record<string, unknown> | undefined {
  if (config.transport !== undefined && config.transport !== "webrtc") return undefined;
  if (config.http_bridge_available === true) return undefined;
  return { ...config, transport: "webrtc", http_bridge_available: false };
}

function withManagedDesktopInstance(
  config: Record<string, unknown>,
  descriptor: CtoxManagedInstance,
): Record<string, unknown> {
  return {
    ...config,
    desktop_instance: {
      id: descriptor.id,
      source: "ctox_dev",
      display_name: descriptor.displayName,
      domain: descriptor.domain ?? "",
    },
    desktop_managed_auth: { required: true },
  };
}

function buildCanonicalLaunchUrl(
  baseUrl: string,
  config: Record<string, unknown>,
): string | undefined {
  try {
    const launchUrl = new URL("/business-os/", baseUrl);
    launchUrl.searchParams.set(
      "ctox_config",
      Buffer.from(encodeUnknownJson(config), "utf8").toString("base64url"),
    );
    return launchUrl.toString();
  } catch {
    return undefined;
  }
}

async function fetchJson(
  browserSession: Session,
  url: string,
  init: RequestInit,
): Promise<{ readonly response: FetchResponse; readonly payload: unknown } | undefined> {
  try {
    const candidate: unknown = await browserSession.fetch(url, init);
    if (!isResponse(candidate)) return undefined;
    const payload = await candidate.json();
    return { response: candidate, payload };
  } catch {
    return undefined;
  }
}

const { logInfo } = makeComponentLogger("ctox-managed-launch");

export const make = (options: CtoxManagedLaunchOptions = {}) =>
  Effect.gen(function* () {
    const baseUrl = normalizeCtoxManagedBaseUrl(options.baseUrl ?? DEFAULT_CTOX_DEV_BASE_URL);
    if (baseUrl === undefined) {
      return yield* new CtoxManagedLaunchError({ operation: "configuration" });
    }
    const controlOrigin = new URL(baseUrl).origin;
    const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;

    const launch = Effect.fn("CtoxManagedLaunch.launch")(function* (
      descriptor: CtoxManagedInstance,
    ) {
      const tenantId = tenantIdOf(descriptor);
      if (tenantId === undefined || descriptor.status !== "available") {
        return yield* new CtoxManagedLaunchError({ operation: "launch-contract" });
      }
      const browserSession = yield* sessions.account.pipe(
        Effect.mapError(() => new CtoxManagedLaunchError({ operation: "account-session" })),
      );

      const token = yield* Effect.promise(() =>
        fetchJson(browserSession, `${baseUrl}/api/desktop/launch-token`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-ctox-desktop-client": DESKTOP_CLIENT,
          },
          body: encodeUnknownJson({ tenantId }),
        }),
      );
      if (token === undefined || !token.response.ok || !isRecord(token.payload)) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-token" });
      }

      const rawLaunchConfigUrl = token.payload.launchConfigUrl;
      if (typeof rawLaunchConfigUrl !== "string") {
        return yield* new CtoxManagedLaunchError({ operation: "launch-token" });
      }
      let launchConfigUrl: URL;
      try {
        launchConfigUrl = new URL(rawLaunchConfigUrl);
      } catch {
        return yield* new CtoxManagedLaunchError({ operation: "launch-token" });
      }
      if (
        launchConfigUrl.origin !== controlOrigin ||
        launchConfigUrl.username !== "" ||
        launchConfigUrl.password !== ""
      ) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-token" });
      }

      const exchange = yield* Effect.promise(() =>
        fetchJson(browserSession, launchConfigUrl.href, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "x-ctox-desktop-client": DESKTOP_CLIENT },
        }),
      );
      if (exchange === undefined || !exchange.response.ok || !isRecord(exchange.payload)) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-config" });
      }

      const serverLaunchUrl = safeLaunchUrl(exchange.payload.launchUrl);
      if (serverLaunchUrl === undefined || !isRecord(exchange.payload.pairingConfig)) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-contract" });
      }
      const pairingConfig = forceWebRtc(exchange.payload.pairingConfig);
      if (pairingConfig === undefined) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-contract" });
      }

      const selectedConfig = containsRedactedPairingSecret(pairingConfig)
        ? packedConfigFromLaunchUrl(serverLaunchUrl)
        : pairingConfig;
      if (selectedConfig === undefined) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-contract" });
      }
      const webRtcConfig = forceWebRtc(selectedConfig);
      if (webRtcConfig === undefined) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-contract" });
      }
      // Redacted contract trace: origin+path only, never query or secrets.
      // The server names its own launch surface here; when the desktop's
      // canonical path drifts from the deploy (e.g. a retired /business-os/),
      // this line is the evidence.
      yield* logInfo("managed launch contract", {
        serverLaunchOrigin: serverLaunchUrl.origin,
        serverLaunchPath: serverLaunchUrl.pathname,
        pairingRedacted: containsRedactedPairingSecret(pairingConfig),
      });
      const launchUrl = buildCanonicalLaunchUrl(
        baseUrl,
        withManagedDesktopInstance(webRtcConfig, descriptor),
      );
      if (launchUrl === undefined) {
        return yield* new CtoxManagedLaunchError({ operation: "launch-contract" });
      }
      return { launchUrl, launchOrigin: controlOrigin };
    });

    return CtoxManagedLaunch.of({ launch });
  }).pipe(Effect.withSpan("CtoxManagedLaunch.make"));

export const layer = (options: CtoxManagedLaunchOptions = {}) =>
  Layer.effect(CtoxManagedLaunch, make(options));
