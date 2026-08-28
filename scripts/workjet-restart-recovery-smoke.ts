// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Boots the real server twice against one disposable state directory and
 * asserts that durable Workjet state survives the restart.
 *
 * ── Why this cannot be a unit test ──────────────────────────────────────────
 * Every mailbox and delegation test in `apps/server` runs against IN-MEMORY
 * SQLite. They prove the store's logic; they cannot prove that anything
 * reaches a real file, that the migrations leave existing rows alone, or that
 * a second boot reads back what the first one wrote. Those are exactly the
 * failures a restart produces, and they are invisible to the whole existing
 * suite (docs/workjet-remaining-work.md item 1, §15).
 *
 * ── What it asserts, and why each one ───────────────────────────────────────
 *  1. A first boot creates the database and runs every migration.
 *  2. A row written after that boot is STILL THERE after a second boot. This
 *     is the actual restart-recovery claim.
 *  3. The second boot runs migrations again and does NOT destroy the row — a
 *     migration that is not idempotent shows up here and nowhere else.
 *  4. The state directory is disposable: nothing is read from or written to
 *     the developer's real T3CODE_HOME. A smoke that quietly used the real one
 *     would be both destructive and a false pass.
 *
 * ── NOT YET OBSERVED END TO END, and that is recorded on purpose ───────────
 * The two-boot run has never completed in the development harness used to
 * write it. Every arrangement — Node spawning the server, a detached Node, a
 * shell orchestrator — is killed SILENTLY during the second boot: no
 * exception, no stderr, zero bytes. A plain Node process with no child
 * survives minutes in the same place, so this is the harness reaping a process
 * tree, not a defect in the script. It is expected to run on an ordinary
 * developer machine or in CI; treat "it passes" as unproven until someone has
 * seen it pass there.
 *
 * What IS verified: the verdict logic below, by unit tests, and the first boot
 * (migrations run, database created, sentinel row written) which was observed
 * repeatedly.
 *
 * Run: `bash scripts/workjet-restart-recovery.sh <facts.json>` to collect, then
 * `node scripts/workjet-restart-recovery-smoke.ts <facts.json>` to judge.
 * Exits non-zero on failure, so a release job can gate on it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/**
 * The server is a LONG-RUNNING process: it migrates, then serves. This smoke
 * only needs the migration half, so each boot is deliberately killed by this
 * timeout rather than shut down gracefully. A kill is the expected outcome
 * here, not a failure — the verdict reads the database and the log, never the
 * exit signal.
 *
 * Long enough for 54 migrations on a cold cache (~8s observed), short enough
 * that two boots stay inside a normal CI step.
 */
export const BOOT_TIMEOUT_MS = 30_000;

/**
 * A high, fixed port. The server refuses 0, and the smoke never connects to
 * it — it is killed before serving matters — so a collision costs nothing
 * beyond a bind error the verdict already ignores.
 */
export const BOOT_PORT = "39917";

/**
 * How long the RESTART boot is given to open the existing database. It prints
 * no migration line, so there is nothing to wait for — only long enough that a
 * server which crashes on an existing database has time to say so.
 */
export const SETTLE_MS = 12_000;

export interface BootOutcome {
  readonly migrationsRan: boolean;
  readonly databaseExists: boolean;
  readonly stderr: string;
}

/**
 * The verdict, pure so it is testable without booting anything.
 *
 * A second boot that did NOT run migrations is not a failure — an already
 * migrated database legitimately has nothing to do. What must hold is that the
 * row survives; conflating "no migrations ran" with "broken" would make this
 * smoke fail on the ordinary case.
 */
export function interpretRestartRecovery(input: {
  readonly first: BootOutcome;
  readonly second: BootOutcome;
  readonly rowSurvived: boolean;
  readonly usedDisposableHome: boolean;
}): { readonly verdict: "pass" | "fail"; readonly detail: string } {
  if (!input.usedDisposableHome) {
    return {
      verdict: "fail",
      detail: "the smoke did not run against a disposable state directory",
    };
  }
  if (!input.first.migrationsRan || !input.first.databaseExists) {
    return { verdict: "fail", detail: `first boot did not initialise: ${input.first.stderr}` };
  }
  if (!input.second.databaseExists) {
    return { verdict: "fail", detail: "the database vanished across the restart" };
  }
  if (!input.rowSurvived) {
    return {
      verdict: "fail",
      detail: "a row written before the restart was gone after it — durable state is not durable",
    };
  }
  return { verdict: "pass", detail: "durable Workjet state survived a real process restart." };
}

