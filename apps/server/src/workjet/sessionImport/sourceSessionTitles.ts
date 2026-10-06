// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSQLite from "node:sqlite";
import { isSessionInitializationPrompt } from "@workjet/contracts";

const cleanTitle = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.replace(/\s+/gu, " ").trim().slice(0, 120)
    : undefined;

/** Read source metadata, never write to the provider's database or transcript. */
export async function readCodexSessionTitles(home: string): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  try {
    const index = NodePath.join(home, "session_index.jsonl");
    if ((await NodeFSP.stat(index)).size <= 8 * 1024 * 1024) {
      for (const line of (await NodeFSP.readFile(index, "utf8")).split(/\r?\n/u)) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const title = cleanTitle(entry.thread_name);
          if (typeof entry.id === "string" && title) titles.set(entry.id, title);
        } catch {
          /* A partial last append does not invalidate earlier metadata. */
        }
      }
    }
  } catch {
    /* Older installations need not have a session index. */
  }
  try {
    const entries = await NodeFSP.readdir(home, { withFileTypes: true });
    const databases = entries
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/u.test(entry.name))
      .sort((a, b) => Number(a.name.match(/\d+/u)?.[0]) - Number(b.name.match(/\d+/u)?.[0]));
    for (const entry of databases) {
      let database: NodeSQLite.DatabaseSync | undefined;
      try {
        database = new NodeSQLite.DatabaseSync(NodePath.join(home, entry.name), { readOnly: true });
        const columns = database.prepare("PRAGMA table_info(threads)").all();
        if (
          !columns.some((column) => column.name === "id") ||
          !columns.some((column) => column.name === "title")
        )
          continue;
        const hasName = columns.some((column) => column.name === "name");
        const rows = database
          .prepare(`SELECT id, title${hasName ? ", name" : ""} FROM threads LIMIT 50000`)
          .all();
        for (const row of rows) {
          const named = cleanTitle(row.name);
          const firstPrompt = typeof row.title === "string" ? row.title : "";
          const initTitle =
            isSessionInitializationPrompt(firstPrompt) ||
            /^(?:hi|hello|hallo|ready|bereit)[.!]?$/iu.test(firstPrompt.trim());
          const title =
            named ?? titles.get(String(row.id)) ?? (initTitle ? undefined : cleanTitle(row.title));
          if (typeof row.id === "string" && title) titles.set(row.id, title);
        }
      } catch {
        /* Locked, older or absent metadata must not prevent history import. */
      } finally {
        database?.close();
      }
    }
  } catch {
    /* Transcript titles remain a safe fallback. */
  }
  return titles;
}
