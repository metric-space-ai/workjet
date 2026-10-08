// @effect-diagnostics globalFetch:off -- Vendor-only API-key discovery at the Node boundary.
export const KIMI_BASE_URLS = [
  "https://api.kimi.com/coding/v1",
  "https://api.moonshot.ai/v1",
] as const;

export interface KimiConnection {
  readonly upstreamBaseUrl: (typeof KIMI_BASE_URLS)[number];
  readonly models: ReadonlyArray<string>;
}

/** A live, authenticated list is the only evidence for both key origin and model IDs. */
export const discoverKimiConnection = async (
  apiKey: string,
  preferredBaseUrl?: string,
  signal?: AbortSignal,
): Promise<KimiConnection | undefined> => {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(8_000),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const results = await Promise.all(
    KIMI_BASE_URLS.map(async (upstreamBaseUrl): Promise<KimiConnection | undefined> => {
      let response: Response | undefined;
      try {
        response = await fetch(`${upstreamBaseUrl}/models`, {
          redirect: "error",
          headers: { authorization: `Bearer ${apiKey}`, "User-Agent": "Workjet" },
          signal: deadline,
        });
        if (!response.ok || response.body === null) return undefined;
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) > 64 * 1024) return undefined;
        const reader = response.body.getReader();
        let size = 0;
        const chunks: Array<Uint8Array> = [];
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 64 * 1024) return undefined;
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
        const data = (body as Record<string, unknown>).data;
        if (!Array.isArray(data) || data.length === 0 || data.length > 256) return undefined;
        const models: Array<string> = [];
        for (const model of data) {
          if (typeof model !== "object" || model === null || Array.isArray(model)) return undefined;
          const id: unknown = (model as Record<string, unknown>).id;
          if (
            typeof id !== "string" ||
            id.length === 0 ||
            id.length > 160 ||
            id.trim() !== id ||
            [...id].some((character) => {
              const code = character.codePointAt(0) ?? 0;
              return code < 0x20 || code === 0x7f;
            })
          )
            return undefined;
          models.push(id);
        }
        return { upstreamBaseUrl, models: [...new Set(models)] };
      } catch {
        // Provider bodies, echoed keys and fetch errors never leave this boundary.
        return undefined;
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
    }),
  );
  return (
    results.find((result) => result?.upstreamBaseUrl === preferredBaseUrl) ??
    results.find((result) => result !== undefined)
  );
};