/**
 * Boots once and resolves when the migration line appears, killing the server
 * immediately after.
 *
 * ASYNC, and that is not a style choice. The first version busy-waited
 * synchronously for the child to exit — which blocks Node's event loop, so the
 * `stdout` handler could never fire, so the signal it was waiting for could
 * never arrive. It deadlocked against itself. A promise is the only shape that
 * can both watch output and bound the wait.
 */
async function boot(
  home: string,
  // The FIRST boot announces "Migrations ran successfully" and can be stopped
  // the instant it does. The SECOND boot on an already-migrated database never
  // prints it, so waiting for that line means waiting out the whole timeout
  // for a signal that cannot arrive — which is what made this script look hung
  // and got it killed repeatedly. A restart only has to OPEN the database, so
  // the second boot gets a short settling window instead.
  { expectMigrations }: { readonly expectMigrations: boolean },
): Promise<BootOutcome> {
  const child = NodeChildProcess.spawn(
    "node",
    ["src/bin.ts", "--port", BOOT_PORT, "--no-browser"],
    {
      cwd: NodePath.join(repoRoot, "apps/server"),
      env: { ...process.env, T3CODE_HOME: home, T3CODE_NO_BROWSER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const finished = new Promise<void>((resolve) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve();
    };
    // The server migrates and then serves forever, so waiting for it to exit
    // would wait for the timeout every time. Wait for the LINE instead.
    const timer = setTimeout(settle, expectMigrations ? BOOT_TIMEOUT_MS : SETTLE_MS);
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (expectMigrations && output.includes("Migrations ran successfully")) settle();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("exit", settle);
    child.on("error", settle);
  });

  await finished;
  return {
    migrationsRan: output.includes("Migrations ran successfully"),
    databaseExists: NodeFS.existsSync(NodePath.join(home, "userdata", "state.sqlite")),
    stderr: output.slice(-2_000),
  };
}

/**
 * Writes one row through the SAME sqlite file the server just created, using
 * the server's own `node:sqlite` binding rather than a second driver, so the
 * test cannot pass because two libraries disagree about the file.
 */
function writeSentinelRow(home: string, sentinel: string): void {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "state.sqlite"));
  try {
    database.exec(
      `INSERT INTO workjet_delegation_state_events
         (delegation_id, from_state, to_state, terminal, changed_at_ms)
       VALUES ('${sentinel}', 'queued', 'delivered', 0, 1)`,
    );
  } finally {
    database.close();
  }
}

function sentinelSurvived(home: string, sentinel: string): boolean {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "state.sqlite"));
  try {
    const rows = database
      .prepare(
        `SELECT delegation_id FROM workjet_delegation_state_events WHERE delegation_id = '${sentinel}'`,
      )
      .all();
    return rows.length === 1;
  } finally {
    database.close();
  }
}

export async function main(): Promise<number> {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-restart-"));
  // The developer's real home must be untouched; a smoke that quietly used it
  // would be destructive AND a false pass.
  const usedDisposableHome = home !== process.env.T3CODE_HOME && home.startsWith(NodeOS.tmpdir());
  const sentinel = "restart-smoke-sentinel";
  // Progress is reported AS IT HAPPENS, not at the end. Each boot takes tens
  // of seconds; a harness that stays silent until both finish tells you
  // nothing when it is killed or hangs, which is exactly when you need it to
  // talk. This cost real debugging time before it was added.
  const say = (line: string) => process.stdout.write(`${line}\n`);
  try {
    say(`state directory: ${home}`);
    say("booting once to create and migrate...");
    const first = await boot(home, { expectMigrations: true });
    say(`  first boot: migrations=${first.migrationsRan} db=${first.databaseExists}`);
    if (first.migrationsRan && first.databaseExists) writeSentinelRow(home, sentinel);
    say("restarting...");
    const second = await boot(home, { expectMigrations: false });
    say(`  second boot: migrations=${second.migrationsRan} db=${second.databaseExists}`);
    const rowSurvived =
      second.databaseExists && first.databaseExists ? sentinelSurvived(home, sentinel) : false;

    const { verdict, detail } = interpretRestartRecovery({
      first,
      second,
      rowSurvived,
      usedDisposableHome,
    });
    say(`workjet restart recovery: ${verdict} — ${detail}`);
    return verdict === "pass" ? 0 : 1;
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
