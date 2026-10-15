import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AddMachineEnrollment } from "./AddMachineEnrollment";
import {
  MACHINE_ENROLLMENT_STEP_KEYS,
  machineCandidateAddress,
  machineEnrollmentError,
  machineEnrollmentProgress,
  machineEnrollmentStepLabel,
  startMachineEnrollment,
  type MachineEnrollmentSnapshot,
  type MachineEnrollmentStep,
} from "./machineEnrollment";
import {
  createFixtureMachineEnrollment,
  FIXTURE_MACHINE_CANDIDATES,
} from "./machineEnrollmentFixture";

const done = (key: MachineEnrollmentStep["key"], at = 1): MachineEnrollmentStep => ({
  key,
  state: "done",
  at_ms: at,
});

/** Manueller Takt statt Timer: jeder Aufruf von `tick` läuft alle fälligen Schritte. */
function manualClock() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => void queue.push(fn),
    flush: () => {
      for (let guard = 0; queue.length > 0 && guard < 100; guard += 1) queue.shift()!();
    },
  };
}

describe("Fortschritt aus steps (sync v4 §16.41)", () => {
  it("has the eight contract keys in order", () => {
    expect(MACHINE_ENROLLMENT_STEP_KEYS).toEqual([
      "token_issued",
      "transport_connected",
      "package_copied",
      "installed",
      "service_started",
      "device_bound",
      "peer_connected",
      "green",
    ]);
  });

  it("walks the bar and names the current step", () => {
    expect(machineEnrollmentProgress([])).toMatchObject({
      index: 0,
      fraction: 0,
      status: "running",
    });
    const half = machineEnrollmentProgress([
      done("token_issued"),
      done("transport_connected"),
      done("package_copied"),
      { key: "installed", state: "running", at_ms: 2 },
    ]);
    expect(half).toMatchObject({ key: "installed", status: "running" });
    expect(half.fraction).toBeCloseTo(3.5 / 8);
    expect(machineEnrollmentStepLabel(half.key)).toBe("Installieren");
  });

  it("is green only when the green step is done", () => {
    const steps = MACHINE_ENROLLMENT_STEP_KEYS.map((key) => done(key));
    expect(machineEnrollmentProgress(steps)).toMatchObject({ status: "green", fraction: 1 });
  });

  it("reports the failed step; the latest report of a key wins", () => {
    const progress = machineEnrollmentProgress([
      done("token_issued"),
      { key: "transport_connected", state: "running", at_ms: 1 },
      {
        key: "transport_connected",
        state: "failed",
        at_ms: 2,
        error_code: "auth_rejected",
        detail: "Permission denied (publickey).",
      },
    ]);
    expect(progress).toMatchObject({ status: "failed", key: "transport_connected" });
    expect(progress.failed?.error_code).toBe("auth_rejected");
  });
});

describe("Fehlerzeilen", () => {
  it("are German, at most 12 words, with exactly one action", () => {
    for (const code of [
      "auth_rejected",
      "user_missing",
      "unreachable",
      "host_key_changed",
      "copy_failed",
      "install_failed",
      "disk_full",
      "token_expired",
      "service_failed",
      "bind_rejected",
      "peer_timeout",
      "something_new",
      undefined,
    ]) {
      const line = machineEnrollmentError(code);
      expect(`${line.text} ${line.actionLabel}`.split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(line.text).not.toMatch(/denied|error|failed/i);
    }
    expect(machineEnrollmentError("auth_rejected")).toMatchObject({
      text: "Anmeldung abgelehnt",
      action: "user",
      actionLabel: "Benutzer prüfen",
    });
    expect(machineEnrollmentError("unreachable")).toMatchObject({
      text: "Rechner nicht erreichbar",
      actionLabel: "Erneut versuchen",
    });
  });
});

describe("Quellenliste", () => {
  it("shows user@host and never invents a user", () => {
    const byName = Object.fromEntries(
      FIXTURE_MACHINE_CANDIDATES.map((entry) => [entry.name, entry]),
    );
    expect(machineCandidateAddress(byName["ts-gpu1"]!)).toBe("deck@100.87.204.48");
    expect(machineCandidateAddress(byName["skf-vm"]!)).toBe("ctox@10.20.0.4:2222");
    expect(machineCandidateAddress(byName["nas-asustor"]!)).toBe("—@100.64.0.28");
    expect(machineCandidateAddress(byName["MacBook Pro"]!)).toBeNull();
  });
});

describe("Ein Klick gegen die Attrappe", () => {
  it("runs begin → transport steps → machine steps → green", async () => {
    const clock = manualClock();
    const { source, transport } = createFixtureMachineEnrollment({
      schedule: clock.schedule,
      capabilities: { "ts-gpu1": { build: true, storage: true, gpu: "RTX A6000 · 48 GB" } },
    });
    const candidate = FIXTURE_MACHINE_CANDIDATES.find((entry) => entry.name === "ts-gpu1")!;
    const id = await startMachineEnrollment(source, transport, candidate, candidate.name);
    const seen: MachineEnrollmentSnapshot[] = [];
    source.watch(id, (snapshot) => seen.push(snapshot));
    clock.flush();
    await Promise.resolve();
    clock.flush();
    const last = seen.at(-1)!;
    expect(machineEnrollmentProgress(last.steps).status).toBe("green");
    expect(last.capabilities?.gpu).toBe("RTX A6000 · 48 GB");
    expect(new Set(last.steps.map((step) => step.key))).toEqual(
      new Set(MACHINE_ENROLLMENT_STEP_KEYS),
    );
  });

  it("stops at the failing step with an error code", async () => {
    const clock = manualClock();
    const { source, transport } = createFixtureMachineEnrollment({
      schedule: clock.schedule,
      failures: {
        "skf-vm": { key: "transport_connected", error_code: "auth_rejected", detail: "denied" },
      },
    });
    const candidate = FIXTURE_MACHINE_CANDIDATES.find((entry) => entry.name === "skf-vm")!;
    const id = await startMachineEnrollment(source, transport, candidate, candidate.name);
    let latest: MachineEnrollmentSnapshot = { steps: [] };
    source.watch(id, (snapshot) => (latest = snapshot));
    clock.flush();
    expect(machineEnrollmentProgress(latest.steps)).toMatchObject({
      status: "failed",
      key: "transport_connected",
    });
  });
});

describe("AddMachineEnrollment", () => {
  it("renders the trigger as a button and no form fields", () => {
    const { source, transport } = createFixtureMachineEnrollment();
    const closed = renderToStaticMarkup(
      <AddMachineEnrollment source={source} transport={transport} />,
    );
    expect(closed).toContain("Rechner hinzufügen");
    expect(closed).not.toContain("<input");
    const open = renderToStaticMarkup(
      <AddMachineEnrollment source={source} transport={transport} defaultOpen />,
    );
    expect(open).toContain('data-slot="machine-sources"');
    expect(open).toContain("Hinzufügen");
    expect(open).not.toContain("Zuklappen");
    expect(open).not.toContain("<input");
  });
});
