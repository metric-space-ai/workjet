import { describe, expect, it } from "@effect/vitest";

import {
  parseClaudeSessionTranscript,
  parseCodexSessionTranscript,
} from "./WorkjetSessionImport.ts";

const NOW = "2026-08-25T12:00:00.000Z";

describe("static Workjet session transcript parsing", () => {
  it("copies only visible Codex user and assistant text", () => {
    const parsed = parseCodexSessionTranscript(
      [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/repo", timestamp: NOW } }),
        JSON.stringify({
          type: "response_item",
          timestamp: NOW,
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "hidden" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: NOW,
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Build this" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: NOW,
          payload: { type: "function_call", arguments: "secret" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: NOW,
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        }),
      ],
      NOW,
    );

    expect(parsed?.workspaceRoot).toBe("/tmp/repo");
    expect(parsed?.messages).toEqual([
      { role: "user", text: "Build this", createdAt: NOW },
      { role: "assistant", text: "Done", createdAt: NOW },
    ]);
  });

  it("rejects Codex subagent transcripts instead of mixing worker history", () => {
    expect(
      parseCodexSessionTranscript(
        [
          JSON.stringify({
            type: "session_meta",
            payload: { cwd: "/tmp/repo", agent_path: "worker" },
          }),
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it("drops injected Codex context and internal health probes", () => {
    expect(
      parseCodexSessionTranscript(
        [
          JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/repo" } }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "<recommended_plugins>hidden</recommended_plugins>\n# AGENTS.md instructions",
                },
              ],
            },
          }),
        ],
        NOW,
      ),
    ).toBeNull();
    expect(
      parseClaudeSessionTranscript(
        [
          JSON.stringify({
            type: "user",
            cwd: "/tmp/repo",
            message: { role: "user", content: "WORKJET HEALTH PROBE V1. hi" },
          }),
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it("copies Claude text blocks but excludes tools and sidechains", () => {
    const parsed = parseClaudeSessionTranscript(
      [
        JSON.stringify({
          type: "user",
          cwd: "/tmp/repo",
          timestamp: NOW,
          message: {
            role: "user",
            content: [
              { type: "text", text: "Review this" },
              { type: "tool_result", content: "hidden" },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          cwd: "/tmp/repo",
          timestamp: NOW,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "Reviewed" },
            ],
          },
        }),
      ],
      NOW,
    );
    expect(parsed?.messages.map(({ text }) => text)).toEqual(["Review this", "Reviewed"]);

    expect(
      parseClaudeSessionTranscript(
        [
          JSON.stringify({
            type: "user",
            cwd: "/tmp/repo",
            isSidechain: true,
            message: { role: "user", content: "hidden" },
          }),
        ],
        NOW,
      ),
    ).toBeNull();
  });
});
