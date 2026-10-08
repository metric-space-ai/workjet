// @effect-diagnostics globalFetch:off -- Fixed Anthropic metadata boundary; credentials never leave it.
import * as Schema from "effect/Schema";

const Models = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
  has_more: Schema.Boolean,
});
const decodeModels = Schema.decodeUnknownSync(Models);

/** Only a complete authenticated provider list may authorize a legacy ID repair. */
export async function discoverClaudeModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<string> | undefined> {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(8_000),
    ...(signal === undefined ? [] : [signal]),
  ]);
  let response: Response | undefined;
  try {
    response = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
      redirect: "error",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "Workjet-Model-Catalog",
      },
      signal: deadline,
    });
    const length = response.headers.get("content-length");
    if (!response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > 128 * 1024)))
      return undefined;
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
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
        if (size > 128 * 1024) return undefined;
        chunks.push(part.value);
      }
    } finally {
      deadline.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const models = decodeModels(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (models.has_more === true || models.data.length === 0 || models.data.length > 1024)
      return undefined;
    const ids = models.data.map(model => model.id);
    if (ids.some(id => !id || id.length > 160 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id)))
      return undefined;
    return [...new Set(ids)];
  } catch {
    // No response text, echoed credentials or transport errors cross this boundary.
    return undefined;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

/** Preserve unknown IDs for their real Hi error; repair spelling only with live evidence. */
export function repairClaudeModelIds(
  configured: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const known = new Set(available);
  return [...new Set(configured.map(id => {
    if (known.has(id) || !id.startsWith("claude-")) return id;
    const candidate = id.replace(/\.(?=\d)/g, "-");
    return known.has(candidate) ? candidate : id;
  }))];
}
