// @effect-diagnostics globalFetch:off globalDate:off -- Public HTTP catalog boundary; no account credentials.
import * as Schema from "effect/Schema";
import type { WorkjetGatewayProvider } from "@workjet/contracts";

export const PublicModelCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  checkedAt: Schema.String,
  expiresAt: Schema.String,
  providers: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      status: Schema.Literals(["observed", "unavailable"]),
      models: Schema.Array(Schema.String),
    }),
  ),
});
const decodeCatalog = Schema.decodeUnknownSync(PublicModelCatalog);
const PROVIDERS: Readonly<Partial<Record<WorkjetGatewayProvider, string>>> = {
  codex: "openai",
  claude: "anthropic",
  kimi: "kimi",
  xai: "xai",
  zai: "zai",
  minimax: "minimax",
};

/** Cached suggestions retain their upstream timestamp and expire after seven days. */
export function decodePublicModelCatalog(
  value: unknown,
  nowMs: number,
  cached = false,
): typeof PublicModelCatalog.Type | undefined {
  try {
    const catalog = decodeCatalog(value);
    const checked = Date.parse(catalog.checkedAt);
    const expires = Date.parse(catalog.expiresAt);
    if (
      !Number.isFinite(checked) ||
      !Number.isFinite(expires) ||
      checked > nowMs + 5_000 ||
      checked < nowMs - (cached ? 7 * 24 * 60 * 60 * 1_000 : 300_000) ||
      expires <= checked ||
      (!cached && expires <= nowMs) ||
      expires > checked + 300_000 ||
      catalog.providers.length > 32
    )
      return undefined;
    if (
      new Set(catalog.providers.map((entry) => entry.provider)).size !== catalog.providers.length ||
      catalog.providers.some(
        (entry) =>
          entry.models.length > 1024 ||
          entry.models.some(
            (id) => !id || id.length > 160 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id),
          ),
      )
    )
      return undefined;
    return catalog;
  } catch {
    return undefined;
  }
}

export function decodeLiveProviderModels(
  value: unknown,
  provider: WorkjetGatewayProvider,
  nowMs: number,
  cached = false,
): ReadonlyArray<string> | undefined {
  const catalog = decodePublicModelCatalog(value, nowMs, cached);
  const entry = catalog?.providers.find((item) => item.provider === PROVIDERS[provider]);
  return entry?.status === "observed" ? [...new Set(entry.models)].sort() : undefined;
}

export async function readPublicModelCatalog(
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<unknown> {
  const signal = AbortSignal.timeout(8_000);
  const response = await request("https://llm.ctox.dev/catalog", {
    headers: { Accept: "application/json", "User-Agent": "Workjet-Model-Catalog" },
    credentials: "omit",
    redirect: "error",
    signal,
  });
  const length = response.headers.get("content-length");
  if (
    !response.ok ||
    !response.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > 128 * 1024))
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("catalog-unavailable");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 128 * 1024) throw new Error("catalog-unavailable");
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
