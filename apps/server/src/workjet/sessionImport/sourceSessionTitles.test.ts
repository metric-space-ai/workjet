// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { readCodexSessionTitles } from "./sourceSessionTitles.ts";

describe("Codex source titles", () => {
  it("prefers the desktop name to the initialization prompt and never changes the source", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-titles-"));
    try {
      const source = NodePath.join(root, "state_5.sqlite");
      const db = new NodeSqlite.DatabaseSync(source);
      db.exec("CREATE TABLE threads (id TEXT, title TEXT, name TEXT)");
      db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(
        "crew",
        "Nur BEREIT antworten",
        "CTOX Crew",
      );
      db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("indexed", "hi", null);
      db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(
        "unnamed",
        "Nur BEREIT antworten",
        null,
      );
      db.close();
      await NodeFSP.writeFile(
        NodePath.join(root, "session_index.jsonl"),
        '{"id":"indexed","thread_name":"Import fixes"}\n{"partial":',
      );
      const before = await NodeFSP.readFile(source);
      const titles = await readCodexSessionTitles(root);
      expect(titles.get("crew")).toBe("CTOX Crew");
      expect(titles.get("indexed")).toBe("Import fixes");
      expect(titles.has("unnamed")).toBe(false);
      expect(await NodeFSP.readFile(source)).toEqual(before);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps index metadata usable when a database is unavailable", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-titles-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(root, "session_index.jsonl"),
        '{"id":"crew","thread_name":"CTOX Crew"}\n',
      );
      await NodeFSP.writeFile(NodePath.join(root, "state_5.sqlite"), "invalid database");
      expect((await readCodexSessionTitles(root)).get("crew")).toBe("CTOX Crew");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
