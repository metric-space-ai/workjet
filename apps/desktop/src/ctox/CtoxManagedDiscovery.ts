// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeCrypto from "node:crypto";

import type {
  CtoxManagedDiscoveryFailureCode,
  CtoxManagedDiscoveryResult,
  CtoxManagedInstance,
  CtoxManagedInstanceSource,
} from "@t3tools/contracts";

const DEFAULT_CTOX_MANAGED_BASE_URL = "https://ctox.dev";
const CTOX_DESKTOP_CLIENT_HEADER = "ctox-business-os-desktop";
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

interface FetchCompatibleResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export interface CtoxManagedDiscoveryFetchInit {
  readonly cache: "no-store";
  readonly credentials: "include";
  readonly headers: Readonly<Record<string, string>>;
}

export type CtoxManagedDiscoveryFetch = (
  url: string,
  init: CtoxManagedDiscoveryFetchInit,
) => Promise<FetchCompatibleResponse>;

export interface CtoxManagedDiscoveryOptions {
  readonly baseUrl?: string;
  readonly fetchImpl: CtoxManagedDiscoveryFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFetchCompatibleResponse(value: unknown): value is FetchCompatibleResponse {
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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeTextField(
  record: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string | undefined {
  const value = stringField(record, key);
  if (value === undefined || value.length > maximumLength || hasAsciiControlCharacter(value)) {
    return undefined;
  }
  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function isDnsHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  return hostname
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

function normalizeRendererHostname(rawValue: string): string | undefined {
  const value = rawValue.trim();
  let hostname = value;

  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    hostname = url.hostname;
  }

  const normalized = hostname.toLowerCase();
  return isDnsHostname(normalized) ? normalized : undefined;
}

function safeDomainField(record: Record<string, unknown>): string | undefined {
  for (const key of ["domain", "businessOsUrl"]) {
    const value = stringField(record, key);
    if (value === undefined) continue;
    const hostname = normalizeRendererHostname(value);
    if (hostname !== undefined) return hostname;
  }
  return undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/**
 * Restricts the credential-bearing discovery request to the CTOX control-plane
 * or an explicit loopback development server.
 */
export function normalizeCtoxManagedBaseUrl(rawBaseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawBaseUrl.trim());
  } catch {
    return undefined;
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.pathname !== "/"
  ) {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  if (isLoopbackHostname(hostname)) {
    return url.protocol === "http:" ? url.origin : undefined;
  }

  const isCtoxDev = hostname === "ctox.dev" || hostname.endsWith(".ctox.dev");
  if (!isCtoxDev || url.protocol !== "https:" || url.port !== "") return undefined;
  return url.origin;
}

/**
 * Creates the persistent Electron storage boundary locally. The server cannot
 * choose or alias this value. Hash input retains the exact case and full id.
 */
export function ctoxManagedSessionPartition(input: {
  readonly source: CtoxManagedInstanceSource;
  readonly id: string;
}): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(input.source, "utf8")
    .update("\0", "utf8")
    .update(input.id, "utf8")
    .digest("hex");
  return `persist:workjet-ctox-${input.source}-${digest}`;
}

function normalizeTenant(rawTenant: unknown): CtoxManagedInstance | undefined {
  if (!isRecord(rawTenant)) return undefined;

  const tenantId = stringField(rawTenant, "id");
  if (tenantId === undefined || tenantId.length > 256 || !TENANT_ID_PATTERN.test(tenantId)) {
    return undefined;
  }

  const id = `managed:${tenantId}`;
  const domain = safeDomainField(rawTenant);
  const displayName =
    safeTextField(rawTenant, "businessName", 256) ??
    domain ??
    safeTextField(rawTenant, "slug", 256) ??
    tenantId;
  const role = safeTextField(rawTenant, "tenantRole", 128);
  const dataPlaneReady = rawTenant.healthStatus === "ok" || rawTenant.status === "active";

  return {
    id,
    source: "ctox_dev",
    displayName,
    status: rawTenant.launchAllowed === false ? "needs_auth" : "available",
    ...(domain === undefined ? {} : { domain }),
    ...(role === undefined ? {} : { role }),
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      dataPlaneReady,
      httpDataProxy: false,
      nativePeerObserved: dataPlaneReady,
    },
  };
}

function compareManagedInstances(left: CtoxManagedInstance, right: CtoxManagedInstance): number {
  const leftName = left.displayName.toLowerCase();
  const rightName = right.displayName.toLowerCase();
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Normalizes only the public tenant metadata needed by the Workjet renderer. */
export function normalizeCtoxDevSessionPackage(
  payload: unknown,
): readonly CtoxManagedInstance[] | undefined {
  if (!isRecord(payload) || !isRecord(payload.account) || !Array.isArray(payload.account.tenants)) {
    return undefined;
  }
  if (payload.account.tenants.length > 1_000) return undefined;

  const instances: CtoxManagedInstance[] = [];
  const instanceIds = new Set<string>();
  for (const rawTenant of payload.account.tenants) {
    const instance = normalizeTenant(rawTenant);
    if (instance === undefined || instanceIds.has(instance.id)) return undefined;
    instanceIds.add(instance.id);
    instances.push(instance);
  }
  return instances.sort(compareManagedInstances);
}

function failure(
  code: CtoxManagedDiscoveryFailureCode,
  httpStatus?: number,
): CtoxManagedDiscoveryResult {
  if (
    httpStatus !== undefined &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
  ) {
    return { _tag: "failed", code, httpStatus };
  }
  return { _tag: "failed", code };
}

/**
 * Discovers the currently authenticated ctox.dev tenants. Every failure path
 * returns a fixed, renderer-safe value and intentionally discards exceptions,
 * response bodies, and untrusted payloads.
 */
export async function discoverCtoxManagedInstances(
  options: CtoxManagedDiscoveryOptions,
): Promise<CtoxManagedDiscoveryResult> {
  const baseUrl = normalizeCtoxManagedBaseUrl(options.baseUrl ?? DEFAULT_CTOX_MANAGED_BASE_URL);
  if (baseUrl === undefined) return failure("invalid_base_url");

  let response: FetchCompatibleResponse;
  try {
    const candidate: unknown = await options.fetchImpl(`${baseUrl}/api/desktop/session-package`, {
      cache: "no-store",
      credentials: "include",
      headers: { "x-ctox-desktop-client": CTOX_DESKTOP_CLIENT_HEADER },
    });
    if (!isFetchCompatibleResponse(candidate)) {
      return failure("invalid_response");
    }
    response = candidate;
  } catch {
    return failure("network_error");
  }

  if (response.status === 401) return { _tag: "signed_out" };
  if (!response.ok) return failure("http_error", response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failure("invalid_response");
  }

  let instances: readonly CtoxManagedInstance[] | undefined;
  try {
    instances = normalizeCtoxDevSessionPackage(payload);
  } catch {
    return failure("invalid_response");
  }
  if (instances === undefined) return failure("invalid_response");
  return { _tag: "ready", instances };
}
