// @effect-diagnostics globalFetch:off -- Fixed Codex account metadata boundary.

const MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function accountIdFromIdToken(idToken: string): string | undefined {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts[1]!.length > 16 * 1024) return undefined;
  try {
    const payload = record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    const accountId = record(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof accountId === "string" &&
      accountId.length > 0 &&
      accountId.length <= 160 &&
      !/[\x00-\x1f\x7f]/.test(accountId)
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read the same authenticated Codex model endpoint as the native provider gateway. */
export async function discoverCodexModels(
  accessToken: string,
  idToken: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<string> | undefined> {
  const accountId = accountIdFromIdToken(idToken);
  if (accountId === undefined) return undefined;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(8_000),
    ...(signal === undefined ? [] : [signal]),
  ]);
  let response: Response | undefined;
  try {
    response = await fetch(MODELS_URL, {
      redirect: "error",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "Chatgpt-Account-Id": accountId,
        Originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.144.1",
        Accept: "application/json",
      },
      signal: deadline,
    });
    const declared = response.headers.get("content-length");
    if (
      !response.ok ||
      response.body === null ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 512 * 1024))
    )
      return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        deadline.throwIfAborted();
        const part = await reader.read();
        deadline.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 512 * 1024) return undefined;
        chunks.push(part.value);
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
    const models = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
      ?.models;
    if (!Array.isArray(models) || models.length === 0 || models.length > 512) return undefined;
    const ids = models.map((model) => record(model)?.slug);
    if (
      ids.some(
        (id) =>
          typeof id !== "string" ||
          id.length === 0 ||
          id.length > 160 ||
          id.trim() !== id ||
          /[\x00-\x1f\x7f]/.test(id),
      )
    )
      return undefined;
    return [...new Set(ids as string[])];
  } catch {
    return undefined;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}
