/** A technical handshake is hidden only when its complete, plain acknowledgement follows. */
export function isSessionInitializationPrompt(text: string): boolean {
  const value = text.trim().replace(/\s+/gu, " ");
  return (
    /^(?:nur (?:BEREIT|READY) antworten[.!]?|(?:antworte|antworten sie) (?:nur|ausschließlich) mit (?:BEREIT|READY)[.!]?|(?:reply|respond) (?:only|exclusively) (?:with )?(?:READY|BEREIT)[.!]?)$/iu.test(
      value,
    ) ||
    (/^(?:dies ist nur (?:die )?technische initialisierung|this is (?:only )?(?:a |the )?technical initialization)/iu.test(
      value,
    ) &&
      /(?:antworte ausschließlich mit BEREIT|respond only with READY)[.!]?$/iu.test(value))
  );
}

export function hideSessionInitialization<
  T extends {
    readonly role: string;
    readonly text: string;
    readonly attachments?: ReadonlyArray<unknown> | undefined;
  },
>(messages: ReadonlyArray<T>): ReadonlyArray<T> {
  let offset = 0;
  while (offset + 1 < messages.length) {
    const request = messages[offset]!;
    const reply = messages[offset + 1]!;
    if (
      request.role !== "user" ||
      reply.role !== "assistant" ||
      request.attachments?.length ||
      reply.attachments?.length ||
      !(
        isSessionInitializationPrompt(request.text) ||
        /^(?:hi|hello|hallo|BEREIT|READY)[.!]?$/iu.test(request.text.trim())
      ) ||
      !/^(?:BEREIT|READY|hi|hello|hallo)[.!]?$/iu.test(reply.text.trim())
    )
      break;
    offset += 2;
  }
  return offset === 0 ? messages : messages.slice(offset);
}
