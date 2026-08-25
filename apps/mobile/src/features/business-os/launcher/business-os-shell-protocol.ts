import {
  decodeBusinessOsMobileAppCatalog,
  type BusinessOsMobileAppCatalog,
} from "./business-os-app-catalog";

export const BUSINESS_OS_SHELL_PROTOCOL = "workjet.business-os-shell.v1" as const;
export const BUSINESS_OS_SHELL_MESSAGE_MAX_BYTES = 65_536;

export type BusinessOsHostCommand =
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "host.configure";
      readonly platform: "ios" | "android";
      readonly windowClass: "compact" | "medium" | "expanded";
      readonly colorScheme: "light" | "dark";
      readonly reducedMotion: boolean;
      readonly locale: string;
    }
  | { readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL; readonly type: "catalog.request" }
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "app.open" | "app.close" | "app.suspend" | "app.resume";
      readonly appId: string;
    }
  | { readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL; readonly type: "navigation.back" }
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "action.invoke";
      readonly appId: string;
      readonly actionId: string;
    };

export type BusinessOsShellMessage =
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "shell.ready";
      readonly revision: string;
    }
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "catalog.replace";
      readonly catalog: BusinessOsMobileAppCatalog;
    }
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "app.state";
      readonly appId: string;
      readonly title: string;
      readonly canGoBack: boolean;
      readonly state: "opening" | "active" | "suspended" | "closed";
      readonly actions: readonly string[];
    }
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "badge.update";
      readonly appId: string;
      readonly count: number;
      readonly attention: boolean;
    }
  | {
      readonly protocol: typeof BUSINESS_OS_SHELL_PROTOCOL;
      readonly type: "shell.error";
      readonly code: string;
      readonly retryable: boolean;
    };

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function safeString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function encodeBusinessOsHostCommand(command: BusinessOsHostCommand): string {
  if ("appId" in command && command.appId === "desktop") {
    throw new Error("Desktop is the native Business OS home route on mobile.");
  }
  const raw = JSON.stringify(command);
  if (new TextEncoder().encode(raw).byteLength > BUSINESS_OS_SHELL_MESSAGE_MAX_BYTES) {
    throw new Error("Business OS host command is too large.");
  }
  return raw;
}

export function decodeBusinessOsShellMessage(raw: string): BusinessOsShellMessage {
  if (new TextEncoder().encode(raw).byteLength > BUSINESS_OS_SHELL_MESSAGE_MAX_BYTES) {
    throw new Error("Business OS shell message is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Business OS shell message is not JSON.");
  }
  const message = record(parsed);
  if (message?.protocol !== BUSINESS_OS_SHELL_PROTOCOL || typeof message.type !== "string") {
    throw new Error("Business OS shell protocol is unsupported.");
  }
  if (
    message.type === "shell.ready" &&
    hasOnlyKeys(message, ["protocol", "type", "revision"]) &&
    safeString(message.revision, 256)
  ) {
    return {
      protocol: BUSINESS_OS_SHELL_PROTOCOL,
      type: "shell.ready",
      revision: message.revision,
    };
  }
  if (message.type === "catalog.replace" && hasOnlyKeys(message, ["protocol", "type", "catalog"])) {
    return {
      protocol: BUSINESS_OS_SHELL_PROTOCOL,
      type: "catalog.replace",
      catalog: decodeBusinessOsMobileAppCatalog(message.catalog),
    };
  }
  if (
    message.type === "app.state" &&
    hasOnlyKeys(message, ["protocol", "type", "appId", "title", "canGoBack", "state", "actions"]) &&
    typeof message.appId === "string" &&
    SAFE_ID.test(message.appId) &&
    safeString(message.title, 80) &&
    typeof message.canGoBack === "boolean" &&
    ["opening", "active", "suspended", "closed"].includes(String(message.state)) &&
    Array.isArray(message.actions) &&
    message.actions.length <= 8 &&
    message.actions.every((action) => typeof action === "string" && SAFE_CODE.test(action))
  ) {
    return {
      protocol: BUSINESS_OS_SHELL_PROTOCOL,
      type: "app.state",
      appId: message.appId,
      title: message.title,
      canGoBack: message.canGoBack,
      state: message.state as "opening" | "active" | "suspended" | "closed",
      actions: Object.freeze(message.actions),
    };
  }
  if (
    message.type === "badge.update" &&
    hasOnlyKeys(message, ["protocol", "type", "appId", "count", "attention"]) &&
    typeof message.appId === "string" &&
    SAFE_ID.test(message.appId) &&
    Number.isSafeInteger(message.count) &&
    Number(message.count) >= 0 &&
    Number(message.count) <= 999 &&
    typeof message.attention === "boolean"
  ) {
    return {
      protocol: BUSINESS_OS_SHELL_PROTOCOL,
      type: "badge.update",
      appId: message.appId,
      count: Number(message.count),
      attention: message.attention,
    };
  }
  if (
    message.type === "shell.error" &&
    hasOnlyKeys(message, ["protocol", "type", "code", "retryable"]) &&
    typeof message.code === "string" &&
    SAFE_CODE.test(message.code) &&
    typeof message.retryable === "boolean"
  ) {
    return {
      protocol: BUSINESS_OS_SHELL_PROTOCOL,
      type: "shell.error",
      code: message.code,
      retryable: message.retryable,
    };
  }
  throw new Error("Business OS shell message is invalid.");
}
