// @effect-diagnostics globalFetch:off globalDate:off -- Public HTTP catalog boundary; no account credentials.
import * as Schema from "effect/Schema";
import type { WorkjetGatewayProvider } from "@workjet/contracts";

const Catalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  checkedAt: Schema.String,
  expiresAt: Schema.String,
  providers: Schema.Array(Schema.Struct({
    provider: Schema.String,
    status: Schema.Literals(["observed", "unavailable"]),
    models: Schema.Array(Schema.String),
  })),
});
const PROVIDERS: Readonly<Partial<Record<WorkjetGatewayProvider, string>>> = {
  codex: "openai", claude: "anthropic", kimi: "kimi", xai: "xai", zai: "zai", minimax: "minimax",
};

export function decodeLiveProviderModels(value: unknown, provider: WorkjetGatewayProvider, nowMs: number): ReadonlyArray<string> | undefined {
  try {
    const catalog = Schema.decodeUnknownSync(Catalog)(value);
    const checked = Date.parse(catalog.checkedAt);
    const expires = Date.parse(catalog.expiresAt);
    if (!Number.isFinite(checked) || !Number.isFinite(expires) ||
        checked > nowMs + 5_000 || checked < nowMs - 300_000 ||
        expires <= nowMs || expires > checked + 300_000 || catalog.providers.length > 32) return undefined;
    const entries = catalog.providers.filter(entry => entry.provider === PROVIDERS[provider]);
    if (entries.length !== 1 || entries[0]?.status !== "observed") return undefined;
    const models = entries[0].models;
    if (models.length > 1024 || models.some(id => !id || id.length > 160 ||
        id.trim() !== id || /[\x00-\x1f\x7f]/.test(id))) return undefined;
    return [...new Set(models)].sort();
  } catch { return undefined; }
}

export async function readPublicModelCatalog(request: typeof fetch = fetch): Promise<unknown> {
  const signal = AbortSignal.timeout(8_000);
  const response = await request("https://llm.ctox.dev/catalog", {
    headers: { Accept: "application/json", "User-Agent": "Workjet-Model-Catalog" },
    credentials: "omit", redirect: "error", signal,
  });
  const length = response.headers.get("content-length");
  if (!response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > 128 * 1024))) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("catalog-unavailable");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
