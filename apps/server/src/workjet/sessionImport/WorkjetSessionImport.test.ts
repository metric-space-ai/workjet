import { describe, expect, it } from "@effect/vitest";

import {
  parseClaudeSessionTranscript,
  parseCodexSessionTranscript,
} from "./WorkjetSessionImport.ts";

const NOW = "2026-08-25T12:00:00.000Z";

describe("static Workjet session transcript parsing", () => {
  it("retains source identities and repository metadata while omitting hidden analysis", () => {
    const message = (channel: string, text: string) =>
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: channel === "input" ? "user" : "assistant",
          channel,
          content: [{ type: channel === "input" ? "input_text" : "output_text", text }],
        },
      });
    const parsed = parseCodexSessionTranscript(
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "actual-source-id",
            cwd: "/work/source",
            git: { repository_url: "git@github.com:example/repo.git" },
          },
        }),
        message("input", "Work on the actual feature"),
        message("analysis", "Hidden reasoning"),
        message("final", "Visible answer"),
      ],
      NOW,
    );
    expect(parsed?.sourceThreadId).toBe("actual-source-id");
    expect(parsed?.repositoryUrl).toBe("git@github.com:example/repo.git");
    expect(parsed?.messages.map((message) => message.text)).toEqual([
      "Work on the actual feature",
      "Visible answer",
    ]);
    expect(
      parseClaudeSessionTranscript(
        [
          JSON.stringify({
            type: "user",
            sessionId: "actual-claude-id",
            message: { role: "user", content: "Real request" },
          }),
        ],
        NOW,
      )?.sourceThreadId,
    ).toBe("actual-claude-id");
  });

  describe("source session names and initialization", () => {
    it("uses the real Codex thread name without changing the imported prefix", () => {
      const message = (role: string, text: string) =>
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role,
            content: [{ type: role === "user" ? "input_text" : "output_text", text }],
          },
        });
      const lines = [
        JSON.stringify({ type: "session_meta", payload: { id: "crew", cwd: "/workspace" } }),
        message("user", "Nur BEREIT antworten"),
        message("assistant", "BEREIT"),
        message("user", "Repair synchronization"),
      ];
      const named = parseCodexSessionTranscript(lines, NOW, new Map([["crew", "CTOX Crew"]]));
      expect(named?.title).toBe("CTOX Crew");
      expect(named?.messages.map((message) => message.text)).toEqual([
        "Nur BEREIT antworten",
        "BEREIT",
        "Repair synchronization",
      ]);
      expect(parseCodexSessionTranscript(lines, NOW)?.title).toBe("Repair synchronization");
    });
    it("recognizes an explicit Claude custom title", () => {
      expect(
        parseClaudeSessionTranscript(
          [
            JSON.stringify({ type: "custom-title", customTitle: "CTOX Supervisor" }),
            JSON.stringify({ type: "ai-title", aiTitle: "Automatic later title" }),
            JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
          ],
          NOW,
        )?.title,
      ).toBe("CTOX Supervisor");
    });
  });
  it("retains ordinary requests that discuss Codex context markers", () => {
    for (const request of [
      "Explain how <recommended_plugins> is handled.",
      "Review # AGENTS.md instructions in the attached document.",
      "Describe the <permissions instructions> marker in a transcript.",
      "Keep a request that quotes <environment_context>.",
      "<recommended_plugins> wird hier wörtlich besprochen. Bitte erklären.",
      "# AGENTS.md instructions sollen als normale Anfrage erhalten bleiben.",
      "<permissions instructions> ist ein Marker, den ich ändern möchte.",
      "<environment_context> ist in meinem Prompt falsch. Bitte korrigieren.",
    ]) {
      const parsed = parseCodexSessionTranscript(
        [
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: request }],
            },
          }),
        ],
        NOW,
      );
      expect(parsed?.title).toBe(request);
      expect(parsed?.messages).toEqual([{ role: "user", text: request, createdAt: NOW }]);
    }
  });

  it("still excludes generated context prefixes with leading whitespace", () => {
    for (const context of [
      "<recommended_plugins>hidden</recommended_plugins>",
      "# AGENTS.md instructions for /workspace",
      "<permissions instructions>hidden</permissions instructions>",
      "<environment_context>hidden</environment_context>",
    ]) {
      expect(
        parseCodexSessionTranscript(
          [
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "\n  " + context }],
              },
            }),
          ],
          NOW,
        ),
      ).toBeNull();
    }
  });

  it("retains requests following generated context in the same user message", () => {
    const request = "Fix the source parser without losing the conversation.";
    for (const prefix of [
      "<environment_context>cwd=/workspace</environment_context>\n",
      "<recommended_plugins>hidden</recommended_plugins>\n<permissions instructions>hidden</permissions instructions>\n",
      "# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>hidden</INSTRUCTIONS>\n<environment_context>cwd=/workspace</environment_context>\n",
    ]) {
      const parsed = parseCodexSessionTranscript(
        [
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: prefix + request }],
            },
          }),
        ],
        NOW,
      );
      expect(parsed?.title).toBe(request);
      expect(parsed?.messages).toEqual([{ role: "user", text: request, createdAt: NOW }]);
    }
  });

  it("retains readable histories without a recorded source folder", () => {
    const codex = parseCodexSessionTranscript(
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Keep this Codex conversation" }],
          },
        }),
      ],
      NOW,
    );
    const claude = parseClaudeSessionTranscript(
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Keep this Claude conversation" },
        }),
      ],
      NOW,
    );
    expect(codex).toMatchObject({
      workspaceRoot: null,
      title: "Keep this Codex conversation",
      messages: [{ role: "user", text: "Keep this Codex conversation" }],
    });
    expect(claude).toMatchObject({
      workspaceRoot: null,
      title: "Keep this Claude conversation",
      messages: [{ role: "user", text: "Keep this Claude conversation" }],
    });
  });

  it("retains the latest Codex model and ignores synthetic Claude model markers", () => {
    const user = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Historical request" }],
      },
    });
    const meta = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/workspace", model: "gpt-4.1" },
    });
    expect(
      parseCodexSessionTranscript(
        [meta, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4" } }), user],
        NOW,
      )?.model,
    ).toBe("gpt-5.4");
    expect(
      parseCodexSessionTranscript(
        [JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace" } }), user],
        NOW,
      )?.model,
    ).toBeNull();
    const claudeUser = JSON.stringify({
      type: "user",
      cwd: "/workspace",
      message: { role: "user", content: "Historical request" },
    });
    const synthetic = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Local notice" }],
      },
    });
    expect(
      parseClaudeSessionTranscript(
        [
          claudeUser,
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              model: "claude-sonnet-4-20250514",
              content: [{ type: "text", text: "Historical reply" }],
            },
          }),
          synthetic,
        ],
        NOW,
      )?.model,
    ).toBe("claude-sonnet-4-20250514");
    expect(parseClaudeSessionTranscript([claudeUser, synthetic], NOW)?.model).toBeNull();
  });
  it("uses the actual request after Codex Page context and preserves text in a mixed message", () => {
    const parsed = parseCodexSessionTranscript(
      [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
              },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>\nImprove the importer',
              },
            ],
          },
        }),
      ],
      NOW,
    );
    expect(parsed?.title).toBe("Improve the importer");
    expect(parsed?.messages).toEqual([
      { role: "user", text: "Improve the importer", createdAt: NOW },
    ]);
  });
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

  it("handles reordered Codex context without losing the following request", () => {
    const request = "Import this actual request";
    const instructions =
      "# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>hidden</INSTRUCTIONS>\n";
    const plugins = "<recommended_plugins>hidden</recommended_plugins>\n";
    const environment = "<environment_context>hidden</environment_context>\n";
    const literal = "# AGENTS.md instructions for /workspace\nDiscuss this literal heading";
    const cases = [
      [plugins + instructions + environment + request, request],
      [environment + instructions + plugins + request, request],
      [plugins + literal, literal],
    ] as const;
    for (const [text, expected] of cases) {
      const parsed = parseCodexSessionTranscript(
        [
          JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace" } }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            },
          }),
        ],
        NOW,
      );
      expect(parsed?.messages).toEqual([{ role: "user", text: expected, createdAt: NOW }]);
      expect(parsed?.title).toBe(expected.replace(/\s+/gu, " "));
    }
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
