// @effect-diagnostics globalFetch:off -- Private, fixed-origin vendor model discovery.
import * as Schema from "effect/Schema";

export const API_KEY_MODEL_BASE_URLS = {
  minimax: "https://api.minimax.io/v1",
  xai: "https://api.x.ai/v1",
} as const;

export interface ApiKeyModelConnection {
  readonly upstreamBaseUrl: string;
  readonly models: ReadonlyArray<string>;
}

const Models = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
  has_more: Schema.optional(Schema.Boolean),
});
const decodeModels = Schema.decodeUnknownSync(Models);

/** Account metadata never authorizes an arbitrary destination for its credential. */
export async function discoverApiKeyModels(
  provider: keyof typeof API_KEY_MODEL_BASE_URLS,
  apiKey: string,
  preferredBaseUrl?: string,
  signal?: AbortSignal,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<ApiKeyModelConnection | undefined> {
  const upstreamBaseUrl = API_KEY_MODEL_BASE_URLS[provider];
  if (preferredBaseUrl !== undefined && preferredBaseUrl !== upstreamBaseUrl) return undefined;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(8_000),
    ...(signal === undefined ? [] : [signal]),
  ]);
  let response: Response | undefined;
  try {
    deadline.throwIfAborted();
    response = await request(`${upstreamBaseUrl}/models`, {
      redirect: "error",
      headers: { authorization: `Bearer ${apiKey}`, "User-Agent": "Workjet-Model-Catalog" },
      signal: deadline,
    });
    const length = response.headers.get("content-length");
    if (
      !response.ok ||
      !response.body ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > 64 * 1024))
    )
      return undefined;
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    deadline.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        deadline.throwIfAborted();
        const part = await reader.read();
        deadline.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024) return undefined;
        chunks.push(part.value);
      }
    } finally {
      deadline.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const list = decodeModels(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (list.has_more === true || list.data.length === 0 || list.data.length > 1024)
      return undefined;
    const models = list.data.map((entry) => entry.id);
    if (
      models.some((id) => !id || id.length > 160 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id))
    )
      return undefined;
    return { upstreamBaseUrl, models: [...new Set(models)] };
  } catch {
    // No provider body, echoed credential or transport error crosses this boundary.
    return undefined;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}
