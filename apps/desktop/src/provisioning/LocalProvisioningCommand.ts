// @effect-diagnostics nodeBuiltinImport:off -- Explicit native installer process boundary.
// @effect-diagnostics globalTimers:off -- Timers supervise the owned child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** A deadline is a failure even when the child's termination handler exits successfully. */
export function runLocalCommand(
  command: string,
  args: readonly string[],
  input?: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const ownsProcessGroup = NodeProcess.platform !== "win32";
    const child = NodeChildProcess.spawn(command, [...args], {
      env: NodeProcess.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: ownsProcessGroup,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | undefined;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (signal: NodeJS.Signals) => {
      try {
        // Only address the process group created by this spawn, never a discovered PID.
        if (ownsProcessGroup && child.pid !== undefined) NodeProcess.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          failure = new Error("Could not stop the local provisioning command.");
      }
    };
    const terminate = () => {
      stop("SIGTERM");
      forceStop ??= setTimeout(() => stop("SIGKILL"), 1_000);
    };
    const timer = setTimeout(() => {
      failure = new Error(`Local provisioning command timed out after ${timeoutMs} ms.`);
      terminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {
      failure ??= new Error("Could not send input to the local provisioning command.");
      terminate();
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    // Waiting for close retains ownership until the child and its output pipes have closed.
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceStop);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`));
    });
    child.stdin.end(input);
  });
}
