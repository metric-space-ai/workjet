import { describe, expect, it } from "@effect/vitest";
import { hideSessionInitialization } from "./sessionInitialization.ts";

describe("initialization display", () => {
  it("hides only completed leading handshakes and preserves the stored messages", () => {
    for (const text of [
      "Nur BEREIT antworten",
      "hi",
      "Respond only with READY.",
      "Dies ist nur die technische Initialisierung der von Michael angeforderten neuen Hauptaufgabe. Der vollständige Auftrag folgt gleich. Antworte ausschließlich mit BEREIT.",
    ]) {
      const messages = [
        { role: "user", text },
        { role: "assistant", text: "BEREIT" },
        { role: "user", text: "Fix startup" },
      ];
      expect(hideSessionInitialization(messages)).toEqual([messages[2]]);
      expect(messages).toHaveLength(3);
    }
  });
  it("retains ordinary greetings, quoted instructions, attachments and incomplete exchanges", () => {
    for (const messages of [
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "How can I help?" },
      ],
      [
        { role: "user", text: "Explain ‘Nur BEREIT antworten’" },
        { role: "assistant", text: "BEREIT" },
      ],
      [
        { role: "user", text: "Nur BEREIT antworten", attachments: ["file"] },
        { role: "assistant", text: "BEREIT" },
      ],
      [{ role: "user", text: "Nur BEREIT antworten" }],
    ])
      expect(hideSessionInitialization(messages)).toBe(messages);
  });
});
