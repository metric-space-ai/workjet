// @effect-diagnostics globalFetch:off -- Bounded official Z.ai account-plan discovery.
export const ZAI_BASE_URLS = [
  "https://api.z.ai/api/coding/paas/v4",
  "https://api.z.ai/api/paas/v4",
] as const;

export interface ZaiConnection {
  readonly upstreamBaseUrl: (typeof ZAI_BASE_URLS)[number];
  readonly models: ReadonlyArray<string>;
  readonly probeModel: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (response.body === null || (length !== null && Number(length) > 64 * 1024))
    throw new Error("invalid response");
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) throw new Error("invalid response");
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
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function modelIds(body: unknown): ReadonlyArray<string> | undefined {
  const data = record(body)?.data;
  if (!Array.isArray(data) || data.length === 0 || data.length > 256) return undefined;
  const ids: Array<string> = [];
  for (const entry of data) {
    const id = record(entry)?.id;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 160 ||
      id.trim() !== id ||
      /[\x00-\x1f\x7f]/.test(id)
    )
      return undefined;
    ids.push(id);
  }
  return [...new Set(ids)];
}

/** Both plans can return the same model list. Only a bounded inference proves access. */
export async function discoverZaiConnection(
  apiKey: string,
  preferredModels: ReadonlyArray<string>,
  preferredBaseUrl?: string,
  signal?: AbortSignal,
): Promise<ZaiConnection | undefined> {
  if (
    preferredModels.length === 0 ||
    (preferredBaseUrl !== undefined && !ZAI_BASE_URLS.some((url) => url === preferredBaseUrl))
  )
    return undefined;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(16_000),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const urls = [...ZAI_BASE_URLS].sort((a, b) =>
    a === preferredBaseUrl ? -1 : b === preferredBaseUrl ? 1 : 0,
  );
  for (const upstreamBaseUrl of urls) {
    let response: Response | undefined;
    try {
      response = await fetch(`${upstreamBaseUrl}/models`, {
        redirect: "error",
        headers: { authorization: `Bearer ${apiKey}`, "User-Agent": "Workjet" },
        signal: deadline,
      });
      if (response.status === 401 || response.status === 403) continue;
      if (!response.ok) return undefined;
      const models = modelIds(await boundedJson(response));
      if (models === undefined) return undefined;
      const probeModel = preferredModels.find((id) => models.includes(id));
      if (probeModel === undefined) continue;
      response = await fetch(`${upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "User-Agent": "Workjet",
        },
        body: JSON.stringify({
          model: probeModel,
          messages: [
            { role: "system", content: "Reply with Hi only." },
            { role: "user", content: "Hi" },
          ],
          max_tokens: 8,
          stream: false,
        }),
        signal: deadline,
      });
      const body = record(await boundedJson(response));
      if (
        response.ok &&
        body?.error == null &&
        Array.isArray(body?.choices) &&
        body.choices.length > 0
      )
        return { upstreamBaseUrl, models, probeModel };
      const code = record(body?.error)?.code;
      // Do not fall back to a billed API when a Coding Plan hits its real quota.
      if (
        response.status === 401 ||
        response.status === 403 ||
        (upstreamBaseUrl === ZAI_BASE_URLS[1] && String(code) === "1113")
      )
        continue;
      return undefined;
    } catch {
      // Never expose echoed keys or upstream bodies, and never infer a plan from a transport error.
      return undefined;
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
  }
  return undefined;
}
