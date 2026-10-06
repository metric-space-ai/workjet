import { describe, expect, it } from "@effect/vitest";
import { projectTranscriptRecords, TranscriptRecordProjector } from "./transcriptRecords.ts";

describe("bounded transcript projection", () => {
  it("does not retain tool-block arrays or spend the visible text budget on them", () => {
    const parser = new TranscriptRecordProjector();
    const records = [...parser.push('{"type":"assistant","message":{"role":"assistant","content":[')];
    for (let index = 0; index < 120000; index += 1) records.push(...parser.push('{"type":"tool_result","content":"ignored"},'));
    records.push(...parser.push('{"type":"text","text":"Visible answer after the tool blocks"}]}}\n'));
    expect(records).toHaveLength(1);
    expect(records[0]!.length).toBeLessThan(200);
    expect(JSON.parse(records[0]!).message.content).toEqual([{ type: "text", text: "Visible answer after the tool blocks" }]);
  });
  it("rejects trailing commas and missing values rather than importing partial records", () => {
    for (const malformed of ['{"type":"session_meta",}', '{"type":"session_meta","payload":}', '{"type":"user","message":{"role":"user","content":["text",]}}']) {
      const parser = new TranscriptRecordProjector();
      expect([...parser.push(malformed + "\n")]).toEqual([]);
    }
  });

  it("preserves escaped visible text across arbitrary chunk boundaries", () => {
    const value = { type: "response_item", timestamp: "2026-10-06", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: 'Keep \\"quotes\\"\nü 😀 and \\ paths' }],
    } };
    const input = JSON.stringify(value) + "\n";
    for (const size of [1, 2, 7, 64]) {
      const parser = new TranscriptRecordProjector();
      const records: string[] = [];
      for (let start = 0; start < input.length; start += size) records.push(...parser.push(input.slice(start, start + size)));
      expect(records.map((line) => JSON.parse(line))).toEqual([value]);
    }
  });

  it("discards a 32-MiB tool string and retains the following visible message", async () => {
    const chunks = async function* () {
      yield '{"type":"response_item","payload":{"type":"function_call_output","output":"';
      for (let index = 0; index < 512; index += 1) yield "x".repeat(64 * 1024);
      yield '"}}\n';
      yield '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Actual answer"}]}}\n';
    };
    const lines: string[] = [];
    for await (const line of projectTranscriptRecords(chunks())) lines.push(line);
    expect(lines[0]).toBe('{"type":"response_item","payload":{"type":"function_call_output"}}');
    expect(JSON.parse(lines[1]!)).toMatchObject({ payload: { content: [{ text: "Actual answer" }] } });
    expect(lines.join("").length).toBeLessThan(500);
  });

  it("drops nested Claude tool results and retains text in the same record", () => {
    const parser = new TranscriptRecordProjector();
    const input = { type: "user", cwd: "/workspace", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool", content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }] },
      { type: "text", text: "A real follow-up" },
    ] } };
    const lines = [...parser.push(JSON.stringify(input) + "\n")];
    expect(lines[0]).not.toContain("PRIVATE TOOL OUTPUT");
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: { content: [{ type: "text", text: "A real follow-up" }] } });
  });

  it("recovers after a partial append and keeps a final record without a newline", () => {
    const parser = new TranscriptRecordProjector();
    expect([...parser.push('{"type":"broken"\n{"type":"session_meta","payload":{"cwd":"/safe"}}')]).toEqual([]);
    expect(JSON.parse(parser.finish()!)).toEqual({ type: "session_meta", payload: { cwd: "/safe" } });
  });
});
